#!/usr/bin/env node
// tests/broker-auth.test.mjs
//
// The broker decides which repository an installation token can write to;
// this plugin decides which repository it edits. They are configured in two
// different places, so BrokerAuth compares them when a token is minted.
//
// Without that check a drifted deployment fails much later, as a bare 403 in
// the middle of an edit.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = async (rel) => import(pathToFileURL(path.join(ROOT, "lib", rel)).href);

const { BrokerAuth } = await load("auth/broker-auth.js");
const { SessionStore } = await load("auth/session-store.js");
const { BrokerError } = await load("auth/broker-client.js");

let pass = 0;
let fail = 0;
const ok = (l) => { pass++; console.log(`  PASS  ${l}`); };
const bad = (l, d) => { fail++; console.error(`  FAIL  ${l}${d ? `: ${d}` : ""}`); };
const eq = (a, w, label) => (a === w ? ok(`${label} = ${JSON.stringify(w)}`) : bad(label, `expected ${JSON.stringify(w)}, got ${JSON.stringify(a)}`));
const truthy = (v, label) => (v ? ok(label) : bad(label, "expected truthy"));

const NOW = 1_800_000_000_000;
const work = mkdtempSync(path.join(tmpdir(), "mmw-broker-auth-"));
const sessionFile = path.join(work, "session.json");
const tokenFile = path.join(work, "installation.json");

async function makeAuth({
  repository,
  issuedRepository,
  feishu,
  session = true,
  broker: brokerOverrides,
} = {}) {
  const store = new SessionStore({ file: sessionFile });
  await store.clear();
  if (session) {
    await store.save({
      sessionToken: "session-token",
      login: "operator",
      expiresAt: NOW + 6 * 3600 * 1000,
      brokerUrl: "",
      updatedAt: NOW,
    });
  }
  if (existsSync(tokenFile)) rmSync(tokenFile);
  const broker = {
    getInstallationToken: async () => ({
      token: "ghs_installation_token",
      expiresAt: NOW + 3600 * 1000,
      repository: issuedRepository,
      permissions: { contents: "write" },
    }),
    ...brokerOverrides,
  };
  const auth = new BrokerAuth({
    brokerUrl: "https://broker.example",
    installationTokenFile: tokenFile,
    repository,
    ...(feishu ? { feishu } : {}),
    store,
    broker,
    now: () => NOW,
  });
  return { auth, store };
}

console.log("\n--- the broker signs for another repository ---");
{
  const { auth } = await makeAuth({
    repository: "mmw-devs/ffxiv-race-ops",
    issuedRepository: "mmw-devs/some-other-repo",
  });
  let caught = null;
  try {
    await auth.ensureInstallationToken(true);
  } catch (err) {
    caught = err;
  }
  truthy(caught instanceof BrokerError, "mismatch throws a BrokerError");
  eq(caught?.code, "repo-mismatch", "error code names the cause");
  truthy(
    /some-other-repo/.test(caught?.message ?? "") && /ffxiv-race-ops/.test(caught?.message ?? ""),
    "the message names both repositories"
  );
  eq(existsSync(tokenFile), false, "no token file is written for a mismatched repository");

  const access = await auth.repoAccess();
  eq(access.state, "unavailable", "repo access reports unavailable rather than half-working");
  truthy(/repo-mismatch|some-other-repo/.test(access.reason), "and the reason is actionable");
}

console.log("\n--- the repositories agree ---");
{
  const { auth } = await makeAuth({
    repository: "mmw-devs/ffxiv-race-ops",
    issuedRepository: "mmw-devs/ffxiv-race-ops",
  });
  const token = await auth.ensureInstallationToken(true);
  eq(token, "ghs_installation_token", "the token is returned");
  truthy(existsSync(tokenFile), "the token file is written");
  const written = JSON.parse(readFileSync(tokenFile, "utf8"));
  eq(written.accessToken, "ghs_installation_token", "the child receives the token");
}

console.log("\n--- older broker / older config ---");
{
  const { auth } = await makeAuth({
    repository: "mmw-devs/ffxiv-race-ops",
    issuedRepository: "",
  });
  eq(await auth.ensureInstallationToken(true), "ghs_installation_token", "an empty repository field is tolerated");
}
{
  const { auth } = await makeAuth({ repository: "", issuedRepository: "mmw-devs/whatever" });
  eq(await auth.ensureInstallationToken(true), "ghs_installation_token", "no configured binding means nothing to compare");
}

console.log("\n--- a Feishu member with no GitHub session ---");
{
  const { auth } = await makeAuth({
    repository: "mmw-devs/ffxiv-race-ops",
    session: false,
    feishu: { credential: async () => "fs-token" },
    broker: {
      getInstallationTokenForFeishu: async (token) => {
        eq(token, "fs-token", "the plugin token is forwarded unchanged");
        return {
          token: "ghs_feishu_token",
          expiresAt: NOW + 3600 * 1000,
          repository: "mmw-devs/ffxiv-race-ops",
          permissions: { contents: "read", pull_requests: "read" },
          authMode: "feishu",
          login: "张三",
        };
      },
    },
  });

  eq(
    await auth.ensureInstallationToken(true),
    "ghs_feishu_token",
    "a Feishu login mints a token without any GitHub session"
  );
  truthy(existsSync(tokenFile), "the child receives the Feishu-scoped token");
  eq(await auth.phase(), "signed_in", "phase reports signed_in from Feishu alone");
  eq(await auth.resolvedStatus(), "authorized", "status is authorized without a GitHub session");
  const view = await auth.view();
  eq(view.mode, "feishu", "the view names the Feishu mode");
  eq(view.login, "张三", "the view carries the Feishu identity");
}

console.log("\n--- Feishu is preferred when both credentials exist ---");
{
  let github = 0;
  let feishu = 0;
  const { auth } = await makeAuth({
    repository: "mmw-devs/ffxiv-race-ops",
    issuedRepository: "mmw-devs/ffxiv-race-ops",
    feishu: { credential: async () => "fs-token" },
    broker: {
      getInstallationToken: async () => {
        github++;
        return {
          token: "ghs_github",
          expiresAt: NOW + 3600 * 1000,
          repository: "mmw-devs/ffxiv-race-ops",
          permissions: { contents: "write" },
          authMode: "github",
        };
      },
      getInstallationTokenForFeishu: async () => {
        feishu++;
        return {
          token: "ghs_feishu",
          expiresAt: NOW + 3600 * 1000,
          repository: "mmw-devs/ffxiv-race-ops",
          permissions: { contents: "write", pull_requests: "write" },
          authMode: "feishu",
          login: "张三",
        };
      },
    },
  });

  eq(await auth.ensureInstallationToken(true), "ghs_feishu", "the Feishu credential wins");
  eq(feishu, 1, "the Feishu path was used");
  eq(github, 0, "the GitHub session was not consulted");
}

console.log("\n--- a rejected Feishu token falls back to a valid GitHub session ---");
{
  let github = 0;
  const { auth } = await makeAuth({
    repository: "mmw-devs/ffxiv-race-ops",
    issuedRepository: "mmw-devs/ffxiv-race-ops",
    feishu: { credential: async () => "stale-feishu-token" },
    broker: {
      getInstallationToken: async () => {
        github++;
        return {
          token: "ghs_github_fallback",
          expiresAt: NOW + 3600 * 1000,
          repository: "mmw-devs/ffxiv-race-ops",
          permissions: { contents: "write" },
          authMode: "github",
        };
      },
      getInstallationTokenForFeishu: async () => {
        throw new BrokerError("session-rejected", "Feishu session expired", 401);
      },
    },
  });

  eq(
    await auth.ensureInstallationToken(true),
    "ghs_github_fallback",
    "the GitHub session still works when Feishu is stale"
  );
  eq(github, 1, "the fallback was used exactly once");
}

console.log("\n--- no credential at all ---");
{
  const { auth } = await makeAuth({
    repository: "mmw-devs/ffxiv-race-ops",
    session: false,
    feishu: { credential: async () => null },
  });
  eq(await auth.ensureInstallationToken(true), null, "no Feishu and no GitHub means no token");
  eq(await auth.phase(), "signed_out", "phase reports signed_out");
  eq(await auth.resolvedStatus(), "no_token", "status reports no_token");
  eq((await auth.view()).mode, "none", "the view names no mode");
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
