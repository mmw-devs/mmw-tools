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

/* ---------- compile .npmignore rules ---------- */

function loadIgnoreRules() {
  const file = path.join(ROOT, ".npmignore");
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

const rules = loadIgnoreRules();

/** Match a posix relative path against the ignore rules. */
function ignored(relPath) {
  const segments = relPath.split("/");
  for (const { pattern, dirOnly } of rules) {
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
  ".dsh-github-engineer.json",
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
