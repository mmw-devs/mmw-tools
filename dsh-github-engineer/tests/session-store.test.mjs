#!/usr/bin/env node
/**
 * tests/session-store.test.mjs
 *
 * The session store holds a broker session token and nothing else. These
 * assertions are mostly about what it refuses to hold or trust: a corrupt
 * file, a missing token, an expired record, a file with loose permissions.
 */

import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, "..", "lib", "auth", "session-store.js");
const { SessionStore, maskToken, sessionPath } = await import(pathToFileURL(LIB).href);

let pass = 0;
let fail = 0;
const ok = (l) => {
  pass++;
  console.log(`  PASS  ${l}`);
};
const bad = (l, d) => {
  fail++;
  console.error(`  FAIL  ${l}${d ? `: ${d}` : ""}`);
};
function eq(actual, want, label) {
  if (actual === want) ok(`${label} = ${JSON.stringify(want)}`);
  else bad(label, `expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
}
function truthy(v, label, detail) {
  if (v) ok(label);
  else bad(label, detail ?? "expected truthy");
}

const dir = mkdtempSync(path.join(tmpdir(), "dsh-session-"));
const file = path.join(dir, "session.json");
const NOW = 1_800_000_000_000;

console.log("\n--- empty store ---");
{
  const store = new SessionStore({ file });
  eq(await store.read(), null, "read returns null when the file is absent");
  eq(await store.readValid(NOW), null, "readValid returns null");
  const d = await store.describe(NOW);
  eq(d.signedIn, false, "describe reports signed out");
  eq(d.sessionTokenMasked, "", "no masked token to show");
}

console.log("\n--- save / read round trip ---");
{
  const store = new SessionStore({ file });
  await store.save({
    sessionToken: "sess_abcdefghijklmnop",
    login: "octocat",
    expiresAt: NOW + 12 * 3600 * 1000,
    brokerUrl: "https://broker.example.com",
    updatedAt: NOW,
  });

  const rec = await store.read();
  eq(rec?.login, "octocat", "login round trips");
  eq(rec?.brokerUrl, "https://broker.example.com", "brokerUrl round trips");
  eq(rec?.sessionToken, "sess_abcdefghijklmnop", "token round trips");

  const d = await store.describe(NOW);
  eq(d.signedIn, true, "describe reports signed in");
  eq(d.login, "octocat", "describe shows the login");
  eq(d.secondsRemaining, 12 * 3600, "describe reports 12 hours left");
  truthy(
    d.sessionTokenMasked.startsWith("sess") && !d.sessionTokenMasked.includes("efghij"),
    "describe masks the middle of the token"
  );

  if (process.platform !== "win32") {
    const mode = statSync(file).mode & 0o777;
    eq(mode, 0o600, "file is mode 0600");
  } else {
    ok("mode check skipped on Windows");
  }
}

console.log("\n--- expiry ---");
{
  const store = new SessionStore({ file });
  await store.save({
    sessionToken: "sess_expired_token",
    login: "octocat",
    expiresAt: NOW - 1,
    brokerUrl: "https://broker.example.com",
    updatedAt: NOW - 1000,
  });
  eq(await store.readValid(NOW), null, "readValid refuses an expired record");
  const d = await store.describe(NOW);
  eq(d.signedIn, false, "describe reports signed out when expired");
  eq(d.login, "octocat", "but it still shows who had signed in");
  eq(d.secondsRemaining, 0, "remaining seconds floor at zero");
}

console.log("\n--- refuses a corrupt or partial file ---");
{
  writeFileSync(file, "{not json", "utf8");
  eq(await new SessionStore({ file }).read(), null, "invalid JSON reads as null");

  writeFileSync(file, JSON.stringify({ login: "x", expiresAt: NOW }), "utf8");
  eq(await new SessionStore({ file }).read(), null, "a record without a token is null");

  writeFileSync(file, JSON.stringify({ sessionToken: "", expiresAt: NOW }), "utf8");
  eq(await new SessionStore({ file }).read(), null, "an empty token is null");

  writeFileSync(file, JSON.stringify({ sessionToken: "t", expiresAt: "soon" }), "utf8");
  eq(await new SessionStore({ file }).read(), null, "a non-numeric expiry is null");
}

console.log("\n--- clear ---");
{
  const store = new SessionStore({ file });
  await store.save({
    sessionToken: "sess_t",
    login: "octocat",
    expiresAt: NOW + 1000,
    brokerUrl: "https://b",
    updatedAt: NOW,
  });
  await store.clear();
  eq(await store.read(), null, "clear removes the record");
  await store.clear();
  ok("clearing twice is not an error");
}

console.log("\n--- maskToken ---");
{
  eq(maskToken(""), "", "empty stays empty");
  eq(maskToken("short"), "*****", "short tokens are fully masked");
  eq(maskToken("0123456789ab"), "************", "12 chars is still fully masked");
  eq(maskToken("0123456789abc"), "0123…9abc", "13+ chars keep four on each side");
}

console.log("\n--- path override ---");
{
  const previous = process.env.DSH_GITHUB_ENGINEER_SESSION;
  process.env.DSH_GITHUB_ENGINEER_SESSION = file;
  eq(sessionPath(), file, "env var overrides the default path");
  if (previous === undefined) delete process.env.DSH_GITHUB_ENGINEER_SESSION;
  else process.env.DSH_GITHUB_ENGINEER_SESSION = previous;
  truthy(sessionPath().endsWith("dsh-github-engineer-session.json"), "default path names the session file");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
