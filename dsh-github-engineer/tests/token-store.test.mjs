#!/usr/bin/env node
// tests/token-store.test.mjs
//
// Token store unit tests. Runs without hitting GitHub or DSH.
// Uses a temp file path via DSH_GITHUB_ENGINEER_CONFIG override.
//
// Run: node tests/token-store.test.mjs

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Set up an isolated temp config path before importing the store.
const tempDir = mkdtempSync(path.join(tmpdir(), "dsh-github-engineer-test-"));
process.env.DSH_GITHUB_ENGINEER_CONFIG = path.join(tempDir, "tokens.json");

const { TokenStore } = await import(
  pathToUrl(path.join(ROOT, "lib", "index.js"))
);

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
function eq(actual, want, hint) {
  if (actual === want) ok(`${hint} = ${JSON.stringify(want)}`);
  else bad(`${hint}`, `expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
}
function truthy(value, hint) {
  if (value) ok(`${hint} is truthy`);
  else bad(`${hint}`, "expected truthy, got " + JSON.stringify(value));
}

async function test(name, fn) {
  console.log(`\n--- ${name} ---`);
  await fn();
}

// Test 1: empty store → defaults.
await test("empty store returns defaults", async () => {
  const s = new TokenStore();
  const v = await s.view();
  eq(v.configured, false, "configured");
  eq(v.hasAccessToken, false, "hasAccessToken");
  eq(v.hasRefreshToken, false, "hasRefreshToken");
  eq(v.accessTokenExpiresAt, 0, "accessTokenExpiresAt");
  eq(v.refreshTokenExpiresAt, 0, "refreshTokenExpiresAt");
  eq(v.scope, "", "scope");
  eq(v.login, "", "login");
  eq(v.tokenUpdatedAt, "", "tokenUpdatedAt");
});

// Test 2: saveTokens writes the right file (mode 0600).
await test("saveTokens writes JSON with correct fields + file mode", async () => {
  const s = new TokenStore();
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  const refreshExpiresAt = Date.now() + 180 * 24 * 60 * 60 * 1000;
  await s.saveTokens({
    access_token: "gho_test1234567890abcdef",
    refresh_token: "ghr_test1234567890abcdef",
    expires_in: 8 * 60 * 60,
    refresh_token_expires_in: 180 * 24 * 60 * 60,
    scope: "repo workflow offline_access",
    login: "weunimix",
  });

  truthy(existsSync(process.env.DSH_GITHUB_ENGINEER_CONFIG), "config file exists");
  const json = JSON.parse(readFileSync(process.env.DSH_GITHUB_ENGINEER_CONFIG, "utf8"));
  eq(json.accessToken, "gho_test1234567890abcdef", "accessToken on disk");
  eq(json.refreshToken, "ghr_test1234567890abcdef", "refreshToken on disk");
  truthy(json.accessTokenExpiresAt > expiresAt - 5000, "accessTokenExpiresAt near +8h");
  truthy(json.accessTokenExpiresAt < expiresAt + 5000, "accessTokenExpiresAt within 5s");
  truthy(json.refreshTokenExpiresAt > refreshExpiresAt - 5000, "refreshTokenExpiresAt near +180d");
  eq(json.scope, "repo workflow offline_access", "scope");
  eq(json.login, "weunimix", "login");
  truthy(typeof json.tokenUpdatedAt === "string" && json.tokenUpdatedAt.length > 0, "tokenUpdatedAt non-empty");

  // Check file mode on POSIX systems.
  if (process.platform !== "win32") {
    const stat = readFileSync(process.env.DSH_GITHUB_ENGINEER_CONFIG).toString();
    // fs.statSync would be cleaner but we don't want to require the fs module at top.
    const { statSync } = await import("node:fs");
    const mode = statSync(process.env.DSH_GITHUB_ENGINEER_CONFIG).mode & 0o777;
    eq(mode, 0o600, "file mode");
  }
});

// Test 3: view() masks secrets.
await test("view masks secrets", async () => {
  const s = new TokenStore();
  await s.saveTokens({
    access_token: "gho_abcd1234efgh5678",
    refresh_token: "ghr_1234567890abcdef",
    expires_in: 3600,
    scope: "repo",
  });
  const v = await s.view();
  eq(v.configured, true, "configured");
  eq(v.hasAccessToken, true, "hasAccessToken");
  // Mask format: head + "****" + tail → "gho_****5678"
  if (v.accessTokenMasked.includes("abcd1234efgh")) bad("mask", "head leaked: " + v.accessTokenMasked);
  else if (!v.accessTokenMasked.includes("5678")) bad("mask", "tail missing: " + v.accessTokenMasked);
  else ok(`masked access token = ${v.accessTokenMasked}`);
});

// Test 4: clearAll erases everything.
await test("clearAll empties the store", async () => {
  const s = new TokenStore();
  await s.saveTokens({
    access_token: "gho_xxx",
    refresh_token: "ghr_xxx",
  });
  await s.clearAll();
  const v = await s.view();
  eq(v.configured, false, "configured after clear");
  eq(v.hasAccessToken, false, "hasAccessToken after clear");
  eq(v.hasRefreshToken, false, "hasRefreshToken after clear");
});

// Test 5: missing fields in JSON are tolerated on read.
await test("read tolerates missing fields", async () => {
  const fs = await import("node:fs/promises");
  await fs.writeFile(process.env.DSH_GITHUB_ENGINEER_CONFIG, JSON.stringify({}), {
    mode: 0o600,
  });
  const s = new TokenStore();
  const v = await s.view();
  eq(v.configured, false, "configured");
  eq(v.scope, "", "scope");
});

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

// Cleanup.
try {
  rmSync(tempDir, { recursive: true, force: true });
} catch {}

function pathToUrl(p) {
  // Convert a Windows path to a file:// URL for dynamic import.
  return "file:///" + p.replace(/\\/g, "/");
}