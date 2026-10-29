#!/usr/bin/env node
// mcp-server/tests/guard.test.mjs
//
// Tests the cross-cutting guards every MCP tool runs through.
// Each guard test case is a documented INCREMENT-3-CHECKLIST.md item.
//
// Run: node mcp-server/tests/guard.test.mjs

import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Resolve compiled guard.js relative to this file.
// Tests run via: `node tests/guard.test.mjs` from the bundle root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// The guard module is TS — we need ts-node or tsc to run it.
// We test against the COMPILED output (`dist/guard.js`).
if (!existsSync(path.join(ROOT, "dist/guard.js"))) {
  console.error("Please run `pnpm build` in mcp-server first.");
  process.exit(2);
}
const guardPath = pathToFileURL(path.join(ROOT, "dist/guard.js")).href;

const guard = await import(guardPath);

let pass = 0;
let fail = 0;

function ok(label) {
  pass++;
  console.log(`  PASS  ${label}`);
}
function bad(label, msg) {
  fail++;
  console.error(`  FAIL  ${label}: ${msg}`);
}
function eq(actual, want, label) {
  if (actual === want) ok(`${label} = ${JSON.stringify(want)}`);
  else bad(label, `expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
}
function truthy(v, label) {
  if (v) ok(label);
  else bad(label, "expected truthy");
}
function throws(fn, matcher, label) {
  // Promise-returning fn → await its rejection; sync fn → catch inline.
  let maybePromise;
  try {
    maybePromise = fn();
  } catch (err) {
    return checkErr(err, matcher, label);
  }
  if (maybePromise && typeof maybePromise.then === "function") {
    return maybePromise.then(
      () => bad(label, `expected throw matching ${matcher}, resolved instead`),
      (err) => checkErr(err, matcher, label)
    );
  }
  bad(label, `expected throw matching ${matcher}, no throw`);
}
function checkErr(err, matcher, label) {
  if (err?.name === "GithubRefusedError" && (matcher === undefined || err.code === matcher || err.message.includes(matcher))) {
    ok(`${label} (${err.code || err.message.slice(0, 50)})`);
  } else {
    bad(label, `wrong error: ${err?.name}: ${err?.message}`);
  }
}

/* ============================================================== */
/*  assertSafeRepoPath                                             */
/* ============================================================== */

console.log("\n--- assertSafeRepoPath ---");

const tmpRepo = mkdtempSync(path.join(tmpdir(), "dsh-guard-test-"));
mkdirSync(path.join(tmpRepo, "sub"));
writeFileSync(path.join(tmpRepo, "sub/inner.txt"), "x");

// Symlink that points outside the repo
try {
  symlinkSync(tmpdir(), path.join(tmpRepo, "escape"), "dir");
} catch {}

const safe = (input) => guard.assertSafeRepoPath(input, tmpRepo);

// Happy paths
ok("relative path resolves");
await safe("sub/inner.txt");
ok("plain filename resolves");
await safe("file.txt");

// Rejections per checklist
const root = tmpRepo;
for (const [input, label, code] of [
  ["", "empty path", "path-empty"],
  ["/", "absolute path", "path-absolute"],
  ["/etc/passwd", "absolute path 2", "path-absolute"],
  ["sub/../../escape", "traversal", "path-traversal"],
  ["foo/../../etc/passwd", "nested traversal", "path-traversal"],
  ["sub/inner.txt\0bad", "null byte", "path-null-byte"],
]) {
  throws(() => safe(input), code, `reject ${label} (${input})`);
}

// Symlink escape: the symlink at ${tmpRepo}/escape points to /tmp/
const safeAsync = async (input) => {
  try {
    await safe(input);
    bad(`symlink escape ${input}`, "expected throw");
  } catch (err) {
    if (err?.name === "GithubRefusedError" && err.code === "path-symlink-escape") {
      ok(`reject symlink escape (${input})`);
    } else {
      bad(`symlink escape ${input}`, `wrong error: ${err?.code} ${err?.message}`);
    }
  }
};
if (process.platform !== "win32") {
  await safeAsync("escape");
} else {
  console.log("  SKIP  symlink escape (Windows: dir symlink needs elevation)");
}

rmSync(tmpRepo, { recursive: true, force: true });

/* ============================================================== */
/*  assertAllowlisted                                              */
/* ============================================================== */

console.log("\n--- assertAllowlisted ---");

const allowCfg = {
  allowlistPaths: ["public/data.json"],
  denylistPaths: [".github/workflows/**", "schema/**", "AGENTS.md", "README.md"],
};

// Happy path
guard.assertAllowlisted("public/data.json", allowCfg);
ok("allowlisted path passes");

// Denylist matches
for (const [p, label] of [
  [".github/workflows/ci.yml", "denylist exact"],
  [".github/workflows/sub/dir/x.yml", "denylist **"],
  ["schema/main.json", "denylist dir"],
  ["AGENTS.md", "denylist exact file"],
]) {
  throws(
    () => guard.assertAllowlisted(p, allowCfg),
    "denylisted",
    `deny-match rejects ${label} (${p})`
  );
}

// Not allowlisted
throws(
  () => guard.assertAllowlisted("package.json", allowCfg),
  "not-allowlisted",
  "non-allowlisted path rejected"
);

// Deny > Allow: AGENTS.md is in denylist AND not in allowlist
throws(
  () => guard.assertAllowlisted("AGENTS.md", allowCfg),
  "denylisted",
  "deny wins over allow (AGENTS.md)"
);

// Empty allowlist = closed by default
const emptyCfg = { allowlistPaths: [], denylistPaths: [] };
throws(
  () => guard.assertAllowlisted("anything.txt", emptyCfg),
  "no-allowlist",
  "empty allowlist refused"
);

// Glob match
eq(
  guard.matchGlob("public/data.json", "public/data.json"),
  true,
  "exact match"
);
eq(
  guard.matchGlob("public/data.json", "public/other.json"),
  false,
  "exact miss"
);
eq(
  guard.matchGlob("schema/**", "schema/main.json"),
  true,
  "** mid-path"
);
eq(
  guard.matchGlob("schema/**", "schema/sub/dir/x.json"),
  true,
  "** deep"
);
eq(
  guard.matchGlob("**", "anything.txt"),
  true,
  "** bare",
);
eq(
  guard.matchGlob("foo/*/bar", "foo/x/bar"),
  true,
  "* single seg"
);
eq(
  guard.matchGlob("foo/*/bar", "foo/x/y/bar"),
  false,
  "* no cross"
);

/* ============================================================== */
/*  assertBranchPrefix                                             */
/* ============================================================== */

console.log("\n--- assertBranchPrefix ---");

const branchCfg = { prefix: "content/", baseBranch: "main" };

eq(guard.assertBranchPrefix("content/2025-01-12-news", branchCfg), "content/2025-01-12-news", "valid prefix passes");
eq(guard.assertBranchPrefix("content/x.y.z_a-b", branchCfg), "content/x.y.z_a-b", "valid chars");

for (const [name, label, code] of [
  ["", "empty", "branch-empty"],
  ["main", "equals base", "branch-is-base"],
  ["main/anything", "nested under base", "branch-is-base-subpath"],
  ["feature/2025", "wrong prefix", "branch-prefix-mismatch"],
  ["refs/heads/main", "refs/ prefix", "branch-ref-prefix"],
  ["HEAD", "HEAD literal", "branch-ref-prefix"],
  ["content/../escape", "double dot", "branch-double-dot"],
  ["content/with space", "space", "branch-chars"],
]) {
  throws(
    () => guard.assertBranchPrefix(name, branchCfg),
    code,
    `reject ${label} (${name})`
  );
}

/* ============================================================== */
/*  detectTokens / assertNoTokens                                 */
/* ============================================================== */

console.log("\n--- detectTokens ---");

const tokCases = [
  ["clean commit message", "fix: typo in comment", []],
  ["github classic PAT", "token=gho_abc123def456ghi789jkl012mno345pqr", ["gho_abc123def456ghi789jkl012mno345pqr"]],
  ["github fine-grained PAT", "secret is github_pat_11ABCDEFG0_abc123def456ghi789jkl012mno345pqr678st", ["github_pat_11ABCDEFG0_abc123def456ghi789jkl012mno345pqr678st"]],
  ["bearer header", "Authorization: Bearer ghs_abcdefghijklmnopqrstuvwxyz0123456789", ["Bearer ghs_abcdefghijklmnopqrstuvwxyz0123456789"]],
  ["api_key", "API_KEY=sk-1234567890abcdef1234567890abcdef", ["API_KEY=sk-1234567890abcdef1234567890abcdef"]],
  ["secret", "client_secret=xxx_abc123def456ghi789jkl012", ["client_secret=xxx_abc123def456ghi789jkl012"]],
];

for (const [label, input, expectedLen] of tokCases) {
  const hits = guard.detectTokens(input);
  if (expectedLen.length === 0) {
    if (hits.length === 0) ok(`detectTokens: ${label}`);
    else bad(`detectTokens: ${label}`, `expected 0 hits, got ${hits.length}: ${hits.join(", ")}`);
  } else {
    if (hits.length >= 1) ok(`detectTokens: ${label}`);
    else bad(`detectTokens: ${label}`, `expected hits, got 0`);
  }
}

console.log("\n--- assertNoTokens ---");

truthy(guard.assertNoTokens("fix: typo in comment", "commit_message"), "clean commit passes");
throws(
  () => guard.assertNoTokens("gho_abc123def456ghi789jkl012mno345pqr", "commit_message"),
  "token-in-string",
  "PAT in commit_message refused"
);
throws(
  () => guard.assertNoTokens("uses Bearer ghs_abcdefghijklmnopqrstuvwxyz0123456789 to auth", "pr_body"),
  "token-in-string",
  "Bearer in pr_body refused"
);

/* ============================================================== */
/*  redactTokens                                                   */
/* ============================================================== */

console.log("\n--- redactTokens ---");

eq(
  // Two regexes fire in sequence:
  //   1. /(authorization)\s*[:=]\s*[A-Za-z0-9._-]+/ matches
  //      "Authorization: Bearer" (Bearer is itself a valid value
  //      token) -> "[REDACTED]"
  //   2. /gh[oprsu]_[A-Za-z0-9]{20,}/ then matches the leftover
  //      "ghs_..." -> "[REDACTED]"
  // Net result is two [REDACTED] markers. Both are unambiguous.
  guard.redactTokens("Authorization: Bearer ghs_abcdefghijklmnopqrstuvwxyz0123456789"),
  "[REDACTED] [REDACTED]",
  "Authorization + Bearer both redacted"
);
eq(
  guard.redactTokens("token=gho_abc123def456ghi789jkl012mno345pqr is set"),
  "token=[REDACTED] is set",
  "PAT redacted"
);
eq(
  guard.redactTokens("clean log line"),
  "clean log line",
  "clean unchanged"
);

/* ============================================================== */
/*  size limits                                                    */
/* ============================================================== */

console.log("\n--- size limits ---");

truthy(guard.assertWithinLimit("hi", 100, "msg"), "small string passes");
throws(
  () => guard.assertWithinLimit("x".repeat(101), 100, "msg"),
  "size-limit",
  "over-limit refused"
);

eq(guard.LIMITS.READ_MAX_BYTES, 100 * 1024, "READ_MAX_BYTES = 100 KiB");
eq(guard.LIMITS.COMMIT_MESSAGE_SUBJECT_MAX_CHARS, 72, "subject max = 72 chars");
eq(guard.LIMITS.EDITS_PER_COMMIT_MAX, 5, "max 5 edits per commit");
eq(guard.LIMITS.COMMIT_MESSAGE_MAX_BYTES, 64 * 1024, "commit message max = 64 KiB");

// Regression for the 0.8.0 report (2026-10-29): the target repository's
// op-log has to declare a new top-level object in full, so the message is
// several KB. With a 500-byte cap the agent could only have fabricated the
// log or refused — it refused.
const newOpsObject = {
  ops: Array.from({ length: 8 }, (_, t) => ({
    id: `t${t}`,
    name: `Team ${t}`,
    players: Array.from({ length: 4 }, (_, p) => ({
      id: `p${t}${p}`,
      handle: `player-${t}-${p}`,
      streaming: false,
    })),
  })),
};
const opLogMessage = [
  "content: ops 新增 ops 顶层对象",
  "",
  "````json",
  JSON.stringify(
    {
      operator: "weunimix",
      timestamp: "2026-10-29T00:00:00Z",
      changes: [{ field: "ops", from: null, to: newOpsObject }],
    },
    null,
    2
  ),
  "````",
].join("\n");
truthy(
  Buffer.byteLength(opLogMessage) > 2000,
  `op-log fixture is ${Buffer.byteLength(opLogMessage)} bytes — the size that used to be refused`
);
truthy(
  guard.assertWithinLimit(opLogMessage, guard.LIMITS.COMMIT_MESSAGE_MAX_BYTES, "commit_message"),
  "a full from:null → to:{...} op-log fits"
);

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);