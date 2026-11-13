#!/usr/bin/env node
// tests/routes-integration.test.mjs
//
// End-to-end test for the loopback HTTP routes registered by the host
// bundle. Spins up a real http.Server on a free port, mounts the
// bundle's makeRoutes() onto it, then issues real http.request() calls.
//
// The surface is deliberately small: status + Feishu login/logout. The
// GitHub user OAuth routes were removed; the broker owns the GitHub App
// identity, so the client only ever authenticates with Feishu.

import { pathToFileURL } from "node:url";
import path from "node:path";
import http from "node:http";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BUNDLE_DIST = path.join(ROOT, "lib", "index.js");
const MCP_DIST = path.join(ROOT, "mcp-server", "dist", "index.js");

if (!existsSync(BUNDLE_DIST) || !existsSync(MCP_DIST)) {
  console.error("Run `pnpm build` and `pnpm --filter mcp-server build` first.");
  process.exit(2);
}

const { apply, makeRoutes, API, resolveWorkingDir } = await import(
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
/*  Portability: the checkout path is derived, not shipped         */
/* ============================================================== */

console.log("\n--- workingDir resolution ---");
{
  const binding = { owner: "mmw-devs", name: "ffxiv-race-ops" };
  eq(
    resolveWorkingDir(undefined, binding, {}),
    path.join(homedir(), ".dsh", "workspaces", "mmw-devs", "ffxiv-race-ops"),
    "defaults under ~/.dsh/workspaces/<owner>/<name>"
  );
  eq(resolveWorkingDir("/tmp/pinned", binding, {}), "/tmp/pinned", "explicit config wins");
  eq(
    resolveWorkingDir(undefined, binding, { GHOST_WORKING_DIR: "/tmp/from-env" }),
    "/tmp/from-env",
    "GHOST_WORKING_DIR overrides the default"
  );
  eq(
    resolveWorkingDir("", binding, {}),
    path.join(homedir(), ".dsh", "workspaces", "mmw-devs", "ffxiv-race-ops"),
    "an empty string still means unset"
  );
}

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
  repoBinding: {
    owner: "mmw-devs", name: "ffxiv-race-ops", baseBranch: "main",
    branchPrefix: "content/", allowlistPaths: ["public/data.json"],
    denylistPaths: ["AGENTS.md"], preflight: { cmd: "true", timeoutSeconds: 60 },
  },
});

const emptyView = {
  mode: "none",
  login: "",
  accessTokenMasked: "",
  accessTokenExpiresAt: 0,
  tokenUpdatedAt: "",
};

// HTTP-behaviour tests stub the broker; no network and no session file.
const flow = {
  async view() {
    return { ...emptyView };
  },
  async phase() {
    return "signed_out";
  },
  async repoAccess() {
    return { state: "unavailable", reason: "尚未登录" };
  },
  async resolvedStatus() {
    return "no_token";
  },
  async refresh() {
    return { ok: false, message: "尚未登录，请先完成飞书登录。" };
  },
  async clearAll() {},
};

const feishu = {
  async view() {
    return {
      signedIn: false,
      authServiceUrl: "https://mmw-tools.mmw-team.icu",
      member: null,
      roles: [],
      expiresAt: 0,
      secondsRemaining: 0,
      tokenMasked: "",
    };
  },
  async begin() {
    return { loginId: "stub", loginUrl: "https://mmw-tools.mmw-team.icu/feishu/start?state=stub", expiresAt: Date.now() + 300_000 };
  },
  async poll() {
    return { status: "pending" };
  },
  async logout() {},
};

const routeDeps = {
  flow,
  feishu,
  brokerUrl: "https://race-ops-broker.mmw-team.icu",
  binding: {
    owner: "mmw-devs",
    name: "ffxiv-race-ops",
    baseBranch: "main",
    allowlistPaths: ["public/data.json"],
  },
};

const server = http.createServer(async (req, res) => {
  const addr = req.socket.remoteAddress;
  if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "loopback-only" }));
    return;
  }
  const m = makeRoutes(routeDeps);
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

function request(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}${opts.path}`,
      {
        method: opts.method || "GET",
        headers: opts.headers || {},
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
console.log("\n--- Test 1: GET /status ---");
{
  const r = await request({ method: "GET", path: API.status });
  eq(r.status, 200, "status code");
  const data = JSON.parse(r.body);

  eq(typeof data.phase, "string", "phase is a string");
  eq(data.phase, "signed_out", "phase is signed_out when no session");
  eq(data.mode, "none", "mode is none when signed out");
  eq(typeof data.session, "object", "session is an object");
  eq(data.session.login, "", "no login when signed out");
  eq(typeof data.session.secondsRemaining, "number", "secondsRemaining is numeric");
  eq(typeof data.repoAccess, "object", "repoAccess is an object");
  eq(data.repoAccess.state, "unavailable", "repoAccess is unavailable when signed out");
  eq(typeof data.brokerUrl, "string", "brokerUrl present");
  eq(typeof data.binding, "object", "binding present");
  eq(data.binding.owner, "mmw-devs", "binding owner");

  for (const gone of ["sessionPath", "configured", "accessTokenMasked", "accessTokenExpiresAt", "scope", "refreshTokenExpiresAt", "status"]) {
    eq(Object.prototype.hasOwnProperty.call(data, gone), false, `field '${gone}' is not in the payload`);
  }
  truthy(!r.body.includes("gho_") && !r.body.includes("ghs_"), "no token material in the payload");
}

console.log("\n--- Test 2: POST /status is method-rejected ---");
{
  const r = await request({ method: "POST", path: API.status, body: {} });
  eq(r.status, 405, "method not allowed");
  truthy(r.body === "" || /method not allowed/i.test(r.body), "body indicates method");
}

console.log("\n--- Test 3: Feishu status ---");
{
  const r = await request({ method: "GET", path: API.feishuStatus });
  eq(r.status, 200, "status code");
  const data = JSON.parse(r.body);
  eq(data.signedIn, false, "signedIn is false");
  eq(data.authServiceUrl, "https://mmw-tools.mmw-team.icu", "auth service surfaced");
}

console.log("\n--- Test 4: Feishu login start / poll / logout ---");
{
  const start = await request({ method: "POST", path: API.feishuLoginStart, body: {} });
  eq(start.status, 200, "start status");
  const started = JSON.parse(start.body);
  eq(started.ok, true, "start ok");
  truthy(started.loginUrl?.startsWith("https://mmw-tools.mmw-team.icu/"), "loginUrl returned");

  const poll = await request({ method: "POST", path: API.feishuLoginPoll, body: {} });
  eq(poll.status, 200, "poll status");
  const polled = JSON.parse(poll.body);
  eq(polled.status, "pending", "poll reports pending");

  const out = await request({ method: "POST", path: API.feishuLogout, body: {} });
  eq(out.status, 200, "logout status");
  eq(JSON.parse(out.body).ok, true, "logout ok");
}

console.log("\n--- Test 5: routes map shape ---");
{
  const routes = makeRoutes(routeDeps);
  eq(routes.length, 5, "5 routes defined");
  for (const r of routes) {
    eq(r.kind, "exact", `${r.path} is exact match`);
    truthy(typeof r.handler === "function", `${r.path} has handler`);
  }
  truthy(!routes.some((r) => r.path.includes("/oauth/")), "no OAuth routes remain");
}

server.close();
server.closeAllConnections?.();

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
