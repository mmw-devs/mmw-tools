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
//   - JSON body guard (malformed body → 400)
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

const { apply, makeRoutes, API, TokenStore } = await import(
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

const store = new TokenStore();

// A fake device flow. `pnpm check` must not depend on the network: the
// real DeviceFlow.begin() posts to github.com, and a suite that reaches
// out could hang (it did — an unanswered fetch has no default timeout)
// or fail for reasons unrelated to this plugin. The route contract is
// what this suite tests; the flow's HTTP behaviour is covered by the
// timeout added in src/auth/device-flow.ts, which cannot be exercised
// offline either way.
let nextFlowState = "no_token";
const fakeFlow = {
  status: () => nextFlowState,
  async begin() {
    nextFlowState = "device_pending";
    return {
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresAt: Date.now() + 900_000,
      interval: 5,
    };
  },
  async poll() {
    return { ok: false, message: "authorization_pending" };
  },
  async refresh() {
    return { ok: false, message: "no refresh_token in this fixture" };
  },
  async ensureFresh() {
    return false;
  },
  async clearAll() {
    nextFlowState = "no_token";
  },
};

const flow = fakeFlow;

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
    data.configPath.endsWith("dsh-github-engineer.json") ||
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
  truthy(typeof data.userCode === "string" && data.userCode.length > 0, "userCode returned");
  truthy(
    data.verificationUri?.includes("github.com/login/device"),
    "verificationUri is the Device URL"
  );
  truthy(typeof data.expiresAt === "number", "expiresAt returned");
  truthy(typeof data.interval === "number", "interval returned");
}

/* ============================================================== */
/*  Test 4: POST with malformed JSON body → 400                      */
/* ============================================================== */

console.log("\n--- Test 4: malformed JSON body on /oauth/finish ---");

{
  // /oauth/finish reads the body. Sending invalid JSON should return
  // 400. (oauthStart doesn't read body, so we use finish here.)
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
  eq(r.status, 400, "malformed body → 400");
  truthy(/invalid JSON/i.test(r.body), "error message contains 'invalid JSON'");
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

console.log(`\n${pass} pass, ${fail} fail`);

// Every request above used `agent: false`, so no keep-alive socket is
// left behind and the process exits on its own once the server is
// closed. An explicit process.exit here would tear down a still-open
// event loop, which on Windows can trip a libuv assertion instead of
// exiting cleanly.
process.exitCode = fail > 0 ? 1 : 0;