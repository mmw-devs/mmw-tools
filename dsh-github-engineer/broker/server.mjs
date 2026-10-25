/**
 * Broker HTTP layer.
 *
 * Thin on purpose: every decision lives in core.mjs. This file only
 * parses requests, applies a rate limit, and never lets a secret reach a
 * log line.
 *
 * Listens on 127.0.0.1 only — TLS and the public hostname belong to the
 * nginx instance that already serves this machine
 * (docs/AUTH-BROKER.md §9).
 *
 *   PORT=8787 BROKER_ENV_FILE=/opt/race-ops-broker/.env node broker/server.mjs
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { BrokerCore, BrokerRefused } from "./core.mjs";

const MAX_BODY_BYTES = 8 * 1024;
const SWEEP_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 60;

/* ---------------- config ---------------- */

function envOrDie(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") {
    console.error(`broker: missing required environment variable ${name}`);
    process.exit(2);
  }
  return String(v).trim();
}

function loadConfig() {
  return {
    appId: envOrDie("GITHUB_APP_ID"),
    installationId: envOrDie("GITHUB_APP_INSTALLATION_ID"),
    clientId: envOrDie("GITHUB_APP_CLIENT_ID"),
    clientSecret: envOrDie("GITHUB_APP_CLIENT_SECRET"),
    publicUrl: envOrDie("BROKER_PUBLIC_URL"),
    owner: envOrDie("REPO_OWNER"),
    repo: envOrDie("REPO_NAME"),
    org: process.env.BROKER_ORG ?? process.env.REPO_OWNER,
    allowMode: process.env.BROKER_ALLOW_MODE === "list" ? "list" : "org",
    allowList: (process.env.BROKER_ALLOWED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    denyList: (process.env.BROKER_DENIED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    privateKeyPem: readFileSync(envOrDie("GITHUB_APP_PRIVATE_KEY_PATH"), "utf8"),
  };
}

/* ---------------- logging ---------------- */

/** Only these keys are ever printed. Anything else is dropped. */
function log(event, fields = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    safe[k] = typeof v === "string" && v.length > 64 ? `${v.slice(0, 8)}…` : v;
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...safe }));
}

/* ---------------- rate limit ---------------- */

function makeLimiter() {
  const hits = new Map(); // ip -> { count, resetAt }
  return {
    allow(ip) {
      const now = Date.now();
      const entry = hits.get(ip);
      if (!entry || entry.resetAt <= now) {
        hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
        return true;
      }
      entry.count += 1;
      return entry.count <= RATE_MAX_PER_WINDOW;
    },
    sweep() {
      const now = Date.now();
      for (const [ip, e] of hits) if (e.resetAt <= now) hits.delete(ip);
    },
  };
}

/* ---------------- helpers ---------------- */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHtml(res, status, text) {
  const payload = `<!doctype html><meta charset="utf-8"><title>race-ops broker</title><body style="font-family:system-ui;padding:2rem;max-width:34rem"><p>${text}</p>`;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BrokerRefused("body-too-large", "request body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function bearer(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : "";
}

/* ---------------- server ---------------- */

export function createBrokerServer(core, opts = {}) {
  const limiter = opts.limiter ?? makeLimiter();
  const clientIp = opts.clientIp ?? ((req) => req.socket.remoteAddress ?? "unknown");

  const server = createServer(async (req, res) => {
    const ip = clientIp(req);
    if (!limiter.allow(ip)) {
      sendJson(res, 429, { error: "rate-limited", message: "too many requests" });
      return;
    }

    let url;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      sendJson(res, 400, { error: "bad-request", message: "unparseable URL" });
      return;
    }
    const pathname = url.pathname;

    try {
      /* --- health --- */
      if (pathname === "/health" && req.method === "GET") {
        sendJson(res, 200, {
          ok: true,
          appId: core.appId,
          repository: core.repository,
          allowMode: core.allowMode,
          org: core.org,
          ...core.stats(),
        });
        return;
      }

      /* --- step 1: start a login --- */
      if (pathname === "/session/start" && req.method === "POST") {
        const started = core.startSession();
        log("session_start", { state: started.state });
        sendJson(res, 200, started);
        return;
      }

      /* --- browser entry --- */
      if (pathname === "/auth/github/start" && req.method === "GET") {
        const state = url.searchParams.get("state") ?? "";
        const target = core.authorizeUrl(state);
        res.writeHead(302, { location: target, "cache-control": "no-store" });
        res.end();
        return;
      }

      /* --- browser callback --- */
      if (pathname === "/auth/github/callback" && req.method === "GET") {
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        if (url.searchParams.get("error")) {
          sendHtml(res, 400, "GitHub 返回了错误，授权未完成。可以关闭此页面并重试。");
          return;
        }
        try {
          const result = await core.completeLogin({ code, state });
          log("session_authorized", { state, login: result.login });
          sendHtml(res, 200, `已授权为 <b>${escapeHtml(result.login)}</b>。可以关闭此页面，回到 DSH 继续。`);
        } catch (err) {
          if (err instanceof BrokerRefused && err.code === "not-allowed") {
            log("session_denied", { state, reason: err.message });
            sendHtml(res, 403, "这个 GitHub 账号没有使用权限。请联系管理员。");
            return;
          }
          throw err;
        }
        return;
      }

      /* --- polling --- */
      const pollMatch = /^\/session\/([^/]+)$/.exec(pathname);
      if (pollMatch && req.method === "GET") {
        const state = decodeURIComponent(pollMatch[1]);
        const secret = url.searchParams.get("secret") ?? "";
        if (!secret) {
          sendJson(res, 400, { error: "secret-required", message: "poll secret is required" });
          return;
        }
        const polled = core.poll(state, secret);
        sendJson(res, 200, polled);
        return;
      }

      /* --- step 3: mint --- */
      if (pathname === "/installation-token" && req.method === "POST") {
        await readBody(req);
        const token = bearer(req);
        const issued = await core.issueInstallationToken(token);
        log("installation_token_issued", { repository: issued.repository });
        sendJson(res, 200, issued);
        return;
      }

      /* --- revoke --- */
      if (pathname === "/session/revoke" && req.method === "POST") {
        await readBody(req);
        const token = bearer(req);
        const out = core.revoke(token);
        log("session_revoked", { login: out.login, revoked: out.revoked });
        sendJson(res, 200, { ok: true, revoked: out.revoked });
        return;
      }

      sendJson(res, 404, { error: "not-found", message: "no such endpoint" });
    } catch (err) {
      if (err instanceof BrokerRefused) {
        log("refused", { path: pathname, code: err.code });
        sendJson(res, err.status ?? 403, { error: err.code, message: err.message });
        return;
      }
      // Unexpected: log the message only. It cannot contain a token by
      // construction — core never puts one in an error — and this is the
      // line that would otherwise be tempting to make verbose.
      log("error", { path: pathname, message: String(err?.message ?? err) });
      sendJson(res, 500, { error: "internal", message: "internal error" });
    }
  });

  const sweep = setInterval(() => {
    core.sweep();
    limiter.sweep();
  }, SWEEP_MS);
  sweep.unref?.();

  server.on("close", () => clearInterval(sweep));
  return server;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/* ---------------- entrypoint ---------------- */

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const config = loadConfig();
  const core = new BrokerCore(config);
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.BIND_HOST ?? "127.0.0.1";
  const server = createBrokerServer(core);
  server.listen(port, host, () => {
    log("listening", { host, port, repository: core.repository, allowMode: core.allowMode });
  });
  const shutdown = (signal) => {
    log("shutdown", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
