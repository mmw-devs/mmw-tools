#!/usr/bin/env node
/**
 * scripts/check-pack-contents.mjs
 *
 * Offline stand-in for `npm pack --dry-run`.
 *
 * npm decides the tarball from `files` (allowlist) plus `.npmignore`
 * (denylist), and — the trap this checks for — falls back to
 * `.gitignore` when `.npmignore` is missing. `.gitignore` excludes
 * `lib/`, so without a `.npmignore` the published package would ship
 * without the bundle it exists to provide.
 *
 * Run from the plugin root:  node scripts/check-pack-contents.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function fail(msg) {
  console.error(`  FAIL  ${msg}`);
  process.exitCode = 1;
}
function pass(msg) {
  console.log(`  PASS  ${msg}`);
}

/* ---------- load manifest ---------- */

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const files = pkg.files ?? [];
if (files.length === 0) {
  console.error("no `files` field in package.json — the tarball would be governed by .npmignore alone");
  process.exit(2);
}

if (!existsSync(path.join(ROOT, ".npmignore"))) {
  fail(".npmignore is missing — npm would fall back to .gitignore, which excludes lib/");
}

/* ---------- nested ignore files ---------- */

/*
 * npm-packlist applies ignore rules per directory: a directory with a
 * `.npmignore` uses it, and a directory without one falls back to its
 * `.gitignore`. `mcp-server/.gitignore` excludes `dist/`, so before
 * `mcp-server/.npmignore` existed the tarball shipped no compiled MCP
 * entry point — the package installed "successfully" and then had no
 * tools, because the spawned `mcp-server/dist/index.js` was absent.
 *
 * This checker walks `files` with the root rules only, which cannot see
 * that fallback, so it asserts the nested file directly.
 */
const MCP_DIR = path.join(ROOT, "mcp-server");
const MCP_NPMIGNORE = path.join(MCP_DIR, ".npmignore");

console.log("\n--- nested ignore rules ---");
if (!existsSync(MCP_NPMIGNORE)) {
  fail(
    "mcp-server/.npmignore is missing — npm would fall back to mcp-server/.gitignore, " +
      "which excludes dist/, so mcp-server/dist/index.js would not ship"
  );
} else {
  const nested = readFileSync(MCP_NPMIGNORE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => l.replace(/\/+$/, "").replace(/^!/, ""));
  if (nested.some((p) => p === "dist" || p === "dist/**" || p === "/dist")) {
    fail("mcp-server/.npmignore excludes dist/ — the compiled MCP entry would not ship");
  } else {
    pass("mcp-server/.npmignore keeps dist/ packable");
  }
}

/* ---------- compile .npmignore rules ---------- */

function loadIgnoreRules(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((pattern) => {
      const dirOnly = pattern.endsWith("/");
      const p = pattern.replace(/\/+$/, "").replace(/^\//, "");
      return { pattern: p, dirOnly };
    });
}

const rules = loadIgnoreRules(path.join(ROOT, ".npmignore"));
const mcpRules = loadIgnoreRules(MCP_NPMIGNORE);

/** Match a posix relative path against a set of ignore rules. */
function matches(ruleList, relPath) {
  const segments = relPath.split("/");
  for (const { pattern, dirOnly } of ruleList) {
    // Exact file match.
    if (!dirOnly && (pattern === relPath || segments[segments.length - 1] === pattern)) {
      return true;
    }
    // Directory prefix match: `src/` excludes `src/anything`.
    if (segments[0] === pattern || relPath === pattern) return true;
    if (segments.includes(pattern)) return true;
    // Extension match: `*.tsbuildinfo`
    if (pattern.startsWith("*.") && relPath.endsWith(pattern.slice(1))) return true;
  }
  return false;
}

/**
 * npm applies a directory's own `.npmignore` to that subtree; the root file
 * does not reach into it. Mirror that, or the walker would claim a path is
 * excluded while `npm pack` ships it.
 */
function ignored(relPath) {
  if (relPath === "mcp-server" || relPath.startsWith("mcp-server/")) {
    return matches(mcpRules, relPath.slice("mcp-server/".length));
  }
  return matches(rules, relPath);
}

/* ---------- walk the allowlist ---------- */

function walk(absPath, relPath, out) {
  const info = statSync(absPath);
  if (info.isDirectory()) {
    for (const name of readdirSync(absPath)) {
      if (name === "node_modules") continue;
      const childAbs = path.join(absPath, name);
      const childRel = relPath === "" ? name : `${relPath}/${name}`;
      if (ignored(childRel) || ignored(childRel + "/")) continue;
      walk(childAbs, childRel, out);
    }
    return;
  }
  out.push(relPath);
}

const included = [];
for (const entry of files) {
  const abs = path.join(ROOT, entry);
  if (!existsSync(abs)) {
    fail(`\`files\` declares ${entry} but it does not exist`);
    continue;
  }
  if (ignored(entry)) continue;
  walk(abs, entry, included);
}

/* ---------- assertions ---------- */

const REQUIRED = [
  "lib/index.js",
  "lib/client.js",
  "mcp-server/dist/index.js",
  "cordis.patch.yml",
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
];

/** npm always packs these regardless of `files` / ignore rules. */
const ALWAYS_PACKED = ["package.json"];

const FORBIDDEN = [
  "src/index.ts",
  "tests/token-store.test.mjs",
  "client-build/api.js",
  "mcp-server/src/index.ts",
  ".dsh-mmw-tools.json",
];

console.log("\n--- required files in the tarball ---");
for (const rel of REQUIRED) {
  if (included.includes(rel)) pass(rel);
  else fail(`${rel} is MISSING from the tarball`);
}
for (const rel of ALWAYS_PACKED) {
  if (existsSync(path.join(ROOT, rel))) pass(`${rel} (always packed by npm)`);
  else fail(`${rel} does not exist on disk`);
}

console.log("\n--- files that must not ship ---");
for (const rel of FORBIDDEN) {
  if (included.includes(rel)) fail(`${rel} would ship`);
  else pass(`${rel} excluded`);
}

/* ---------- summary ---------- */

const byTop = new Map();
for (const rel of included) {
  const top = rel.split("/")[0];
  byTop.set(top, (byTop.get(top) ?? 0) + 1);
}
console.log(`\n${included.length} files would be included:`);
for (const [top, n] of [...byTop.entries()].sort()) {
  console.log(`  ${top.padEnd(20)} ${n}`);
}

if (process.exitCode === 1) {
  console.error("\npack contents check FAILED");
} else {
  console.log("\npack contents check OK");
}
