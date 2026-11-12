import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AppError } from "./auth.mjs";
import { FeishuError } from "./feishu.mjs";
import { PolicyError } from "./policy.mjs";
import { html, css, js } from "./ui.mjs";

const MAX_JSON_BODY_BYTES = 32 * 1024;
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function header(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function cookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function cookie(name, value, maxAgeSeconds, secure) {
  return (
    `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}` +
    (secure ? "; Secure" : "")
  );
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function errorPage(status, message) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>MMW Tools</title>
<body style="font-family:system-ui,sans-serif;padding:40px;line-height:1.7">
<h1>无法完成登录</h1><p>${escapeHtml(message)}</p><p><a href="/">返回</a></p></body></html>`;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bearer(req) {
  const value = header(req, "authorization");
  if (typeof value !== "string" || !value.startsWith("Bearer ")) {
    throw new AppError(401, "mmw_auth_required", "缺少 Bearer token");
  }
  return value.slice("Bearer ".length).trim();
}

async function readJson(req) {
  const type = header(req, "content-type");
  if (typeof type !== "string" || !type.startsWith("application/json")) {
    throw new AppError(415, "mmw_json_required", "请使用 application/json");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) throw new AppError(413, "mmw_body_too_large", "请求过大");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value;
  } catch {
    throw new AppError(400, "mmw_json_invalid", "请求内容不是有效 JSON 对象");
  }
}

function requireCsrf(req, session, config) {
  if (header(req, "origin") !== config.origin) {
    throw new AppError(403, "mmw_csrf", "请求来源校验失败，请刷新页面");
  }
  const token = header(req, "x-csrf-token");
  if (typeof token !== "string" || !safeEqual(token, session.csrf)) {
    throw new AppError(403, "mmw_csrf", "请求校验失败，请刷新页面");
  }
}

/**
 * Loopback HTTP server. The public face is nginx; this process only listens on
 * 127.0.0.1 and never sees the Feishu app secret from a client.
 */
export function createAuthServer({ auth, config }) {
  const loginRates = new Map();

  const rateLimit = (req) => {
    const forwarded = header(req, "x-forwarded-for");
    const socketAddress = req.socket.remoteAddress ?? "unknown";
    const proxy = socketAddress === "127.0.0.1" || socketAddress === "::1" || socketAddress === "::ffff:127.0.0.1";
    const key = proxy && typeof forwarded === "string" && forwarded.length > 0
      ? forwarded.split(",")[0].trim()
      : socketAddress;
    const now = Date.now();
    for (const [address, entry] of loginRates) {
      if (now - entry.at > 60_000) loginRates.delete(address);
    }
    const entry = loginRates.get(key) ?? { at: now, count: 0 };
    entry.count += 1;
    loginRates.set(key, entry);
    if (entry.count > 60) {
      throw new AppError(429, "mmw_rate_limited", "登录请求过多，请稍后再试");
    }
  };

  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", CSP);

    const url = new URL(req.url ?? "/", config.origin);
    const pathname = url.pathname;

    try {
      if (req.method === "GET" && pathname === "/") {
        return sendText(res, 200, html, "text/html; charset=utf-8");
      }
      if (req.method === "GET" && pathname === "/style.css") {
        return sendText(res, 200, css, "text/css; charset=utf-8");
      }
      if (req.method === "GET" && pathname === "/app.js") {
        return sendText(res, 200, js, "text/javascript; charset=utf-8");
      }
      if (req.method === "GET" && pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          contractVersion: 2,
          catalogRevision: auth.policy.catalogRevision,
        });
      }

      if (pathname === "/auth/feishu/start" && req.method === "GET") {
        rateLimit(req);
        const login = url.searchParams.get("login");
        let browser;
        if (login) {
          browser = auth.beginBrowser(login);
        } else {
          const bootstrap = url.searchParams.get("bootstrap");
          if (bootstrap && !auth.checkBootstrapToken(bootstrap)) {
            throw new AppError(403, "mmw_bootstrap_invalid", "bootstrap token 无效或已使用");
          }
          browser = auth.startBrowserSession({ bootstrap: Boolean(bootstrap) });
        }
        res.setHeader(
          "Set-Cookie",
          cookie("mmw_oauth", browser.browserSecret, config.oauthTtlSeconds, config.cookieSecure)
        );
        res.writeHead(302, { location: browser.authorizeUrl });
        return res.end();
      }

      if (pathname === "/auth/feishu/callback" && req.method === "GET") {
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        try {
          const result = await auth.completeLogin({
            state,
            browserSecret: cookies(req).mmw_oauth,
            code,
          });
          const clearOauth = cookie("mmw_oauth", "", 0, config.cookieSecure);
          if (result.mode === "browser") {
            res.setHeader("Set-Cookie", [
              clearOauth,
              cookie("mmw_session", result.session.token, config.sessionTtlSeconds, config.cookieSecure),
            ]);
            res.writeHead(303, { location: "/" });
            return res.end();
          }
          res.setHeader("Set-Cookie", clearOauth);
          return sendText(
            res,
            200,
            `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>MMW Tools</title>
<body style="font-family:system-ui,sans-serif;padding:40px;line-height:1.7">
<h1>已授权</h1><p>可以关闭此页面，回到 DSH 继续。</p></body></html>`,
            "text/html; charset=utf-8"
          );
        } catch (error) {
          const status = error instanceof AppError ? error.status : 500;
          const message = error instanceof AppError ? error.message : "登录处理失败，请重新发起";
          return sendText(res, status, errorPage(status, message), "text/html; charset=utf-8");
        }
      }

      if (pathname === "/v1/login/start" && req.method === "POST") {
        rateLimit(req);
        const started = auth.startLogin({ mode: "plugin" });
        return sendJson(res, 200, started);
      }

      const poll = /^\/v1\/login\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
      if (poll && req.method === "GET") {
        const result = auth.pollLogin(poll[1], url.searchParams.get("secret") ?? "");
        return sendJson(res, 200, result);
      }

      if (pathname === "/v1/me" && req.method === "GET") {
        const member = auth.verifyPluginToken(bearer(req));
        return sendJson(res, 200, auth.me(member));
      }

      if (pathname === "/v1/session/refresh" && req.method === "POST") {
        return sendJson(res, 200, auth.refreshPluginToken(bearer(req)));
      }

      if (pathname === "/v1/session/logout" && req.method === "POST") {
        auth.logoutPluginToken(bearer(req));
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === "/v1/agent/routes" && req.method === "GET") {
        const member = auth.verifyPluginToken(bearer(req));
        return sendJson(res, 200, auth.routes(member));
      }

      if (pathname === "/v1/agent/repos" && req.method === "GET") {
        auth.verifyPluginToken(bearer(req));
        return sendJson(res, 200, auth.agentRepos());
      }

      if (pathname === "/v1/agent/events" && req.method === "POST") {
        const member = auth.verifyPluginToken(bearer(req));
        const body = await readJson(req);
        return sendJson(res, 200, auth.recordEvents(member, body.events));
      }

      if (pathname === "/api/me" && req.method === "GET") {
        const current = auth.session(cookies(req).mmw_session);
        if (!current) throw new AppError(401, "mmw_auth_required", "请先登录");
        return sendJson(res, 200, {
          member: auth.memberView(current.member),
          csrf: current.session.csrf,
          isAdmin: auth.policy.isAdmin(current.member),
        });
      }

      if (pathname === "/api/logout" && req.method === "POST") {
        const current = auth.session(cookies(req).mmw_session);
        if (!current) throw new AppError(401, "mmw_auth_required", "请先登录");
        requireCsrf(req, current.session, config);
        auth.logoutSession(cookies(req).mmw_session);
        res.setHeader("Set-Cookie", cookie("mmw_session", "", 0, config.cookieSecure));
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === "/api/admin/roles" && req.method === "GET") {
        const current = auth.session(cookies(req).mmw_session);
        if (!current) throw new AppError(401, "mmw_auth_required", "请先登录");
        return sendJson(res, 200, auth.listRoles(current.member));
      }

      if (pathname === "/api/admin/members" && req.method === "GET") {
        const current = auth.session(cookies(req).mmw_session);
        if (!current) throw new AppError(401, "mmw_auth_required", "请先登录");
        return sendJson(res, 200, auth.listMembers(current.member));
      }

      if (pathname === "/api/admin/repos" && req.method === "GET") {
        const current = auth.session(cookies(req).mmw_session);
        if (!current) throw new AppError(401, "mmw_auth_required", "请先登录");
        return sendJson(res, 200, auth.listRepos(current.member));
      }

      if (pathname === "/api/admin/repos" && req.method === "PUT") {
        const current = auth.session(cookies(req).mmw_session);
        if (!current) throw new AppError(401, "mmw_auth_required", "请先登录");
        requireCsrf(req, current.session, config);
        return sendJson(res, 200, auth.upsertRepo(current.member, await readJson(req)));
      }

      const memberPath = /^\/api\/admin\/members\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
      if (memberPath && req.method === "PATCH") {
        const current = auth.session(cookies(req).mmw_session);
        if (!current) throw new AppError(401, "mmw_auth_required", "请先登录");
        requireCsrf(req, current.session, config);
        return sendJson(
          res,
          200,
          auth.updateMember(current.member, memberPath[1], await readJson(req))
        );
      }

      if (pathname === "/api/admin/audit" && req.method === "GET") {
        const current = auth.session(cookies(req).mmw_session);
        if (!current) throw new AppError(401, "mmw_auth_required", "请先登录");
        return sendJson(res, 200, auth.listAudit(current.member, 100));
      }

      throw new AppError(404, "mmw_not_found", "接口不存在");
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof AppError) {
        return sendJson(res, error.status, { error: error.code, message: error.message });
      }
      if (error instanceof FeishuError) {
        return sendJson(res, error.status, { error: "mmw_feishu_unavailable", message: error.message });
      }
      if (error instanceof PolicyError) {
        return sendJson(res, 500, { error: "mmw_contract_invalid", message: "功能契约无效" });
      }
      console.error("mmw-tools-auth: unhandled request error", error);
      return sendJson(res, 500, { error: "mmw_internal", message: "服务处理失败" });
    }
  });

  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  return server;
}
