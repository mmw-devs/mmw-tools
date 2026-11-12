#!/usr/bin/env node
// Session repository selection: registry, gate, and the binding table sent
// to the MCP child. Tool names stay repository-free (docs/TOOL-NAMING.md).
import assert from "node:assert/strict";

import { PolicyGate } from "../lib/gate/gate.js";
import { RepoRegistry, repoKey } from "../lib/gate/repo-registry.js";
import { buildRepoEntries, mcpBindingEnv, normalizeBinding } from "../lib/index.js";

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

const entry = (key, baseBranch = "main") => ({
  key,
  owner: key.split("/")[0],
  name: key.split("/")[1],
  baseBranch,
  branchPrefix: "content/",
  allowlistPaths: ["public/data.json"],
  denylistPaths: ["scripts/**"],
  workingDir: `/tmp/${key}`,
  tokenFile: `/tmp/${key}.json`,
  repoUrl: `https://github.com/${key}.git`,
  preflight: { cmd: "true", timeoutSeconds: 60 },
  bootstrap: { cmd: "", whenMissing: "node_modules", timeoutSeconds: 300 },
});

// ---- Registry ----------------------------------------------------------
{
  const repos = new RepoRegistry([entry("mmw-devs/ffxiv-race-ops"), entry("mmw-devs/xivstrat-relay", "master")], "mmw-devs/ffxiv-race-ops");
  eq(repos.normalize("MMW-Devs/XIVSTRAT-RELAY"), "mmw-devs/xivstrat-relay", "lookup is case-insensitive");
  eq(repos.normalize("mmw-devs/unknown"), null, "unknown repository does not resolve");
  eq(repos.select("s1", "mmw-devs/xivstrat-relay").ok, true, "first selection succeeds");
  eq(repos.selectedBy("s1"), "mmw-devs/xivstrat-relay", "selection is remembered per session");
  eq(repos.select("s1", "mmw-devs/xivstrat-relay").ok, true, "same repository is idempotent");
  const switched = repos.select("s1", "mmw-devs/ffxiv-race-ops");
  eq(switched.ok, false, "switching repositories is refused");
  if (!switched.ok) truthy(switched.reason.includes("不能再切换"), "refusal explains that the binding is fixed");
  eq(repos.selectedBy("s2"), undefined, "another session is independent");
}

// ---- Gate --------------------------------------------------------------
const routes = {
  contractVersion: 2,
  catalogRevision: "sha256:" + "a".repeat(64),
  policyRevision: 1,
  ttlSeconds: 60,
  allowed: ["race-ops"],
  allowedOperations: [
    "race-ops.select_repo",
    "race-ops.repo_read",
    "race-ops.pr_merge",
  ],
  denied: [],
};
const fakeAuth = { routes: async () => routes };
{
  const repos = new RepoRegistry([entry("mmw-devs/ffxiv-race-ops")], "mmw-devs/ffxiv-race-ops");
  const gate = new PolicyGate({ auth: fakeAuth, enabled: true, repos });

  const unselected = await gate.check("mcp__mmw-tools__repo_read", "session-1");
  eq(unselected.ok, false, "business tool is denied before selection");
  truthy(unselected.reason.startsWith("[mmw_route_denied]"), "unselected denial uses the route-denied prefix");
  truthy(unselected.reason.includes("select_repo"), "denial names the tool to call first");

  const select = await gate.check("mcp__mmw-tools__select_repo", "session-1");
  eq(select.ok, true, "select_repo itself is never blocked by repo binding");

  eq(repos.select("session-1", "mmw-devs/ffxiv-race-ops").ok, true, "bind the session");
  eq((await gate.check("mcp__mmw-tools__repo_read", "session-1")).ok, true, "business tool passes after selection");
  eq((await gate.check("mcp__mmw-tools__pr_merge", "session-1")).ok, true, "write tool passes after selection");

  const unknownSession = await gate.check("mcp__mmw-tools__repo_read");
  eq(unknownSession.ok, false, "missing session id fails closed");
}

// A deployed auth table may lag the plugin contract; select_repo must still
// work so the session can bind a repository before any business call.
{
  const lagging = { ...routes, allowedOperations: ["race-ops.repo_read"] };
  const gate = new PolicyGate({
    auth: { routes: async () => lagging },
    enabled: true,
    repos: new RepoRegistry([entry("mmw-devs/xivstrat-relay")], "mmw-devs/xivstrat-relay"),
  });
  eq(
    (await gate.check("mcp__mmw-tools__select_repo", "session-lag")).ok,
    true,
    "select_repo works even when the deployed operation table lags"
  );
  const denied = await gate.check("mcp__mmw-tools__pr_merge", "session-lag");
  eq(denied.ok, false, "a lagging table still denies operations it does not list");
}

// A gate without a registry (single-repo profile) keeps the old behaviour.
{
  const gate = new PolicyGate({ auth: fakeAuth, enabled: true });
  eq((await gate.check("mcp__mmw-tools__repo_read", "session-1")).ok, true, "no registry means no session binding");
}

// ---- Binding table sent to MCP ----------------------------------------
{
  const binding = normalizeBinding({
    owner: "mmw-devs",
    name: "ffxiv-race-ops",
    baseBranch: "main",
  });
  const entries = buildRepoEntries(binding, "/work/race-ops", [
    { owner: "mmw-devs", name: "xivstrat-relay", baseBranch: "master" },
  ]);
  eq(entries.length, 2, "default plus one extra repository");
  eq(entries[0].key, repoKey("mmw-devs", "ffxiv-race-ops"), "default entry is first");
  eq(entries[1].baseBranch, "master", "extra entry keeps its base branch");
  truthy(entries[1].tokenFile.includes("xivstrat-relay"), "extra entry gets its own token file");
  truthy(entries[1].workingDir.includes("xivstrat-relay"), "extra entry gets a derived working directory");

  const env = mcpBindingEnv(binding, "/work/race-ops", "", entries);
  const table = JSON.parse(env.MMW_REPOS);
  eq(table.length, 2, "MMW_REPOS carries every entry");
  eq(table[1].key, "mmw-devs/xivstrat-relay", "MMW_REPOS keeps the full key");
  eq(table[1].preflight.cmd, "npm run validate", "MMW_REPOS carries preflight defaults");
}

console.log(`\nrepo-selection: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
