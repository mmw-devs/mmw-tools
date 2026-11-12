#!/usr/bin/env node
// Session repository selection: registry, gate, and the binding table sent
// to the MCP child. Tool names stay repository-free (docs/TOOL-NAMING.md).
import assert from "node:assert/strict";

import { PolicyGate } from "../lib/gate/gate.js";
import { RepoRegistry, repoKey } from "../lib/gate/repo-registry.js";
import { buildRepoEntries, mcpBindingEnv, mergeRepoCacheEntries, normalizeBinding } from "../lib/index.js";
import { readRepoRegistryCache, writeRepoRegistryCache } from "../lib/gate/repo-cache.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

// The route table is requested for the selected repository, and a table for a
// different repository is refused rather than silently granted.
{
  const repos = new RepoRegistry([entry("mmw-devs/xivstrat-relay")], "mmw-devs/xivstrat-relay");
  eq(repos.select("session-scope", "mmw-devs/xivstrat-relay").ok, true, "bind the session");
  let seenRepo;
  const scoped = { ...routes, repo: "mmw-devs/xivstrat-relay", allowedOperations: ["race-ops.repo_read"] };
  const gate = new PolicyGate({
    auth: {
      routes: async (_force, _maxAge, repo) => {
        seenRepo = repo;
        return scoped;
      },
    },
    enabled: true,
    repos,
  });
  eq((await gate.check("mcp__mmw-tools__repo_read", "session-scope")).ok, true, "scoped read passes");
  eq(seenRepo, "mmw-devs/xivstrat-relay", "gate requests the selected repository");
  const denied = await gate.check("mcp__mmw-tools__repo_edit", "session-scope");
  eq(denied.ok, false, "operation absent from the repository table is denied");
  truthy(denied.reason.startsWith("[mmw_route_denied]"), "scoped denial uses the route-denied prefix");

  const wrongRepo = new PolicyGate({
    auth: { routes: async () => ({ ...scoped, repo: "mmw-devs/ffxiv-race-ops" }) },
    enabled: true,
    repos,
  });
  const mismatch = await wrongRepo.check("mcp__mmw-tools__repo_read", "session-scope");
  eq(mismatch.ok, false, "a table for another repository is refused");
  truthy(mismatch.reason.startsWith("[mmw_contract_mismatch]"), "mismatch uses the contract-mismatch prefix");
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

// ---- Registry cache overlay -------------------------------------------
{
  const binding = normalizeBinding({ owner: "mmw-devs", name: "ffxiv-race-ops" });
  const entries = buildRepoEntries(binding, "/work/race-ops", [
    { owner: "mmw-devs", name: "xivstrat-relay", baseBranch: "master" },
  ]);
  const merged = mergeRepoCacheEntries(entries, [
    {
      key: "mmw-devs/xivstrat-relay",
      owner: "mmw-devs",
      name: "xivstrat-relay",
      baseBranch: "develop",
      branchPrefix: "content/",
      allowlistPaths: ["src/data/**"],
      denylistPaths: ["AGENTS.md"],
    },
  ]);
  eq(merged.length, 1, "the registry is authoritative over the profile list");
  eq(merged[0].baseBranch, "develop", "registry base branch wins");
  eq(merged[0].workingDir, entries[1].workingDir, "local working directory is preserved");
  eq(merged[0].bootstrap.cmd, "", "unconfigured bootstrap falls back to a no-op");

  const added = mergeRepoCacheEntries(entries, [
    {
      key: "mmw-devs/new-repo",
      owner: "mmw-devs",
      name: "new-repo",
      baseBranch: "main",
      branchPrefix: "content/",
      allowlistPaths: [],
      denylistPaths: [],
    },
  ]);
  truthy(added[0].workingDir.includes("new-repo"), "new registry repo gets a derived working directory");
  truthy(added[0].tokenFile.includes("new-repo"), "new registry repo gets its own token file");

  const dir = mkdtempSync(path.join(tmpdir(), "mmw-repo-cache-"));
  const file = path.join(dir, "repos.json");
  writeRepoRegistryCache(
    {
      fetchedAt: 1,
      policyRevision: 9,
      defaultRepo: "mmw-devs/xivstrat-relay",
      repos: [
        {
          key: "mmw-devs/xivstrat-relay",
          owner: "mmw-devs",
          name: "xivstrat-relay",
          baseBranch: "master",
          branchPrefix: "content/",
          allowlistPaths: ["src/data/**"],
          denylistPaths: [],
        },
      ],
    },
    file
  );
  const loaded = readRepoRegistryCache(file);
  eq(loaded?.defaultRepo, "mmw-devs/xivstrat-relay", "cache round-trips the default repo");
  eq(loaded?.repos[0].baseBranch, "master", "cache round-trips registry fields");
}

console.log(`\nrepo-selection: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
