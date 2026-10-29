#!/usr/bin/env node
/**
 * scripts/t5-write.mjs
 *
 * The write half of T5: one real edit, one real draft PR, against the
 * real bound repository. Run docs/T5-RUNBOOK.md's cleanup immediately
 * afterwards — this script leaves the PR open on purpose so it can be
 * inspected before closing.
 *
 * Usage:
 *   $env:E2E_TOKEN = <token with repo scope>   # never logged
 *   node scripts/t5-write.mjs [owner/name] [branch]
 *
 * Requires mcp-server/dist to be built.
 */

import path from "node:path";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TOOLS = path.join(ROOT, "mcp-server", "dist", "tools");

const target = process.argv[2] ?? "mmw-devs/ffxiv-race-ops";
const [owner, name] = target.split("/");
const branch = process.argv[3] ?? `content/e2e-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

const token = process.env.E2E_TOKEN ?? null;
if (!token) {
  console.error("E2E_TOKEN is not set (never logged)");
  process.exit(2);
}

const workingDir =
  process.env.E2E_WORKING_DIR ?? path.join(process.env.USERPROFILE ?? "", ".dsh", "workspaces", owner, name);

const load = async (f) => (await import(pathToFileURL(path.join(TOOLS, f)).href));
const { repoEdit } = await load("repo-edit.js");
const { prCreate } = await load("pr-create.js");

let pass = 0;
let fail = 0;
const check = (cond, label, detail) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const cfg = {
  workingDir,
  repoUrl: `https://github.com/${owner}/${name}.git`,
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
console.log(`branch: ${branch}`);
console.log(`working dir: ${workingDir}\n`);

/* ---------- 1. origin must be credential-free before we start ---------- */
{
  const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: workingDir, encoding: "utf8" }).trim();
  check(!url.includes("@"), "origin holds no credentials", url.includes("@") ? "<REDACTED>@" : url);
}

/* ---------- 2. force the real bootstrap path ---------- */
{
  const nm = path.join(workingDir, "node_modules");
  if (existsSync(nm)) {
    rmSync(nm, { recursive: true, force: true });
    console.log("  (removed node_modules to exercise bootstrap)");
  }
  check(!existsSync(nm), "node_modules absent, so bootstrap must run");
}

/* ---------- 3. the edit ---------- */
console.log("\n--- repo_edit (real, with bootstrap) ---");
const before = readFileSync(path.join(workingDir, "public", "data.json"), "utf8");
const m = before.match(/"startTime":\s*"([^"]+)"/);
if (!m) {
  console.error("  FAIL  could not find startTime in public/data.json");
  process.exit(1);
}
const originalStart = m[1];
const bumpedStart = originalStart.replace(/:(\d{2})Z$/, (_all, ss) => `:${String((Number(ss) + 1) % 60).padStart(2, "0")}Z`);
console.log(`  startTime: ${originalStart} -> ${bumpedStart}`);

let editResult;
try {
  editResult = await repoEdit(
    {
      branch,
      edits: [
        {
          path: "public/data.json",
          mode: "replace",
          find: `"startTime": "${originalStart}"`,
          replace: `"startTime": "${bumpedStart}"`,
        },
      ],
      commit_message: `content: e2e check ${new Date().toISOString().slice(0, 10)}`,
    },
    cfg
  );
} catch (err) {
  console.error(`  FAIL  repo_edit threw: ${err?.code ?? ""} ${err?.message ?? err}`);
  process.exit(1);
}

check(editResult.branch === branch, "committed on the e2e branch", editResult.branch);
check(editResult.bootstrap.ran === true, "bootstrap ran", `exit ${editResult.bootstrap.exit_code}`);
check(editResult.preflight.exit_code === 0, "preflight passed", `exit ${editResult.preflight.exit_code}`);
check(/^[0-9a-f]{40}$/.test(editResult.new_commit_sha ?? "") || (editResult.new_commit_sha ?? "").length > 0, "commit created", (editResult.new_commit_sha ?? "").slice(0, 12));

/* ---------- 4. the draft PR ---------- */
console.log("\n--- pr_create (draft) ---");
let pr;
try {
  pr = await prCreate(
    {
      head_branch: branch,
      title: `[e2e-test] 请勿合并：插件端到端验证 ${new Date().toISOString().slice(0, 10)}`,
      body:
        "## 这是一次自动化端到端测试产生的 PR\n\n" +
        "- 目的：验证 dsh-mmw-tools 的 `repo_edit` → `pr_create` 链路\n" +
        "- 改动：`public/data.json` 的 `meta.startTime` 秒数 +1（语义无影响）\n" +
        "- **必须关闭，不得合并**\n\n" +
        "验证完成后会立即关闭并删除分支。",
      draft: true,
    },
    cfg
  );
} catch (err) {
  console.error(`  FAIL  pr_create threw: ${err?.code ?? ""} ${err?.message ?? err}`);
  process.exit(1);
}

check(typeof pr.number === "number" && pr.number > 0, "PR created", `#${pr.number}`);
check(/^https:\/\/github\.com\/.+\/pull\/\d+$/.test(pr.url ?? ""), "URL matches the expected shape", pr.url);

console.log(`\n${pass} pass, ${fail} fail`);
console.log(`\nPR: ${pr.url}`);
console.log(`branch: ${branch}`);
console.log("NEXT: verify with gh, then close and delete the branch.");
process.exit(fail > 0 ? 1 : 0);
