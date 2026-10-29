#!/usr/bin/env node
/**
 * scripts/t5-readonly.mjs
 *
 * The read-only half of T5: runs the real tool bodies against the real
 * bound repository. No writes, no branches, no PRs — this proves that
 * clone, auth, read and search work against production data, which no
 * fixture can prove.
 *
 * The write half (repo_edit + pr_create) is deliberately not here; see
 * docs/T5-RUNBOOK.md for why it needs a human in the loop.
 *
 * Usage:
 *   $env:E2E_TOKEN = <token with repo scope>   # never logged
 *   node scripts/t5-readonly.mjs [owner/name]
 *
 * Requires mcp-server/dist to be built (pnpm build:all).
 */

import path from "node:path";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TOOLS = path.join(ROOT, "mcp-server", "dist", "tools");

const target = process.argv[2] ?? "mmw-devs/ffxiv-race-ops";
const [owner, name] = target.split("/");
if (!owner || !name) {
  console.error("usage: node scripts/t5-readonly.mjs <owner>/<name>");
  process.exit(2);
}

const token = process.env.E2E_TOKEN ?? null;
if (!token) {
  console.error("E2E_TOKEN is not set (this script never logs it)");
  process.exit(2);
}

const workingDir =
  process.env.E2E_WORKING_DIR ?? path.join(process.env.USERPROFILE ?? "", ".dsh", "workspaces", owner, name);
const repoUrl = `https://github.com/${owner}/${name}.git`;

const load = async (file) =>
  (await import(pathToFileURL(path.join(TOOLS, file)).href));
const { repoStatus } = await load("repo-status.js");
const { repoClone } = await load("repo-clone.js");
const { repoRead } = await load("repo-read.js");
const { repoSearch } = await load("repo-search.js");

let pass = 0;
let fail = 0;
function ok(label, detail) {
  pass++;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label, detail) {
  fail++;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}
function check(cond, label, detail) {
  if (cond) ok(label, detail);
  else bad(label, detail);
}

const cfg = {
  workingDir,
  repoUrl,
  repoOwner: owner,
  repoName: name,
  baseBranch: "main",
  branchPrefix: "content/",
  allowlistPaths: ["public/data.json"],
  denylistPaths: [".github/workflows/**", "schema/**", "scripts/**", "AGENTS.md", "README.md", "dist/**"],
  preflight: { cmd: "npm run validate", timeoutSeconds: 60 },
  bootstrap: { cmd: "npm ci", whenMissing: "node_modules", timeoutSeconds: 300 },
  githubToken: token,
};

console.log(`\ntarget: ${owner}/${name}`);
console.log(`working dir: ${workingDir}`);
console.log(`token: present (${token.length} chars, never printed)\n`);

/* ---------- 1. not cloned yet ---------- */
console.log("--- repo_status before clone ---");
process.env.GHOST_WORKING_DIR = workingDir;
{
  const s = await repoStatus({});
  check(s.cloned !== true, "reports not-cloned before any clone", `cloned=${s.cloned}`);
}

/* ---------- 2. clone for real ---------- */
console.log("\n--- repo_clone (private repo, real auth) ---");
{
  const res = await repoClone({ force: true }, cfg);
  check(res.branch === "main", "cloned on main", res.branch);
  check(existsSync(path.join(workingDir, ".git")), "checkout exists");
  check(existsSync(path.join(workingDir, "public", "data.json")), "public/data.json present");
  check(existsSync(path.join(workingDir, "AGENTS.md")), "AGENTS.md present");
}

/* ---------- 3. status ---------- */
console.log("\n--- repo_status ---");
{
  const s = await repoStatus({});
  check(s.cloned === true, "cloned", String(s.cloned));
  check(s.current_branch === "main", "on main", s.current_branch);
  check(s.dirty === false, "clean tree", `dirty=${s.dirty}`);
  check(/^[0-9a-f]{40}$/.test(s.last_commit_sha ?? ""), "HEAD is a sha", (s.last_commit_sha ?? "").slice(0, 12));
}

/* ---------- 4. read the real files ---------- */
console.log("\n--- repo_read ---");
{
  const data = await repoRead({ path: "public/data.json" }, cfg);
  check(data.content.length > 0, "read public/data.json", `${data.byte_size} bytes`);
  check(data.content.trimStart().startsWith("{"), "data.json looks like JSON");
  let parsed = null;
  try {
    parsed = JSON.parse(data.content);
    ok("data.json parses as JSON");
  } catch (e) {
    bad("data.json parses as JSON", e.message);
  }
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed);
    ok("top-level keys", keys.join(", ") || "(none)");
  }

  const pkg = await repoRead({ path: "package.json" }, cfg);
  let pkgJson = null;
  try {
    pkgJson = JSON.parse(pkg.content);
  } catch {
    /* not fatal */
  }
  if (pkgJson?.scripts?.validate) {
    ok("package.json has a validate script", pkgJson.scripts.validate);
  } else {
    bad("package.json has a validate script", "missing — preflight would fail");
  }

  const agents = await repoRead({ path: "AGENTS.md" }, cfg);
  check(agents.content.length > 0, "read AGENTS.md", `${agents.byte_size} bytes`);

  // CRLF awareness: repo_edit matches byte-for-byte, so record what this
  // checkout actually uses.
  const usesCRLF = data.content.includes("\r\n");
  ok("working tree line endings", usesCRLF ? "CRLF" : "LF");
}

/* ---------- 5. search real content ---------- */
console.log("\n--- repo_search ---");
{
  const hit = await repoSearch({ query: "team" }, cfg);
  check(hit.hits.length > 0, "search finds at least one match", `${hit.hits.length} hits`);
  if (hit.hits.length > 0) {
    ok("first hit", `${hit.hits[0].path}:${hit.hits[0].line}`);
  }
  const scoped = await repoSearch({ query: "team", glob: "public/**" }, cfg);
  check(
    scoped.hits.every((h) => h.path.startsWith("public/")),
    "glob narrows results to public/",
    `${scoped.hits.length} hits`
  );
}

/* ---------- summary ---------- */
console.log(`\n${pass} pass, ${fail} fail`);
console.log(`checkout left at: ${workingDir}`);
console.log("no branch was created, nothing was pushed, no PR was opened");
process.exit(fail > 0 ? 1 : 0);
