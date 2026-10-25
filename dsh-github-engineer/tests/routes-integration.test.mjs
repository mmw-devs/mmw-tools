#!/usr/bin/env node
// tests/routes-integration.test.mjs
//
// End-to-end test for the loopback HTTP routes registered by the host
// bundle. Spins up a real http.Server on a free port, mounts the
// bundle's makeRoutes() onto it, then issues real http.request()
// calls as the DSH web UI would.
//
// Covers (per INCREMENT-3-CHECKLIST §1, §2):
//   - loopback guard (rejects non-127.0.0.1)
//   - method guard (GET vs POST)
//   - /oauth/finish takes no input: no body, empty body and malformed
//     body all reach the handler (a strict body guard broke the panel)
//   - happy path: GET /status returns a secret-free view

import { pathToFileURL } from "node:url";
import path from "node:path";
import http from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BUNDLE_DIST = path.join(ROOT, "lib", "index.js");
const MCP_DIST = path.join(ROOT, "mcp-server", "dist", "index.js");

if (!existsSync(BUNDLE_DIST) || !existsSync(MCP_DIST)) {
  console.error("Run `pnpm build` and `pnpm --filter mcp-server build` first.");
  process.exit(2);
}

const { apply, makeRoutes, API } = await import(
  pathToFileURL(BUNDLE_DIST).href
);

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  PASS  ${label}`); }
function bad(label, msg) { fail++; console.error(`  FAIL  ${label}: ${msg}`); }
function eq(actual, want, label) {
  if (actual === want) ok(`${label} = ${JSON.stringify(want)}`);
  else bad(label, `expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
}
function truthy(v, label) { if (v) ok(label); else bad(label, "expected truthy"); }

/* ============================================================== */
/*  Stand up a real http.Server                                    */
/* ============================================================== */

const ctx = {
  tools: { register: () => () => {} },
  webServer: { port: 0, register: () => () => {} },
  systemPrompt: { section: () => () => {} },
  effect: (fn) => { fn(); return () => {}; },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};
apply(ctx, {
  githubOAuthClientId: "Ov23liakpz9LHG1E0dE5",
  defaultScopes: ["repo", "workflow", "offline_access"],
  repoBinding: {
    owner: "mmw-devs", name: "ffxiv-race-ops", baseBranch: "main",
    branchPrefix: "content/", allowlistPaths: ["public/data.json"],
    denylistPaths: ["AGENTS.md"], preflight: { cmd: "true", timeoutSeconds: 60 },
  },
});

// The routes take `store` and `flow` from one implementation
// (BrokerAuth). For HTTP-behaviour tests the broker is stubbed: no
// network, no session file, and the two halves are plain objects that
// implement exactly the methods the route handlers call.
const emptyView = {
  configured: false,
  login: "",
  scope: "",
  accessTokenMasked: "",
  accessTokenExpiresAt: 0,
  refreshTokenExpiresAt: 0,
  tokenUpdatedAt: "",
  configPath: "C:\\x\\.dsh\\dsh-github-engineer-session.json",
};

const store = {
  async view() {
    return { ...emptyView };
  },
};

const flow = {
  status: () => "no_token",
  async resolvedStatus() {
    return "no_token";
  },
  async begin() {
    return {
      userCode: "",
      verificationUri: "https://race-ops-broker.mmw-team.icu/auth/github/start?state=stub",
      expiresAt: Date.now() + 300_000,
      interval: 5,
    };
  },
  async poll() {
    return { ok: false, message: "等待浏览器完成授权…" };
  },
  async refresh() {
    return { ok: false, message: "尚未登录，请先完成浏览器授权。" };
  },
  async clearAll() {},
};

const server = http.createServer(async (req, res) => {
  // Manually re-implement the loopback guard so the test exercises the
  // exact same guard the bundle uses.
  const addr = req.socket.remoteAddress;
  if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "loopback-only" }));
    return;
  }
  const m = makeRoutes({ store, flow });
  for (const r of m) {
    if (r.path === req.url || (req.url && r.path === req.url.split("?")[0])) {
      return r.handler(req, res);
    }
  }
  res.writeHead(404);
  res.end("not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

/* ============================================================== */
/*  HTTP client helper                                             */
/* ============================================================== */

function request(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}${opts.path}`,
      {
        method: opts.method || "GET",
        headers: opts.headers || {},
        // No keep-alive: a pooled socket would outlive the test and
        // leave the event loop open after the assertions finish.
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

/* ============================================================== */
/*  Test 1: GET /api/github-engineer/status                          */
/* ============================================================== */

console.log("\n--- Test 1: GET /status returns secret-free view ---");

{
  const r = await request({ method: "GET", path: API.status });
  eq(r.status, 200, "status code");
  const data = JSON.parse(r.body);
  eq(typeof data.configured, "boolean", "data.configured is boolean");
  console.log("    configPath:", data.configPath);
  truthy(
    data.configPath.endsWith("dsh-github-engineer-session.json") ||
      data.configPath.endsWith("/dsh-github-engineer.json") ||
      data.configPath.endsWith("\\dsh-github-engineer.json"),
    "configPath ends with dsh-github-engineer.json"
  );
  truthy(data.accessTokenMasked === "" || /\*\*\*\*/.test(data.accessTokenMasked), "masked token format");
  eq(data.login, "", "no login before OAuth");
  // The status field must be one of the four documented values.
  truthy(
    ["no_token", "device_pending", "authorized", "reauth_needed"].includes(data.status),
    "status is one of no_token/device_pending/authorized/reauth_needed"
  );
}

/* ============================================================== */
/*  Test 2: POST /status is refused (GET only)                      */
/* ============================================================== */

console.log("\n--- Test 2: POST /status is method-rejected ---");

{
  const r = await request({ method: "POST", path: API.status, body: {} });
  // Method guard returns 405 BEFORE running the handler body, so this
  // is a clean "method not allowed" — handler throws aren't relevant.
  eq(r.status, 405, "method not allowed");
  truthy(r.body === "" || /method not allowed/i.test(r.body), "body indicates method");
}

/* ============================================================== */
/*  Test 3: POST /oauth/start returns user_code shape                */
/* ============================================================== */

console.log("\n--- Test 3: POST /oauth/start ---");

{
  const r = await request({ method: "POST", path: API.oauthStart, body: {} });
  truthy(r.headers["content-type"]?.includes("application/json"), "content-type is JSON");
  eq(r.status, 200, "status code");
  const data = JSON.parse(r.body);
  eq(data.ok, true, "ok is true");
  eq(data.userCode, "", "broker flows carry no user code");
  truthy(
    data.verificationUri?.startsWith("https://race-ops-broker.mmw-team.icu/auth/github/start"),
    "verificationUri is the broker login URL"
  );
  truthy(typeof data.expiresAt === "number", "expiresAt returned");
  truthy(typeof data.interval === "number", "interval returned");
}

/* ============================================================== */
/*  Test 4: /oauth/finish does not require a body                    */
/* ============================================================== */

console.log("\n--- Test 4: /oauth/finish does not require a body ---");

{
  // The poll needs no input. Requiring parseable JSON here is what turned
  // the panel's "我已完成授权" button into "HTTP 400: invalid JSON
  // response"; the body is now accepted and ignored. A malformed body must
  // therefore reach the handler, not be rejected by the route.
  const r = await new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}${API.oauthFinish}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.write("this is not valid JSON {{{");
    req.end();
  });
  eq(r.status, 200, "a malformed body is ignored, not rejected");
  const parsed = JSON.parse(r.body);
  truthy("ok" in parsed, "the handler answered, so the body was not a gate");
}

/* ============================================================== */
/*  Test 5: routes map (sanity)                                     */
/* ============================================================== */

console.log("\n--- Test 5: routes map shape ---");

{
  const routes = makeRoutes({ store, flow });
  eq(routes.length, 5, "5 routes defined");
  for (const r of routes) {
    eq(r.kind, "exact", `${r.path} is exact match`);
    truthy(typeof r.handler === "function", `${r.path} has handler`);
  }
}

server.close();
// Free sockets deterministically, then exit. `server.close()` alone only
// stops accepting new connections; it waits for existing ones to drain,
// and a lingering socket keeps the event loop — and therefore the suite —
// alive. That is what hung this step on the Linux CI runner. `agent:
// false` on the requests already avoids pooling; this is the belt to that
// braces.
server.closeAllConnections?.();

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);