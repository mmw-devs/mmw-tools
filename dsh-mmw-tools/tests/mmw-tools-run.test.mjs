#!/usr/bin/env node
// tests/mmw-tools-run.test.mjs
//
// Unit tests for the mmw_tools_run wrapper. The function reads AGENTS.md
// + README.md from a working directory, validates inputs, builds a
// branch suggestion, and returns a structured project context.
// All I/O is via fs/promises; we point it at a tmp dir.
//
// Run: node tests/mmw-tools-run.test.mjs
// Build first: pnpm build (so lib/agent/mmw-tools-run.js exists).

import { pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MMW_TOOLS_RUN_DIST = path.join(ROOT, "lib", "agent", "mmw-tools-run.js");

if (!existsSync(MMW_TOOLS_RUN_DIST)) {
  console.error("Run `pnpm build` first.");
  process.exit(2);
}

const er = await import(pathToFileURL(MMW_TOOLS_RUN_DIST).href);

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  PASS  ${label}`); }
function bad(label, msg) { fail++; console.error(`  FAIL  ${label}: ${msg}`); }
function eq(actual, want, label) {
  if (actual === want) ok(`${label} = ${JSON.stringify(want)}`);
  else bad(label, `expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
}
function truthy(v, label) { if (v) ok(label); else bad(label, "expected truthy"); }
function throws(fn, codeMatch, label) {
  try {
    fn();
    bad(label, "expected throw");
  } catch (err) {
    if (!codeMatch || (err.code === codeMatch) || (err instanceof Error && err.message.includes(codeMatch))) {
      ok(`${label} (${err.code ?? err.message.slice(0, 50)})`);
    } else {
      bad(label, `wrong error: ${err?.code ?? err?.message}`);
    }
  }
}

const TEST_CFG = {
  workingDir: "",
  repo: { owner: "mmw-devs", name: "ffxiv-race-ops", baseBranch: "main" },
  allowlistPaths: ["public/data.json"],
  denylistPaths: ["AGENTS.md", "README.md", ".github/workflows/**", "schema/**"],
  branchPrefix: "content/",
  preflightCmd: "npm run validate",
};

function freshWorkdir() {
  return mkdtempSync(path.join(tmpdir(), "dsh-engineer-"));
}
function cleanup(d) {
  try { rmSync(d, { recursive: true, force: true }); } catch {}
}

/* ============================================================== */
/*  validateInput                                                   */
/* ============================================================== */

console.log("\n--- validateInput ---");

throws(
  () => er.validateInput({ user_request: "" }),
  "user-request-empty",
  "empty user_request refused"
);

throws(
  () => er.validateInput({ user_request: "x".repeat(9000) }),
  "user-request-too-long",
  "oversize user_request refused"
);

throws(
  () =>
    er.validateInput({
      user_request: "fix the bug gho_abc123def456ghi789jkl012mno345pqr678st",
    }),
  "user-request-contains-token",
  "token in user_request refused"
);

throws(
  () => er.validateInput({ user_request: "ok", branch_name: "" }),
  "branch-name-empty",
  "empty branch_name refused"
);

er.validateInput({ user_request: "fix bug" });
ok("valid input accepted");

er.validateInput({ user_request: "fix bug", branch_name: "content/x" });
ok("valid input with branch_name accepted");

/* ============================================================== */
/*  suggestBranchName                                              */
/* ============================================================== */

console.log("\n--- suggestBranchName ---");

eq(
  // "Fix the bug in data.json" -> lowercase -> non-alnum to space ->
  // words: fix, the, bug, in, data, json -> first 5 = fix-the-bug-in-data
  er.suggestBranchName("Fix the bug in data.json", "content/"),
  `content/${new Date().toISOString().slice(0, 10)}-fix-the-bug-in-data`,
  "slug is first 5 lowercase-dashed words"
);

eq(
  er.suggestBranchName("  Mixed   CASE  And Punctuation!!! ", "content/"),
  "content/" + new Date().toISOString().slice(0, 10) + "-mixed-case-and-punctuation",
  "non-alphanumeric → dashes"
);

eq(
  er.suggestBranchName("///", "content/"),
  "content/" + new Date().toISOString().slice(0, 10) + "-update",
  "all-punctuation falls back to 'update'"
);

/* ============================================================== */
/*  engineerRun (full integration)                                 */
/* ============================================================== */

console.log("\n--- engineerRun: happy path ---");

{
  const wd = freshWorkdir();
  writeFileSync(
    path.join(wd, "AGENTS.md"),
    "# AGENTS.md\n\nRules: never push to main. Always run validate."
  );
  writeFileSync(
    path.join(wd, "README.md"),
    "# README\n\nThis is a test project. It uses npm run validate."
  );

  const out = await er.engineerRun(
    { user_request: "Fix the leaderboard bug" },
    { ...TEST_CFG, workingDir: wd }
  );

  try {
    truthy(out.branch_suggestion.startsWith("content/"), "branch starts with prefix");
    truthy(out.working_dir === wd, "working_dir echoed back");
    eq(out.repo.owner, "mmw-devs", "repo.owner");
    eq(out.repo.name, "ffxiv-race-ops", "repo.name");
    eq(out.repo.base_branch, "main", "repo.base_branch");
    truthy(out.agents_md_present, "agents_md_present = true");
    truthy(out.agents_md_excerpt.includes("never push to main"), "AGENTS.md excerpt content");
    truthy(out.readme_present, "readme_present = true");
    truthy(out.readme_excerpt.includes("test project"), "README.md excerpt content");
    eq(out.allowlist.length, 1, "1 allowlist");
    eq(out.allowlist[0], "public/data.json", "allowlist[0]");
    eq(out.denylist.length, 4, "4 denylist");
    eq(out.branch_prefix, "content/", "branch_prefix");
    eq(out.preflight_cmd, "npm run validate", "preflight_cmd");
    truthy(out.tool_inventory.length >= 8, `tool_inventory has 8+ items (got ${out.tool_inventory.length})`);
    truthy(out.instructions.includes("OPERATING ENVIRONMENT"), "instructions have header");
    truthy(out.instructions.includes("mmw-devs/ffxiv-race-ops"), "instructions mention repo");
    truthy(
      out.instructions.includes("Never push directly to main"),
      "instructions carry the AGENTS.md rule"
    );
    truthy(
      out.instructions.includes("Never include credentials"),
      "instructions include hard rules"
    );
  } finally {
    cleanup(wd);
  }
}

console.log("\n--- engineerRun: missing AGENTS.md / README.md ---");

{
  const wd = freshWorkdir();
  const out = await er.engineerRun(
    { user_request: "Touch README only" },
    { ...TEST_CFG, workingDir: wd }
  );
  cleanup(wd);
  eq(out.agents_md_present, false, "no AGENTS.md → agents_md_present = false");
  truthy(
    out.agents_md_excerpt.includes("no AGENTS.md found"),
    "agents_md_excerpt explains absence"
  );
  eq(out.readme_present, false, "no README.md → readme_present = false");
  truthy(
    out.readme_excerpt.includes("no README.md found"),
    "readme_excerpt explains absence"
  );
}

console.log("\n--- engineerRun: token in AGENTS.md is redacted ---");

{
  const wd = freshWorkdir();
  writeFileSync(
    path.join(wd, "AGENTS.md"),
    "Use this token: gho_abc123def456ghi789jkl012mno345pqr678st"
  );
  const out = await er.engineerRun(
    { user_request: "do anything" },
    { ...TEST_CFG, workingDir: wd }
  );
  cleanup(wd);
  truthy(
    !out.agents_md_excerpt.includes("gho_abc123def456ghi789jkl012mno345pqr678st"),
    "raw token NOT in excerpt"
  );
  truthy(
    out.agents_md_excerpt.includes("[REDACTED]"),
    "excerpt shows [REDACTED]"
  );
}

console.log("\n--- engineerRun: token-bearing user_request is refused ---");

{
  const wd = freshWorkdir();
  writeFileSync(path.join(wd, "AGENTS.md"), "# ok\n");
  let caught = null;
  try {
    await er.engineerRun(
      { user_request: "echo Bearer ghp_secretvalue_abc123def456ghi789jkl012" },
      { ...TEST_CFG, workingDir: wd }
    );
  } catch (err) {
    caught = err;
  }
  cleanup(wd);
  truthy(
    caught !== null && caught.code === "user-request-contains-token",
    `engineerRun refuses token-bearing user_request (caught: ${caught?.code})`
  );
}

console.log("\n--- engineerRun: AGENTS.md > 4 KiB is truncated ---");

{
  const wd = freshWorkdir();
  const big = "# big\n" + "x".repeat(8000);
  writeFileSync(path.join(wd, "AGENTS.md"), big);
  const out = await er.engineerRun(
    { user_request: "do" },
    { ...TEST_CFG, workingDir: wd }
  );
  cleanup(wd);
  truthy(out.agents_md_present, "big AGENTS.md still present");
  truthy(
    out.agents_md_excerpt.length <= 4 * 1024 + 16,
    `excerpt is truncated (got ${out.agents_md_excerpt.length} bytes)`
  );
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);