#!/usr/bin/env node
// Tests for the workspace guard: the plugin's tools may only run in a session
// whose working directory is inside the bound repository's checkout.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  installWorkspaceGuard,
  isInsidePath,
  shouldAllowWorkspace,
} from "../lib/gate/workspace-guard.js";

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

const ROOT = path.join(os.tmpdir(), "mmw-workspace-guard", "ffxiv-race-ops");
const OUTSIDE = path.join(os.tmpdir(), "novel", "塔伦-设定网");

// ---------------------------------------------------------------- path rules
console.log("isInsidePath");
eq(isInsidePath(ROOT, ROOT), true, "the checkout itself is inside");
eq(isInsidePath(path.join(ROOT, "public", "data.json"), ROOT), true, "a file under it is inside");
eq(isInsidePath(path.join(ROOT, ".."), ROOT), false, "its parent is not inside");
eq(isInsidePath(OUTSIDE, ROOT), false, "an unrelated workspace is not inside");
// The trap path.relative alone does not catch: a sibling whose name merely
// starts with the root's name.
eq(isInsidePath(`${ROOT}-evil`, ROOT), false, "a name-prefix sibling is not inside");
eq(isInsidePath(`${ROOT}2`, ROOT), false, "a numeric-suffix sibling is not inside");

// ------------------------------------------------------------ pure decision
console.log("shouldAllowWorkspace");
eq(shouldAllowWorkspace(ROOT, [ROOT]).ok, true, "session inside the root is allowed");
{
  const verdict = shouldAllowWorkspace(OUTSIDE, [ROOT]);
  eq(verdict.ok, false, "session outside the root is refused");
  truthy(verdict.reason.includes(OUTSIDE), "the refusal names the session directory");
  truthy(verdict.reason.includes(ROOT), "the refusal names the allowed directory");
}
{
  const verdict = shouldAllowWorkspace(path.join(ROOT, "public"), [ROOT, path.join(os.tmpdir(), "other")]);
  eq(verdict.ok, true, "any of several roots is enough");
}
eq(shouldAllowWorkspace(undefined, [ROOT]).ok, true, "unknown directory is allowed by default");
eq(
  shouldAllowWorkspace(undefined, [ROOT], "deny").ok,
  false,
  "unknown directory is refused when onUnavailable is deny"
);

// ------------------------------------------------------------------ the hook
function fakeCtx(services = {}) {
  const listeners = [];
  return {
    listeners,
    on(event, fn) {
      if (event === "tools/pre-execute") listeners.push(fn);
      return () => {};
    },
    get(name) {
      return services[name];
    },
  };
}

function workingDirectoryService(cwd) {
  return { get: (session) => (session && typeof session.cwd === "string" ? session.cwd : cwd) };
}

async function run(guard, exec) {
  const ctx = fakeCtx(guard.services ?? {});
  installWorkspaceGuard(ctx, { roots: guard.roots, logger: guard.logger ?? { warn: () => {} }, ...guard.extra });
  if (ctx.listeners.length === 0) return { installed: false };
  let called = false;
  const result = await ctx.listeners[0](exec, async () => {
    called = true;
    return "next";
  });
  return { installed: true, result, called, listener: ctx.listeners[0] };
}

console.log("installWorkspaceGuard");
{
  const { installed, result, called } = await run({ roots: [ROOT] }, { name: "read" });
  eq(installed, true, "the guard installs a single pre-execute listener");
  eq(result, "next", "a standard host tool passes straight through");
  eq(called, true, "the host still receives the call");
}
{
  // The service is reachable through the agent's own context, which is the
  // real shape: exec.agent.ctx → workingDirectory.get(exec.agent.session).
  const session = { cwd: ROOT };
  const agent = { session, ctx: { get: (name) => (name === "workingDirectory" ? workingDirectoryService() : undefined) } };
  const { result, called } = await run({ roots: [ROOT] }, { name: "mcp__mmw-tools__repo_read", agent });
  eq(result, "next", "an mmw-tools call from inside the checkout passes");
  eq(called, true, "the host receives the in-workspace call");
}
{
  const session = { cwd: OUTSIDE };
  const agent = { session, ctx: { get: (name) => (name === "workingDirectory" ? workingDirectoryService() : undefined) } };
  const { result, called } = await run({ roots: [ROOT] }, { name: "mcp__mmw-tools__repo_read", agent });
  eq(result?.kind, "deny", "an mmw-tools call from another workspace is refused");
  truthy(result?.reason.includes(OUTSIDE), "the refusal names the session directory");
  eq(called, false, "the host never sees the out-of-workspace call");
}
{
  // The directory is read per call, not cached: `cd` into the repository must
  // start working, and `cd` out must stop working.
  const session = { cwd: OUTSIDE };
  const agent = { session, ctx: { get: (name) => (name === "workingDirectory" ? workingDirectoryService() : undefined) } };
  const ctx = fakeCtx();
  installWorkspaceGuard(ctx, { roots: [ROOT], logger: { warn: () => {} } });
  const call = () => ctx.listeners[0]({ name: "mcp__mmw-tools__repo_read", agent }, async () => "next");
  eq((await call())?.kind, "deny", "outside before cd");
  session.cwd = ROOT;
  eq(await call(), "next", "inside after cd");
  session.cwd = OUTSIDE;
  eq((await call())?.kind, "deny", "outside again after cd");
}
{
  // The service can also be reached from the plugin context when the agent
  // context does not expose it (services are layered).
  const session = { cwd: ROOT };
  const agent = { session, ctx: {} };
  const { result } = await run(
    { roots: [ROOT], services: { workingDirectory: workingDirectoryService() } },
    { name: "mcp__mmw-tools__repo_read", agent }
  );
  eq(result, "next", "the plugin context is the fallback for the service");
}
{
  const { result } = await run({ roots: [ROOT] }, { name: "mcp__mmw-tools__repo_read" });
  eq(result, "next", "an execution with no agent is allowed by default");
}
{
  const { result } = await run(
    { roots: [ROOT], extra: { onUnavailable: "deny" } },
    { name: "mcp__mmw-tools__repo_read" }
  );
  eq(result?.kind, "deny", "an execution with no agent is refused under onUnavailable=deny");
}
{
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };
  const ctx = fakeCtx();
  installWorkspaceGuard(ctx, { roots: [ROOT], logger });
  const session = { cwd: ROOT };
  const agent = { session, ctx: {} };
  const first = await ctx.listeners[0]({ name: "mcp__mmw-tools__repo_read", agent }, async () => "next");
  const second = await ctx.listeners[0]({ name: "mcp__mmw-tools__repo_read", agent }, async () => "next");
  eq(first, "next", "a host without the service does not break calls");
  eq(second, "next", "and keeps not breaking them");
  eq(warnings.length, 1, "the missing service is reported exactly once");
}
{
  const ctx = fakeCtx();
  installWorkspaceGuard(ctx, { roots: [ROOT], enabled: false, logger: { warn: () => {} } });
  eq(ctx.listeners.length, 0, "enabled:false installs nothing");
}
{
  const warnings = [];
  installWorkspaceGuard(
    { on: undefined },
    { roots: [ROOT], logger: { warn: (m) => warnings.push(m) } }
  );
  eq(warnings.length, 1, "a host without tools/pre-execute is reported, not crashed");
}

// Both guards must coexist: the workspace guard is installed first and the
// policy gate still sees only its own tools (see feishu-gate.test.mjs).
{
  const ctx = fakeCtx();
  installWorkspaceGuard(ctx, { roots: [ROOT], logger: { warn: () => {} } });
  installWorkspaceGuard(ctx, { roots: [ROOT], logger: { warn: () => {} } });
  eq(ctx.listeners.length, 2, "two guards can be installed side by side");
}

assert.ok(pass > 0);
console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exitCode = 1;
