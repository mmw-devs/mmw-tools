#!/usr/bin/env node
// Tests for the Feishu client, the call-time policy gate, and the operation map.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FeishuAuth } from "../lib/auth/feishu-auth.js";
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
  eq((await gate.check("mcp__mmw-tools__pr_merge")).ok, true, "pr_merge allowed by policy; host confirmation is separate");
  eq((await gate.check("mcp__mmw-tools__unknown")).ok, false, "unknown tool is denied");

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

// installToolGate: policy denial wins before the pr_merge confirmation.
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
  const passthrough = await allowListener({ name: "mcp__mmw-tools__repo_read" }, async () => "next");
  eq(passthrough, "next", "non-merge calls pass through");
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
