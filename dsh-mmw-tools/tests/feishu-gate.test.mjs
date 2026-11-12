#!/usr/bin/env node
// Tests for the Feishu client, the call-time policy gate, and the operation map.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FeishuAuth, FeishuAuthError } from "../lib/auth/feishu-auth.js";
import { PolicyGate, installToolGate } from "../lib/gate/gate.js";
import { TOOL_MAP, isMmwTool } from "../lib/gate/tool-map.js";
import { currentRunId } from "../lib/util/run-context.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

let pass = 0;
let fail = 0;
function ok(label) {
  pass += 1;
  console.log(`  PASS  ${label}`);
}
function bad(label, message) {
  fail += 1;
  console.error(`  FAIL  ${label}: ${message}`);
}
function eq(actual, expected, label) {
  if (actual === expected) ok(label);
  else bad(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function truthy(value, label) {
  if (value) ok(label);
  else bad(label, "expected truthy");
}

const dir = mkdtempSync(path.join(tmpdir(), "mmw-feishu-test-"));
const tokenFile = path.join(dir, "feishu.json");
const calls = [];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchImpl = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  const target = String(url);
  if (target.endsWith("/v1/login/start")) {
    return json({
      loginId: "login-1",
      pollSecret: "poll-1",
      loginUrl: "https://auth.example/auth/feishu/start?login=login-1",
      expiresAt: Date.now() + 300_000,
    });
  }
  if (target.includes("/v1/login/login-1")) {
    return json({
      status: "authorized",
      pluginToken: "plugin-token-1",
      expiresAt: Date.now() + 3_600_000,
      member: { id: "m1", name: "Alice", roles: ["operator"], isAdmin: false },
      roles: ["operator"],
      isAdmin: false,
      policyRevision: 7,
    });
  }
  if (target.endsWith("/v1/agent/routes")) {
    return json({
      contractVersion: 2,
      catalogRevision: "sha256:" + "a".repeat(64),
      policyRevision: 7,
      ttlSeconds: 60,
      allowed: ["mmw-tools-status", "race-ops"],
      allowedOperations: [
        "mmw-tools-status.status",
        "race-ops.repo_read",
        "race-ops.pr_close",
        "race-ops.pr_merge",
      ],
      denied: [],
    });
  }
  if (target.endsWith("/v1/session/refresh")) {
    return json({
      pluginToken: "plugin-token-2",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
  }
  if (target.endsWith("/v1/session/logout")) return json({ ok: true });
  throw new Error(`unexpected fetch ${target}`);
};

try {
  const auth = new FeishuAuth({
    authServiceUrl: "https://auth.example",
    file: tokenFile,
    fetchImpl,
  });

  const before = await auth.view();
  eq(before.signedIn, false, "view starts signed out");

  const started = await auth.begin();
  eq(started.loginId, "login-1", "begin returns loginId");
  truthy(started.loginUrl.startsWith("https://auth.example/"), "begin returns loginUrl");

  const polled = await auth.poll();
  eq(polled.status, "authorized", "poll authorizes");
  const after = await auth.view();
  eq(after.signedIn, true, "view signs in after poll");
  eq(after.member.name, "Alice", "member name persisted");
  truthy(readFileSync(tokenFile, "utf8").includes("plugin-token-1"), "token file written");

  const routes = await auth.routes();
  eq(routes.policyRevision, 7, "routes policyRevision");
  eq(routes.allowed.includes("race-ops"), true, "routes includes race-ops");
  const callsBeforeCache = calls.length;
  await auth.routes();
  eq(calls.length, callsBeforeCache, "routes cache avoids a second fetch");

  const refreshed = await auth.refreshIfNeeded();
  eq(refreshed, true, "token inside the refresh window is refreshed");
  truthy(readFileSync(tokenFile, "utf8").includes("plugin-token-2"), "refresh rotates the token file");
  eq((await auth.view()).signedIn, true, "refreshed token stays signed in");
  const callsBeforeNoop = calls.length;
  eq(await auth.refreshIfNeeded(), false, "fresh token does not refresh again");
  eq(calls.length, callsBeforeNoop, "no request when refresh is unnecessary");

  const gate = new PolicyGate({ auth, enabled: true });
  eq((await gate.check("mmw_tools_status")).ok, true, "always-on status is allowed");
  eq((await gate.check("mcp__mmw-tools__repo_read")).ok, true, "race-ops operation allowed for operator");
  eq((await gate.check("mcp__mmw-tools__pr_close")).ok, true, "pr_close allowed by policy; host confirmation is separate");
  eq((await gate.check("mcp__mmw-tools__pr_merge")).ok, true, "pr_merge allowed by policy; host confirmation is separate");
  eq((await gate.check("mcp__mmw-tools__unknown")).ok, false, "unknown tool is denied");
  truthy(
    (await gate.check("mcp__mmw-tools__unknown")).reason.startsWith("[mmw_contract_mismatch]"),
    "unknown own tool carries the contract-mismatch prefix"
  );

  await auth.logout();
  eq((await auth.view()).signedIn, false, "logout clears the token");
  eq(await auth.refreshIfNeeded(), false, "signed-out refresh is a no-op");

  // Contract drift: every publicName in tools.json must have exactly one map entry.
  const toolsDoc = JSON.parse(readFileSync(path.join(ROOT, "contracts", "tools.json"), "utf8"));
  const expected = [];
  for (const tool of toolsDoc.tools) {
    for (const operation of tool.operations) expected.push(operation.publicName);
  }
  eq(Object.keys(TOOL_MAP).length, expected.length, "TOOL_MAP covers every operation");
  for (const name of expected) truthy(Boolean(TOOL_MAP[name]), `TOOL_MAP has ${name}`);
} catch (error) {
  bad("feishu auth suite", error.stack || String(error));
}

// Gate decisions with a minimal fake route table.
{
  const fake = {
    routes: async () => ({
      contractVersion: 2,
      catalogRevision: "sha256:" + "a".repeat(64),
      policyRevision: 1,
      ttlSeconds: 60,
      allowed: ["mmw-tools-status"],
      allowedOperations: ["mmw-tools-status.status"],
      denied: [{ toolId: "race-ops", requiredRoles: ["operator", "admin"] }],
    }),
  };
  const gate = new PolicyGate({ auth: fake, enabled: true });
  const denied = await gate.check("mcp__mmw-tools__repo_read");
  eq(denied.ok, false, "viewer is denied race-ops");
  truthy(denied.reason.startsWith("[mmw_route_denied]"), "role denial carries the route-denied prefix");
  truthy(denied.reason.includes("operator"), "denial names required roles");
  eq((await gate.check("mmw_tools_status")).ok, true, "status bypasses the role gate");
}

// v2 allowedOperations is authoritative: a denied operation cannot ride on
// the parent tool being allowed (the model B seam).
{
  const fake = {
    routes: async () => ({
      contractVersion: 2,
      catalogRevision: "sha256:" + "a".repeat(64),
      policyRevision: 1,
      ttlSeconds: 60,
      allowed: ["race-ops"],
      allowedOperations: ["race-ops.repo_read"],
      denied: [],
    }),
  };
  const gate = new PolicyGate({ auth: fake, enabled: true });
  eq((await gate.check("mcp__mmw-tools__repo_read")).ok, true, "allowed operation passes");
  eq((await gate.check("mcp__mmw-tools__pr_merge")).ok, false, "operation absent from allowedOperations is denied");
}

// Contract v1 had only tool-level allowed; keep the compatibility fallback.
{
  const fake = {
    routes: async () => ({
      contractVersion: 1,
      catalogRevision: "sha256:" + "a".repeat(64),
      policyRevision: 1,
      ttlSeconds: 60,
      allowed: ["race-ops"],
      allowedOperations: [],
      denied: [],
    }),
  };
  const gate = new PolicyGate({ auth: fake, enabled: true });
  eq((await gate.check("mcp__mmw-tools__pr_merge")).ok, true, "v1 tool-level fallback still works");
}

// A write must ask the client for a table no older than 15s; a read may use the
// normal ttl. This is the policy half of "a revoked writer loses access fast".
{
  const seen = [];
  const table = {
    contractVersion: 2,
    catalogRevision: "sha256:" + "a".repeat(64),
    policyRevision: 1,
    ttlSeconds: 60,
    allowed: ["race-ops"],
    allowedOperations: ["race-ops.repo_read", "race-ops.repo_edit", "race-ops.pr_merge"],
    denied: [],
  };
  const fake = {
    routes: async (_force, maxAgeMs) => {
      seen.push(maxAgeMs);
      return table;
    },
  };
  const gate = new PolicyGate({ auth: fake, enabled: true });
  eq((await gate.check("mcp__mmw-tools__repo_read")).ok, true, "read allowed");
  eq((await gate.check("mcp__mmw-tools__repo_edit")).ok, true, "write allowed");
  eq(seen[0], undefined, "read uses the normal 60s ttl");
  eq(seen[1], 15_000, "write caps table age at 15s");
}

// Fail closed: no usable table means no governed call, read or write.
{
  const fake = {
    routes: async () => {
      throw new FeishuAuthError("network", "auth core unreachable");
    },
  };
  const gate = new PolicyGate({ auth: fake, enabled: true });
  for (const name of ["mcp__mmw-tools__repo_read", "mcp__mmw-tools__repo_edit", "mcp__mmw-tools__pr_merge"]) {
    const decision = await gate.check(name);
    eq(decision.ok, false, `no route table denies ${name}`);
    truthy(decision.reason.includes("飞书授权不可用"), `denial explains the outage for ${name}`);
    truthy(
      decision.reason.startsWith("[mmw_policy_unavailable]"),
      `outage denial carries the policy-unavailable prefix for ${name}`
    );
  }
}

// The refusal prefix tells the agent which layer failed: local token, server
// session, or the policy fetch. The Chinese explanation stays for the human.
{
  const cases = [
    ["auth-required", "[mmw_auth_required]"],
    ["mmw_auth_required", "[mmw_auth_required]"],
    ["mmw_session_expired", "[mmw_session_expired]"],
    ["network", "[mmw_policy_unavailable]"],
    ["http-500", "[mmw_policy_unavailable]"],
    ["invalid-response", "[mmw_policy_unavailable]"],
  ];
  for (const [code, prefix] of cases) {
    const gate = new PolicyGate({
      auth: {
        routes: async () => {
          throw new FeishuAuthError(code, `stub failure ${code}`);
        },
      },
      enabled: true,
    });
    const decision = await gate.check("mcp__mmw-tools__repo_read");
    eq(decision.ok, false, `stub ${code} denies`);
    truthy(decision.reason.startsWith(prefix), `stub ${code} maps to ${prefix}`);
  }
}

// Revocation and cache freshness, end to end through FeishuAuth:
// - a read may use a table up to 60s old;
// - a write must refetch after 15s and then sees the revoked operation;
// - a fetch failure after that denies instead of falling back to the old table.
{
  const authDir = mkdtempSync(path.join(tmpdir(), "mmw-routes-test-"));
  const authFile = path.join(authDir, "feishu.json");
  let now = 1_000_000;
  let mode = "allowed";
  let routeFetches = 0;
  const allowed = {
    contractVersion: 2,
    catalogRevision: "sha256:" + "a".repeat(64),
    policyRevision: 7,
    ttlSeconds: 60,
    allowed: ["mmw-tools-status", "race-ops"],
    allowedOperations: ["mmw-tools-status.status", "race-ops.repo_read", "race-ops.repo_edit"],
    denied: [],
  };
  const revoked = {
    ...allowed,
    policyRevision: 8,
    allowed: ["mmw-tools-status"],
    allowedOperations: ["mmw-tools-status.status"],
    denied: [{ toolId: "race-ops", requiredRoles: ["operator", "admin"] }],
  };

  writeFileSync(
    authFile,
    JSON.stringify({
      authServiceUrl: "https://auth.example",
      pluginToken: "plugin-token-1",
      expiresAt: 100_000_000,
      member: { id: "m1", name: "Alice", roles: ["operator"], isAdmin: false },
      roles: ["operator"],
      savedAt: now,
    })
  );

  const auth = new FeishuAuth({
    authServiceUrl: "https://auth.example",
    file: authFile,
    now: () => now,
    fetchImpl: async (url) => {
      if (!String(url).endsWith("/v1/agent/routes")) throw new Error(`unexpected fetch ${url}`);
      routeFetches += 1;
      if (mode === "error") throw new Error("auth core down");
      return json(mode === "allowed" ? allowed : revoked);
    },
  });
  const gate = new PolicyGate({ auth, enabled: true });

  eq((await gate.check("mcp__mmw-tools__repo_read")).ok, true, "operator can read before revocation");
  const fetchesAfterRead = routeFetches;
  now += 30_000;
  eq((await gate.check("mcp__mmw-tools__repo_read")).ok, true, "read may use a table younger than 60s");
  eq(routeFetches, fetchesAfterRead, "read does not refetch inside the ttl");

  now += 31_000; // 61s old, past the 15s write limit
  mode = "revoked";
  const afterRevoke = await gate.check("mcp__mmw-tools__repo_edit");
  eq(afterRevoke.ok, false, "write sees the revoked operation after 15s");
  truthy(afterRevoke.reason.startsWith("[mmw_route_denied]"), "revocation carries the route-denied prefix");
  truthy(afterRevoke.reason.includes("operator"), "revocation denial names the required role");
  eq(routeFetches, fetchesAfterRead + 1, "write refetched the table");

  now += 61_000;
  mode = "error";
  const duringOutage = await gate.check("mcp__mmw-tools__pr_merge");
  eq(duringOutage.ok, false, "a failed refetch denies instead of reusing the revoked table");
  truthy(duringOutage.reason.includes("飞书授权不可用"), "outage denial is explicit");

  rmSync(authDir, { recursive: true, force: true });
}

// A lower policyRevision is stale; it must not overwrite a newer cached table.
// The auth core increments this value, so a lower one means a rollback/replay,
// not a new policy.
{
  const authDir = mkdtempSync(path.join(tmpdir(), "mmw-revision-test-"));
  const authFile = path.join(authDir, "feishu.json");
  let now = 1_000_000;
  let routeFetches = 0;
  writeFileSync(
    authFile,
    JSON.stringify({
      authServiceUrl: "https://auth.example",
      pluginToken: "plugin-token-1",
      expiresAt: 100_000_000,
      member: { id: "m1", name: "Alice", roles: ["operator"], isAdmin: false },
      roles: ["operator"],
      savedAt: now,
    })
  );
  const base = {
    contractVersion: 2,
    catalogRevision: "sha256:" + "a".repeat(64),
    ttlSeconds: 60,
    allowed: ["mmw-tools-status", "race-ops"],
    denied: [],
  };
  const auth = new FeishuAuth({
    authServiceUrl: "https://auth.example",
    file: authFile,
    now: () => now,
    fetchImpl: async () => {
      routeFetches += 1;
      if (routeFetches === 1) {
        return json({ ...base, policyRevision: 7, allowedOperations: ["race-ops.repo_edit"] });
      }
      return json({ ...base, policyRevision: 6, allowedOperations: [] });
    },
  });
  const gate = new PolicyGate({ auth, enabled: true });
  eq((await gate.check("mcp__mmw-tools__repo_edit")).ok, true, "revision 7 allows the write");
  now += 61_000;
  eq((await gate.check("mcp__mmw-tools__repo_edit")).ok, true, "revision 6 does not revoke a cached revision 7");
  eq(routeFetches, 2, "the stale table was seen but not adopted");

  rmSync(authDir, { recursive: true, force: true });
}


{
  let listener;
  const ctx = {
    on(event, fn) {
      if (event === "tools/pre-execute") listener = fn;
      return () => {};
    },
  };
  const denyGate = { check: async () => ({ ok: false, reason: "no role" }) };
  installToolGate(ctx, { gate: denyGate, logger: { warn: () => {} } });
  const denied = await listener({ name: "mcp__mmw-tools__pr_merge" }, async () => "next");
  eq(denied.kind, "deny", "policy denial happens before the merge prompt");

  let allowListener;
  const ctx2 = {
    on(event, fn) {
      if (event === "tools/pre-execute") allowListener = fn;
      return () => {};
    },
  };
  const allowGate = { check: async () => ({ ok: true }) };
  installToolGate(ctx2, { gate: allowGate, logger: { warn: () => {} } });
  const ask = await allowListener({ name: "mcp__mmw-tools__pr_merge" }, async () => "next");
  eq(ask.kind, "ask", "allowed pr_merge still asks the operator");
  const closeAsk = await allowListener({ name: "mcp__mmw-tools__pr_close" }, async () => "next");
  eq(closeAsk.kind, "ask", "allowed pr_close asks the operator");
  const passthrough = await allowListener({ name: "mcp__mmw-tools__repo_read" }, async () => "next");
  eq(passthrough, "next", "non-destructive calls pass through");
}

// REGRESSION: the gate is a global `tools/pre-execute` listener, so it sees
// every tool in the session. It must never deny the host's own standard
// tools — that used to strip `read`/`pwsh`/`glob`/... out of every session
// the plugin was loaded into.
{
  const fake = {
    routes: async () => ({
      contractVersion: 2,
      catalogRevision: "sha256:" + "a".repeat(64),
      policyRevision: 1,
      ttlSeconds: 60,
      allowed: ["mmw-tools-status"],
      allowedOperations: ["mmw-tools-status.status"],
      denied: [{ toolId: "race-ops", requiredRoles: ["operator", "admin"] }],
    }),
  };
  const gate = new PolicyGate({ auth: fake, enabled: true });

  for (const name of [
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "pwsh",
    "subagent",
    "subagent_fork",
    "workflow",
    "skill",
    "todo_write",
    "web_fetch",
    "web_search",
    "present",
    "ask_user_question",
  ]) {
    const decision = await gate.check(name);
    eq(decision.ok, true, `standard tool passes the gate: ${name}`);
  }

  // Another plugin's MCP namespace is also not ours to police.
  eq((await gate.check("mcp__other-plugin__do_thing")).ok, true, "another plugin's tool passes the gate");

  // But an unknown tool of THIS plugin is still denied: the contract is
  // authoritative for the mmw-tools namespace.
  eq((await gate.check("mcp__mmw-tools__unknown")).ok, false, "unknown mmw-tools tool is still denied");
  eq((await gate.check("mmw_tools_unknown")).ok, false, "unknown mmw-tools own tool is still denied");
}

// The listener must short-circuit on the namespace: a standard tool must
// never reach the policy check, and must always reach the host's `next()`.
{
  let listener;
  const ctx = {
    on(event, fn) {
      if (event === "tools/pre-execute") listener = fn;
      return () => {};
    },
  };
  let checked = [];
  const spyGate = {
    check: async (name) => {
      checked.push(name);
      return { ok: true };
    },
  };
  installToolGate(ctx, { gate: spyGate, logger: { warn: () => {} } });

  for (const name of ["read", "pwsh", "glob", "web_search"]) {
    const result = await listener({ name }, async () => "next");
    eq(result, "next", `standard tool reaches the host: ${name}`);
  }
  eq(checked.length, 0, "standard tools never reach the policy check");

  // The plugin's own tools do go through the policy check.
  await listener({ name: "mcp__mmw-tools__repo_read" }, async () => "next");
  eq(checked.length, 1, "mmw-tools tools do reach the policy check");
}

// Namespace predicate.
{
  eq(isMmwTool("mcp__mmw-tools__repo_read"), true, "mmw-tools MCP tool is ours");
  eq(isMmwTool("mmw_tools_status"), true, "mmw-tools own tool is ours");
  eq(isMmwTool("read"), false, "read is not ours");
  eq(isMmwTool("mcp__mmw-tools-extra__x"), false, "lookalike namespace is not ours");
}

// One run id per MMW call: the policy check, the gate event, and `next()`
// all see the same id, and two calls never share one.
{
  let listener;
  const ctx = {
    on(event, fn) {
      if (event === "tools/pre-execute") listener = fn;
      return () => {};
    },
  };
  const events = [];
  const idsInsideCheck = [];
  const gate = {
    check: async () => {
      idsInsideCheck.push(currentRunId());
      return { ok: true };
    },
  };
  installToolGate(ctx, {
    gate,
    logger: { warn: () => {} },
    onEvent: (event) => events.push(event),
  });

  const idsInsideNext = [];
  await listener({ name: "mcp__mmw-tools__repo_read" }, async () => {
    idsInsideNext.push(currentRunId());
    return "next";
  });
  await listener({ name: "mcp__mmw-tools__repo_read" }, async () => {
    idsInsideNext.push(currentRunId());
    return "next";
  });

  eq(/^run_/.test(idsInsideCheck[0] ?? ""), true, "gate check runs with a run id");
  eq(idsInsideCheck[0], idsInsideNext[0], "run id survives from policy check to next()");
  eq(idsInsideCheck[0], events[0]?.runId, "audit event carries the same run id");
  eq(events[0]?.decision, "allow", "allowed call emits an allow event");
  eq(idsInsideCheck[0] !== idsInsideCheck[1], true, "each call gets a fresh run id");

  // The context must not leak into a standard tool that bypasses the gate.
  await listener({ name: "read" }, async () => {
    eq(currentRunId(), undefined, "standard tool runs outside any MMW run context");
    return "next";
  });
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exitCode = 1;
