#!/usr/bin/env node
/**
 * broker/tests/core.test.mjs
 *
 * The broker decides who may obtain a write-capable token. These tests
 * drive that decision directly — no HTTP server, no network: GitHub is a
 * stub that records what was asked.
 *
 * Emphasis on the refusal paths and on revocation actually taking effect,
 * because those are the properties the design rests on.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(__dirname, "..", "core.mjs");
const {
  BrokerCore,
  BrokerRefused,
  safeEqual,
  parseRepoPolicy,
  validateRepoPolicy,
  extractCommands,
  evaluateMergeContract,
} = await import(pathToFileURL(CORE).href);

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
function eq(a, w, label) {
  if (a === w) ok(`${label} = ${JSON.stringify(w)}`);
  else bad(label, `expected ${JSON.stringify(w)}, got ${JSON.stringify(a)}`);
}
function truthy(v, label, detail) {
  if (v) ok(label);
  else bad(label, detail ?? "expected truthy");
}
async function rejectsWith(fn, code, label) {
  try {
    await fn();
    bad(label, `expected ${code}, resolved instead`);
  } catch (err) {
    if (err instanceof BrokerRefused && err.code === code) ok(`${label} (${code})`);
    else bad(label, `expected BrokerRefused ${code}, got ${err?.code ?? err?.message}`);
  }
}

/* ---------------- stubs ---------------- */

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * A fake GitHub: records calls, answers by URL. `membership` is mutable
 * so a test can revoke someone mid-flight.
 */
function fakeGithub({ login = "octocat", membership = "active" } = {}) {
  const calls = [];
  const state = { login, membership };
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/login/oauth/access_token")) {
      return json({ access_token: "user-token-abc", token_type: "bearer" });
    }
    if (String(url).endsWith("/user")) {
      return json({ login: state.login });
    }
    if (String(url).includes("/orgs/") && String(url).includes("/members/")) {
      // GitHub answers 204 with no body for a member, 404 otherwise.
      return state.membership === "none" ? json({ message: "Not Found" }, 404) : json({}, 204);
    }
    return json({ message: "unexpected" }, 500);
  };
  return { impl, calls, state };
}

const NOW = 1_800_000_000_000;
const PUB = "https://race-ops-broker.mmw-team.icu";

function makeCore(overrides = {}) {
  const gh = fakeGithub();
  const core = new BrokerCore({
    appId: 123456,
    privateKeyPem: "----- not used: minting is injected -----",
    installationId: 98765,
    clientId: "Iv1.client",
    clientSecret: "super-secret-value",
    publicUrl: PUB,
    owner: "mmw-devs",
    repo: "ffxiv-race-ops",
    org: "mmw-devs",
    allowMode: "org",
    fetchImpl: gh.impl,
    now: () => NOW,
    mintInstallationToken: async (opts = {}) => ({
      token: "ghs_installation",
      expiresAt: NOW + 3_600_000,
      permissions: opts.permissions ?? { contents: "write", pull_requests: "write" },
    }),
    ...overrides,
  });
  return { core, gh };
}

/* ============================================================== */
console.log("\n--- constructor ---");
{
  let caught = null;
  try {
    new BrokerCore({ appId: 1 });
  } catch (err) {
    caught = err;
  }
  truthy(/missing/.test(caught?.message ?? ""), "refuses an incomplete config");

  caught = null;
  try {
    makeCore({ publicUrl: "http://insecure.example" });
  } catch (err) {
    caught = err;
  }
  truthy(/https/.test(caught?.message ?? ""), "refuses a non-HTTPS publicUrl (GitHub requires it)");

  const { core } = makeCore();
  eq(core.repository, "mmw-devs/ffxiv-race-ops", "repository derived from owner/repo");
  eq(core.callbackUrl(), `${PUB}/auth/github/callback`, "callback URL");
}

console.log("\n--- startSession / authorizeUrl ---");
{
  const { core } = makeCore();
  const started = core.startSession();
  truthy(started.state.length >= 20, "state is long enough to be unguessable");
  truthy(started.pollSecret.length >= 20, "pollSecret is long enough");
  truthy(started.state !== started.pollSecret, "state and pollSecret are distinct");
  truthy(started.loginUrl.startsWith(PUB), "loginUrl points at the broker");
  eq(started.expiresAt, NOW + 5 * 60 * 1000, "state expires in 5 minutes");

  const url = new URL(core.authorizeUrl(started.state));
  eq(url.origin + url.pathname, "https://github.com/login/oauth/authorize", "authorize endpoint");
  eq(url.searchParams.get("client_id"), "Iv1.client", "client_id is the App's");
  eq(url.searchParams.get("state"), started.state, "state is carried");
  eq(url.searchParams.get("redirect_uri"), `${PUB}/auth/github/callback`, "redirect_uri is the broker callback");
  eq(url.searchParams.get("scope"), null, "no scope is requested (App permissions govern)");

  await rejectsWith(async () => core.authorizeUrl("nope"), "state-unknown", "an unknown state has no authorize URL");
}

console.log("\n--- completeLogin: happy path ---");
{
  const { core, gh } = makeCore();
  const { state, pollSecret } = core.startSession();

  const res = await core.completeLogin({ code: "the-code", state });
  eq(res.login, "octocat", "login returned");
  truthy(res.sessionToken.length >= 20, "session token issued");
  eq(res.expiresAt, NOW + 12 * 3600 * 1000, "session lives 12 hours");

  const tokenCall = gh.calls.find((c) => c.url.includes("/login/oauth/access_token"));
  truthy(Boolean(tokenCall), "the code was exchanged");
  truthy(
    String(tokenCall.init.body).includes("super-secret-value"),
    "the exchange sent the client secret to GitHub (server-to-server only)"
  );
  truthy(
    !String(tokenCall.init.body).includes("super-secret-value") === false,
    "the client secret is only sent in the POST body"
  );

  const first = core.poll(state, pollSecret);
  eq(first.status, "authorized", "poll reports authorized");
  eq(first.sessionToken, res.sessionToken, "poll returns the session token");
  const second = core.poll(state, pollSecret);
  eq(second.status, "expired", "the state is burned after it hands out the token");
}

console.log("\n--- completeLogin: refusals ---");
{
  const { core } = makeCore();
  await rejectsWith(() => core.completeLogin({ code: "c", state: "missing" }), "state-unknown", "unknown state");

  const { state } = core.startSession();
  await core.completeLogin({ code: "c", state });
  await rejectsWith(() => core.completeLogin({ code: "c", state }), "state-used", "a state cannot be replayed");

  const fresh = core.startSession();
  await rejectsWith(() => core.completeLogin({ code: "", state: fresh.state }), "code-missing", "a missing code is refused");
}

{
  const { core } = makeCore();
  const { state } = core.startSession();
  const gh = fakeGithub({ membership: "none" });
  const c2 = new BrokerCore({
    appId: 1,
    privateKeyPem: "x",
    installationId: 1,
    clientId: "c",
    clientSecret: "s",
    publicUrl: PUB,
    owner: "mmw-devs",
    repo: "ffxiv-race-ops",
    fetchImpl: gh.impl,
    now: () => NOW,
    // The membership check uses an installation token, so this core needs
    // a mint too - otherwise it tries to sign a real JWT with the fake key.
    mintInstallationToken: async () => ({
      token: "ghs_check",
      expiresAt: NOW + 3_600_000,
      permissions: {},
    }),
  });
  const started = c2.startSession();
  await rejectsWith(() => c2.completeLogin({ code: "c", state: started.state }), "not-allowed", "a non-member is refused");
  const polled = c2.poll(started.state, started.pollSecret);
  eq(polled.status, "denied", "the poller learns it was denied");
  truthy(/not-a-member/.test(polled.reason ?? ""), "the denial reason names the org");
  eq(c2.stats().activeSessions, 0, "no session was created for the denied user");
}

console.log("\n--- allowlist modes ---");
{
  const { core } = makeCore({ allowMode: "list", allowList: ["OctoCat"] });
  const { state } = core.startSession();
  const res = await core.completeLogin({ code: "c", state });
  eq(res.login, "octocat", "list mode matches case-insensitively");
}
{
  const { core } = makeCore({ allowMode: "list", allowList: ["someone-else"] });
  const { state } = core.startSession();
  await rejectsWith(() => core.completeLogin({ code: "c", state }), "not-allowed", "list mode refuses a stranger");
}
{
  const { core } = makeCore({ allowMode: "list", allowList: ["octocat"], denyList: ["octocat"] });
  const { state } = core.startSession();
  await rejectsWith(
    () => core.completeLogin({ code: "c", state }),
    "not-allowed",
    "the deny list wins over the allow list"
  );
}

console.log("\n--- an explicit allowlist admits outsiders in org mode ---");
{
  // The whole point of the broker: an outsider proves identity, the App
  // installation supplies the repository write. Requiring org membership
  // made an invited outsider unable to log in at all.
  const gh = fakeGithub({ login: "outsider", membership: "none" });
  const core = new BrokerCore({
    appId: 1,
    privateKeyPem: "x",
    installationId: 1,
    clientId: "c",
    clientSecret: "s",
    publicUrl: PUB,
    owner: "mmw-devs",
    repo: "ffxiv-race-ops",
    allowMode: "org",
    allowList: ["Outsider"],
    fetchImpl: gh.impl,
    now: () => NOW,
    mintInstallationToken: async () => ({
      token: "ghs_outsider",
      expiresAt: NOW + 3_600_000,
      permissions: { contents: "write" },
    }),
  });

  const started = core.startSession();
  const res = await core.completeLogin({ code: "c", state: started.state });
  eq(res.login, "outsider", "an allowlisted non-member signs in under org mode");
  eq(core.poll(started.state, started.pollSecret).status, "authorized", "and receives a session");
  eq(
    gh.calls.filter((c) => c.url.includes("/orgs/")).length,
    0,
    "no org membership call is made for an allowlisted user"
  );

  // The same verdict has to hold at mint time: this is where a session
  // actually becomes repository write access.
  const minted = await core.issueInstallationToken(res.sessionToken);
  eq(minted.token, "ghs_outsider", "the outsider can mint an installation token");
  eq(core.stats().activeSessions, 1, "the allowlisted session stays active");
}
{
  const { core } = makeCore({ allowList: ["someone-else"] });
  const { state } = core.startSession();
  const res = await core.completeLogin({ code: "c", state });
  eq(res.login, "octocat", "org members still sign in when an allowlist exists");
}
{
  const gh = fakeGithub({ login: "outsider", membership: "none" });
  const core = new BrokerCore({
    appId: 1,
    privateKeyPem: "x",
    installationId: 1,
    clientId: "c",
    clientSecret: "s",
    publicUrl: PUB,
    owner: "mmw-devs",
    repo: "ffxiv-race-ops",
    allowMode: "org",
    allowList: ["outsider"],
    denyList: ["outsider"],
    fetchImpl: gh.impl,
    now: () => NOW,
    mintInstallationToken: async () => ({ token: "x", expiresAt: NOW + 3_600_000, permissions: {} }),
  });
  const { state } = core.startSession();
  await rejectsWith(
    () => core.completeLogin({ code: "c", state }),
    "not-allowed",
    "the deny list still wins over the explicit allowlist"
  );
}

console.log("\n--- adding a name takes effect on the next attempt ---");
{
  // A failed attempt caches a refusal. If the explicit grant were evaluated
  // after the cache, the operator would add the name and still watch the
  // user be refused for ten minutes - indistinguishable from a broken deploy.
  const gh = fakeGithub({ login: "outsider", membership: "none" });
  const core = new BrokerCore({
    appId: 1,
    privateKeyPem: "x",
    installationId: 1,
    clientId: "c",
    clientSecret: "s",
    publicUrl: PUB,
    owner: "mmw-devs",
    repo: "ffxiv-race-ops",
    allowMode: "org",
    allowList: [],
    fetchImpl: gh.impl,
    now: () => NOW,
    mintInstallationToken: async () => ({ token: "x", expiresAt: NOW + 3_600_000, permissions: {} }),
  });

  const before = core.startSession();
  await rejectsWith(
    () => core.completeLogin({ code: "c", state: before.state }),
    "not-allowed",
    "refused while not listed"
  );

  core.allowList.push("outsider");
  const after = core.startSession();
  const res = await core.completeLogin({ code: "c", state: after.state });
  eq(res.login, "outsider", "the same login succeeds once the name is listed");
}

console.log("\n--- poll secret ---");
{
  const { core } = makeCore();
  const { state } = core.startSession();
  await rejectsWith(() => core.poll(state, "wrong"), "bad-poll-secret", "a wrong poll secret is refused");
  eq(core.poll("never-existed", "x").status, "expired", "an unknown state reads as expired");
}

console.log("\n--- installation tokens ---");
{
  const { core } = makeCore();
  const { state } = core.startSession();
  const { sessionToken } = await core.completeLogin({ code: "c", state });

  const t = await core.issueInstallationToken(sessionToken);
  eq(t.token, "ghs_installation", "token returned");
  eq(t.repository, "mmw-devs/ffxiv-race-ops", "repository is pinned to the configured one");
  eq(t.permissions.contents, "read", "session tokens are read-only");
  eq(t.expiresAt, NOW + 3_600_000, "expiry comes from the mint");
}
{
  const { core } = makeCore();
  await rejectsWith(() => core.issueInstallationToken(""), "session-required", "no session, no token");
  await rejectsWith(() => core.issueInstallationToken("bogus"), "session-unknown", "an unknown session is refused");
}

console.log("\n--- revocation takes effect immediately ---");
{
  // allowCacheMs: 0 so each token request re-asks GitHub, which is the
  // worst case for the "kick someone now" property.
  const { core, gh } = makeCore({ allowCacheMs: 0 });
  const { state } = core.startSession();
  const { sessionToken, login } = await core.completeLogin({ code: "c", state });
  eq(login, "octocat", "signed in");

  // Still a member: token issued.
  const before = await core.issueInstallationToken(sessionToken);
  eq(before.token, "ghs_installation", "token issued while a member");

  // Removed from the org.
  gh.state.membership = "none";
  await rejectsWith(
    () => core.issueInstallationToken(sessionToken),
    "not-allowed",
    "a removed member can no longer mint a token"
  );
  eq(core.stats().activeSessions, 0, "their sessions were dropped, not merely refused");
  await rejectsWith(() => core.issueInstallationToken(sessionToken), "session-unknown", "the session is gone");
}

console.log("\n--- explicit revoke ---");
{
  const { core } = makeCore();
  const { state } = core.startSession();
  const { sessionToken } = await core.completeLogin({ code: "c", state });
  eq(core.revoke(sessionToken).revoked, true, "revoke reports it removed a session");
  eq(core.revoke(sessionToken).revoked, false, "revoking twice is idempotent");
  await rejectsWith(() => core.issueInstallationToken(sessionToken), "session-unknown", "revoked sessions cannot mint");
}

console.log("\n--- expiry and sweep ---");
{
  let clock = NOW;
  const { core } = makeCore({ now: () => clock });
  const { state } = core.startSession();
  const { sessionToken } = await core.completeLogin({ code: "c", state });

  clock = NOW + 12 * 3600 * 1000 + 1;
  await rejectsWith(() => core.issueInstallationToken(sessionToken), "session-expired", "an expired session is refused");

  const c2 = makeCore({ now: () => clock }).core;
  c2.startSession();
  eq(c2.stats().pendingSessions, 1, "a pending state is counted");
  clock += 5 * 60 * 1000 + 1;
  c2.sweep();
  eq(c2.stats().pendingSessions, 0, "sweep drops expired pending states");
}

console.log("\n--- secrets never appear in errors ---");
{
  const { core } = makeCore({
    fetchImpl: async (url) => {
      if (String(url).includes("/login/oauth/access_token")) return json({ error: "bad_verification_code" }, 200);
      return json({ message: "unexpected" }, 500);
    },
  });
  const { state } = core.startSession();
  let caught = null;
  try {
    await core.completeLogin({ code: "c", state });
  } catch (err) {
    caught = err;
  }
  truthy(Boolean(caught), "a token-less exchange throws");
  truthy(!String(caught?.message).includes("super-secret-value"), "the client secret is not echoed");
  truthy(!String(caught?.message).includes("user-token-abc"), "no user token is echoed");
}

console.log("\n--- a failed exchange is terminal for the poller ---");
{
  const { core } = makeCore({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
    githubAttempts: 1,
  });
  const { state, pollSecret } = core.startSession();
  eq(core.hasPendingLogin(state), true, "a fresh link is usable");
  await rejectsWith(() => core.completeLogin({ code: "c", state }), "github-unreachable", "a dead network is refused");
  eq(core.hasPendingLogin(state), false, "a failed link cannot be replayed");

  const polled = core.poll(state, pollSecret);
  eq(polled.status, "denied", "the poller learns it failed rather than waiting");
  truthy(/github-unreachable/.test(polled.reason ?? ""), "the reason names the cause");
  eq(core.stats().activeSessions, 0, "no session was created");
}

console.log("\n--- a hung GitHub call is bounded ---");
{
  // A stub that never answers on its own but does honour the abort signal,
  // the way undici's fetch does in production.
  const { core } = makeCore({
    fetchImpl: (url, init = {}) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal.reason));
      }),
    githubTimeoutMs: 30,
    githubAttempts: 1,
  });
  const { state } = core.startSession();
  const t = Date.now();
  // AbortSignal.timeout uses an unref'd timer, so with no socket open the
  // event loop would drain before it fires. Keep the loop alive for the
  // duration, as a real request would.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await rejectsWith(() => core.completeLogin({ code: "c", state }), "github-unreachable", "a hung call gives up");
    truthy(Date.now() - t < 2000, `gave up after ${Date.now() - t}ms instead of hanging`);
  } finally {
    clearInterval(keepAlive);
  }
}

/* ---------------- Feishu direct path ---------------- */

/**
 * A fake auth core: /v1/me names the member, /v1/agent/routes lists the
 * operations their roles grant. Records the Authorization header so the
 * tests can prove the plugin token is forwarded, not trusted blindly.
 */
function fakeAuthService({
  name = "张三",
  id = "ou_zhangsan",
  operations = ["race-ops.repo_read", "race-ops.repo_edit", "race-ops.pr_create"],
  meStatus = 200,
  routesStatus = 200,
} = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const path = new URL(String(url)).pathname;
    if (path === "/v1/me") return json({ id, name }, meStatus);
    if (path === "/v1/agent/routes") return json({ allowedOperations: operations }, routesStatus);
    return json({ message: "unexpected" }, 500);
  };
  return { impl, calls };
}

console.log("\n--- Feishu: a write role still gets a read-only client token ---");
{
  const auth = fakeAuthService();
  const minted = [];
  const { core } = makeCore({
    authUrl: "https://auth.example",
    fetchImpl: auth.impl,
    mintInstallationToken: async (opts = {}) => {
      minted.push(opts);
      return { token: "ghs_feishu_read", expiresAt: NOW + 3_600_000, permissions: opts.permissions };
    },
  });

  const issued = await core.issueInstallationTokenForFeishu("fs-plugin-token");
  eq(issued.token, "ghs_feishu_read", "the broker returns the minted token");
  eq(issued.authMode, "feishu", "the reply names the Feishu path");
  eq(issued.scope, "read", "client tokens never carry write");
  eq(issued.login, "张三", "the reply carries the Feishu identity");
  eq(minted.length, 1, "the mint is called exactly once");
  eq(minted[0].permissions?.contents, "read", "contents is read");
  eq(minted[0].permissions?.pull_requests, "read", "pull_requests is read");
  eq(auth.calls.length, 2, "the broker asks /v1/me and /v1/agent/routes");
  eq(
    auth.calls[0].init.headers.Authorization,
    "Bearer fs-plugin-token",
    "the plugin token is forwarded to the auth service"
  );
  eq(core.stats().feishuEnabled, true, "health reports that Feishu is configured");
}

console.log("\n--- Feishu: a read-only role gets a read token ---");
{
  const auth = fakeAuthService({ operations: ["race-ops.repo_read"] });
  const minted = [];
  const { core } = makeCore({
    authUrl: "https://auth.example",
    fetchImpl: auth.impl,
    mintInstallationToken: async (opts = {}) => {
      minted.push(opts);
      return { token: "ghs_feishu_read", expiresAt: NOW + 3_600_000, permissions: opts.permissions };
    },
  });

  const issued = await core.issueInstallationTokenForFeishu("fs-plugin-token");
  eq(issued.scope, "read", "read-only is a read scope");
  eq(minted[0].permissions?.contents, "read", "contents is read");
  eq(minted[0].permissions?.pull_requests, "read", "pull_requests is read");
}

console.log("\n--- Feishu: refusals ---");
{
  const { core } = makeCore({ authUrl: "https://auth.example", fetchImpl: fakeAuthService().impl });
  await rejectsWith(
    () => core.issueInstallationTokenForFeishu("   "),
    "feishu-token-required",
    "an empty token is refused"
  );
}
{
  const { core } = makeCore({ fetchImpl: fakeAuthService().impl });
  await rejectsWith(
    () => core.issueInstallationTokenForFeishu("fs-plugin-token"),
    "feishu-not-configured",
    "a broker without an auth URL refuses the Feishu path"
  );
  eq(core.stats().feishuEnabled, false, "health reports Feishu as disabled");
}
{
  const auth = fakeAuthService({ operations: ["race-ops.repo_status"] });
  const minted = [];
  const { core } = makeCore({
    authUrl: "https://auth.example",
    fetchImpl: auth.impl,
    mintInstallationToken: async (opts = {}) => {
      minted.push(opts);
      return { token: "nope", expiresAt: NOW, permissions: {} };
    },
  });
  await rejectsWith(
    () => core.issueInstallationTokenForFeishu("fs-plugin-token"),
    "feishu-no-access",
    "a role without this repository's operations is refused"
  );
  eq(minted.length, 0, "no token is minted for a role with no access");
}
{
  const auth = fakeAuthService({ meStatus: 401 });
  const { core } = makeCore({ authUrl: "https://auth.example", fetchImpl: auth.impl });
  await rejectsWith(
    () => core.issueInstallationTokenForFeishu("expired"),
    "feishu-auth-rejected",
    "a rejected plugin token is refused"
  );
}
{
  const auth = fakeAuthService({ routesStatus: 500 });
  const { core } = makeCore({ authUrl: "https://auth.example", fetchImpl: auth.impl });
  await rejectsWith(
    () => core.issueInstallationTokenForFeishu("fs-plugin-token"),
    "feishu-check-failed",
    "an auth-service outage is reported, not treated as a grant"
  );
}

/* ---------------- write proxy ---------------- */

const BASE_SHA = "a".repeat(40);

/**
 * A fake GitHub for the write proxy. It answers the Git Data API, the
 * contents API, and the pulls API; every call is recorded so idempotency
 * can be asserted by call count.
 */
function fakeWriteGithub({
  head = BASE_SHA,
  openPr = true,
  draft = false,
  contract = null,
  headContract = null,
  commitMessage = "",
} = {}) {
  const calls = [];
  const state = {
    head,
    openPr,
    merged: false,
    contract,
    headContract,
    commitMessage,
    pr: {
      number: 11,
      state: "open",
      draft,
      head: { ref: "content/feat", sha: head },
      base: { ref: "main", sha: BASE_SHA },
      mergeable_state: "clean",
    },
  };
  const impl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    calls.push({ url: u, method, init });
    const pathname = new URL(u).pathname;
    const repoMatch = /^\/repos\/[^/]+\/[^/]+(\/.*)$/.exec(pathname);
    const p = repoMatch ? repoMatch[1] : pathname;
    if (method === "GET" && p.startsWith("/git/ref/heads/")) {
      const ref = decodeURIComponent(p.slice("/git/ref/heads/".length));
      if (ref === "content/feat" || ref === "main" || ref === "master") {
        return json({ object: { sha: state.head } });
      }
      return json({ message: "Not Found" }, 404);
    }
    if (method === "GET" && p.startsWith("/git/commits/")) {
      return json({ sha: p.slice("/git/commits/".length), tree: { sha: "t0" } });
    }
    if (method === "GET" && p.startsWith("/contents/")) {
      const path = decodeURIComponent(p.slice("/contents/".length).split("?")[0]);
      if (path === ".dsh-mmw-tools.yaml") {
        const policy = [
          "version: 1",
          "branchPrefix: content/",
          "allowlistPaths:",
          "  - src/**",
          "  - AGENTS.md",
          "denylistPaths:",
          "  - AGENTS.md",
          "prDefaultDraft: true",
          "",
        ].join("\n");
        return json({
          type: "file",
          encoding: "base64",
          sha: "policy-sha",
          content: Buffer.from(policy).toString("base64"),
        });
      }
      if (path === "src/a.txt") {
        return json({ type: "file", encoding: "base64", content: Buffer.from("hello world").toString("base64") });
      }
      if (path === "contract/operations.json") {
        const ref = new URL(u).searchParams.get("ref");
        const content =
          ref === state.head && state.headContract !== null ? state.headContract : state.contract;
        if (content === null) return json({ message: "Not Found" }, 404);
        return json({
          type: "file",
          encoding: "base64",
          sha: `contract-${ref}`,
          content: Buffer.from(content).toString("base64"),
        });
      }
      return json({ message: "Not Found" }, 404);
    }
    if (method === "POST" && p === "/git/blobs") return json({ sha: "b1" });
    if (method === "POST" && p === "/git/trees") return json({ sha: "t1" });
    if (method === "POST" && p === "/git/commits") return json({ sha: "c1" });
    if (method === "POST" && p === "/git/refs") return json({ ref: "refs/heads/content/feat" }, 201);
    if (method === "PATCH" && p.startsWith("/git/refs/heads/")) return json({ object: { sha: "c1" } });
    if (method === "GET" && p === "/pulls" || (method === "GET" && p.startsWith("/pulls?"))) {
      return json(state.openPr ? [state.pr] : []);
    }
    if (method === "POST" && p === "/pulls") {
      state.pr = { ...state.pr, draft: init.body?.draft !== false };
      return json({ ...state.pr, html_url: "https://github.com/mmw-devs/ffxiv-race-ops/pull/11" }, 201);
    }
    if (method === "GET" && p === "/pulls/11") return json(state.pr);
    if (method === "GET" && p.startsWith("/pulls/11/commits")) {
      return json([{ commit: { message: state.commitMessage } }]);
    }
    if (method === "GET" && /^\/pulls\/\d+$/.test(p)) return json({ message: "Not Found" }, 404);
    if (method === "PATCH" && p === "/pulls/11") {
      const patch = typeof init.body === "string" ? JSON.parse(init.body) : (init.body ?? {});
      if (patch.state === "closed") state.pr = { ...state.pr, state: "closed" };
      if (patch.draft === false) state.pr = { ...state.pr, draft: false };
      return json(state.pr);
    }
    if (method === "PUT" && p === "/pulls/11/merge") {
      state.merged = true;
      return json({ merged: true, sha: "m1" });
    }
    return json({ message: `unexpected ${method} ${p}` }, 500);
  };
  return { impl, calls, state };
}

function makeWriteCore(overrides = {}) {
  const gh = fakeWriteGithub({
    ...(overrides.head ? { head: overrides.head } : {}),
    contract: overrides.contract ?? null,
    headContract: overrides.headContract ?? null,
    commitMessage: overrides.commitMessage ?? "",
  });
  const auth = fakeAuthService({
    name: overrides.authName ?? "张三",
    operations: overrides.operations ?? [
      "race-ops.repo_read",
      "race-ops.repo_edit",
      "race-ops.pr_create",
      "race-ops.pr_close",
      "race-ops.pr_merge",
    ],
  });
  const minted = [];
  const audits = [];
  const clock = { now: NOW };
  const core = new BrokerCore({
    appId: 123456,
    privateKeyPem: "unused",
    installationId: 98765,
    clientId: "Iv1.client",
    clientSecret: "secret",
    publicUrl: PUB,
    owner: "mmw-devs",
    repo: "ffxiv-race-ops",
    org: "mmw-devs",
    authUrl: "https://auth.example",
    writeEnabled: true,
    allowlistPaths: ["src/**"],
    denylistPaths: ["AGENTS.md"],
    baseBranch: "main",
    branchPrefix: "content/",
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (u.startsWith("https://auth.example")) return auth.impl(url, init);
      return gh.impl(url, init);
    },
    mintInstallationToken: async (opts = {}) => {
      minted.push(opts);
      return { token: "ghs_write", expiresAt: NOW + 3_600_000, permissions: opts.permissions };
    },
    audit: (event) => audits.push(event),
    now: () => clock.now,
    ...overrides,
  });
  return { core, gh, auth, minted, audits, clock };
}

console.log("\n--- write proxy: disabled and authorization ---");
{
  const { core } = makeCore({ writeEnabled: false });
  await rejectsWith(
    () => core.writeRepoEdit({ feishuToken: "fs", branch: "content/x", base_sha: BASE_SHA, message: "m", edits: [] }),
    "write-disabled",
    "a broker without the write flag refuses writes"
  );
}
{
  const { core } = makeWriteCore();
  await rejectsWith(
    () => core.writeRepoEdit({ branch: "content/x", base_sha: BASE_SHA, message: "m", edits: [] }),
    "write-credential-required",
    "no credential is refused"
  );
}
{
  const auth = fakeAuthService({ operations: ["race-ops.repo_read"] });
  const { core } = makeWriteCore({ fetchImpl: auth.impl });
  await rejectsWith(
    () =>
      core.writeRepoEdit({
        feishuToken: "fs",
        branch: "content/x",
        base_sha: BASE_SHA,
        message: "m",
        edits: [{ path: "src/a.txt", mode: "insert", content: "x" }],
      }),
    "feishu-operation-denied",
    "a Feishu role without repo_edit cannot write"
  );
}

console.log("\n--- write proxy: repo_edit ---");
{
  const { core, gh, minted, audits } = makeWriteCore();
  const res = await core.writeRepoEdit({
    feishuToken: "fs-plugin-token",
    branch: "content/feat",
    base_sha: BASE_SHA,
    message: "feat: change a line",
    edits: [{ path: "src/a.txt", mode: "replace", find: "hello", replace: "hi" }],
  });
  eq(res.new_commit_sha, "c1", "the new commit is returned");
  eq(res.base_sha, BASE_SHA, "the base is echoed");
  eq(res.files_changed[0], "src/a.txt", "the changed file is listed");
  eq(res.idempotent, false, "the first call is not idempotent");
  const writeMint = minted.find((mint) => mint.permissions?.contents === "write");
  eq(writeMint?.permissions?.contents, "write", "the write token carries contents:write");
  eq(writeMint?.permissions?.pull_requests, "write", "the write token carries pull_requests:write");
  eq(audits.at(-1)?.op, "repo_edit", "the write is audited");
  truthy(gh.calls.some((c) => c.method === "POST" && c.url.endsWith("/git/commits")), "a commit is created");
}
{
  const { core } = makeWriteCore();
  const args = {
    feishuToken: "fs",
    branch: "content/feat",
    base_sha: BASE_SHA,
    message: "m",
    edits: [{ path: "src/a.txt", mode: "insert", content: "!" }],
    idempotencyKey: "same-request",
  };
  const first = await core.writeRepoEdit(args);
  const second = await core.writeRepoEdit(args);
  eq(second.idempotent, true, "a repeated request is marked idempotent");
  eq(second.new_commit_sha, first.new_commit_sha, "the cached commit is returned");
}
{
  const { core } = makeWriteCore();
  await rejectsWith(
    () =>
      core.writeRepoEdit({
        feishuToken: "fs",
        branch: "content/feat",
        base_sha: "b".repeat(40),
        message: "m",
        edits: [{ path: "src/a.txt", mode: "insert", content: "!" }],
      }),
    "base-sha-mismatch",
    "a stale base SHA is a conflict, not an overwrite"
  );
}
{
  const { core } = makeWriteCore({ allowlistPaths: ["src/**", "AGENTS.md"] });
  await rejectsWith(
    () =>
      core.writeRepoEdit({
        feishuToken: "fs",
        branch: "content/feat",
        base_sha: BASE_SHA,
        message: "m",
        edits: [{ path: "AGENTS.md", mode: "insert", content: "!" }],
      }),
    "path-denied",
    "the denylist wins over the allowlist"
  );
}
{
  const { core } = makeWriteCore();
  await rejectsWith(
    () =>
      core.writeRepoEdit({
        feishuToken: "fs",
        branch: "content/feat",
        base_sha: BASE_SHA,
        message: "m",
        edits: [{ path: "docs/readme.md", mode: "insert", content: "!" }],
      }),
    "path-not-allowed",
    "a path outside the allowlist is refused"
  );
}
{
  const { core } = makeWriteCore();
  await rejectsWith(
    () =>
      core.writeRepoEdit({
        feishuToken: "fs",
        branch: "feature/x",
        base_sha: BASE_SHA,
        message: "m",
        edits: [{ path: "src/a.txt", mode: "insert", content: "!" }],
      }),
    "branch-prefix",
    "writes must use the content/ prefix"
  );
}

console.log("\n--- write proxy: pr_create ---");
{
  const { core, gh } = makeWriteCore();
  gh.state.openPr = false;
  const res = await core.writePrCreate({
    feishuToken: "fs",
    head: "content/feat",
    base: "main",
    title: "feat: x",
    body: "body",
    draft: true,
  });
  eq(res.number, 11, "the PR number is returned");
  eq(res.created, true, "a new PR is created");
  eq(res.draft, true, "draft is preserved");
}

console.log("\n--- write proxy: pr_close ---");
{
  const { core, gh, audits } = makeWriteCore();
  const res = await core.writePrClose({ feishuToken: "fs", pr_number: 11 });
  eq(res.number, 11, "the closed PR number is returned");
  eq(res.closed, true, "the PR is closed");
  eq(res.already, false, "the first close is not a no-op");
  eq(gh.state.pr.state, "closed", "GitHub received the close");
  eq(audits.at(-1)?.op, "pr_close", "the close is audited");
}
{
  const { core } = makeWriteCore();
  await rejectsWith(
    () => core.writePrClose({ feishuToken: "fs", pr_number: 99 }),
    "pr-not-found",
    "a missing PR is a 404, not a write failure"
  );
}
{
  const { core } = makeWriteCore();
  await core.writePrClose({ feishuToken: "fs", pr_number: 11, idempotencyKey: "first" });
  const again = await core.writePrClose({ feishuToken: "fs", pr_number: 11, idempotencyKey: "second" });
  eq(again.already, true, "closing an already closed PR is a no-op");
  eq(again.closed, true, "an already closed PR still reports closed");
}
{
  const { core } = makeWriteCore();
  await core.writePrClose({ feishuToken: "fs", pr_number: 11, idempotencyKey: "once" });
  const replay = await core.writePrClose({
    feishuToken: "fs",
    pr_number: 11,
    idempotencyKey: "once",
  });
  eq(replay.idempotent, true, "a retry with the same key is idempotent");
}
{
  const { core } = makeWriteCore({ operations: ["race-ops.repo_read", "race-ops.repo_edit"] });
  await rejectsWith(
    () => core.writePrClose({ feishuToken: "fs", pr_number: 11 }),
    "feishu-operation-denied",
    "a Feishu role without pr_close cannot close"
  );
}
{
  const { core } = makeWriteCore({ branchPrefix: "other/" });
  await rejectsWith(
    () => core.writePrClose({ feishuToken: "fs", pr_number: 11 }),
    "branch-prefix",
    "a PR outside content/* is not closed"
  );
}

console.log("\n--- write proxy: pr_merge approval ---");
{
  const { core, gh, audits } = makeWriteCore();
  const approval = await core.approvePrMerge({
    feishuToken: "fs",
    pr_number: 11,
    merge_method: "squash",
    commit_title: "feat: x (#11)",
  });
  truthy(approval.approval_id, "an approval id is issued");
  eq(approval.head_sha, BASE_SHA, "the approval binds the current head");
  eq(audits.at(-1)?.op, "pr_merge_approval", "the approval is audited");

  const merged = await core.writePrMerge({
    feishuToken: "fs",
    approval_id: approval.approval_id,
    pr_number: 11,
    head_sha: approval.head_sha,
    merge_method: "squash",
  });
  eq(merged.merged, true, "the PR is merged");
  eq(merged.sha, "m1", "the merge commit is returned");
  truthy(gh.state.merged, "GitHub received the merge call");

  const mergeCalls = () => gh.calls.filter((c) => c.method === "PUT" && c.url.endsWith("/merge")).length;
  eq(mergeCalls(), 1, "GitHub received exactly one merge call");

  const replay = await core.writePrMerge({
    feishuToken: "fs",
    approval_id: approval.approval_id,
    pr_number: 11,
  });
  eq(replay.idempotent, true, "a replay returns the cached merge");
  eq(replay.sha, "m1", "the replay does not merge twice");
  eq(mergeCalls(), 1, "the approval is not replayed against GitHub");
}
{
  const { core, gh } = makeWriteCore();
  const approval = await core.approvePrMerge({ feishuToken: "fs", pr_number: 11, merge_method: "squash" });
  gh.state.pr = { ...gh.state.pr, head: { ref: "content/feat", sha: "d".repeat(40) } };
  await rejectsWith(
    () =>
      core.writePrMerge({
        feishuToken: "fs",
        approval_id: approval.approval_id,
        pr_number: 11,
      }),
    "approval-stale",
    "a moved head invalidates the approval"
  );
}
{
  const { core, clock } = makeWriteCore();
  const approval = await core.approvePrMerge({ feishuToken: "fs", pr_number: 11, merge_method: "squash" });
  clock.now += 6 * 60 * 1000;
  await rejectsWith(
    () =>
      core.writePrMerge({
        feishuToken: "fs",
        approval_id: approval.approval_id,
        pr_number: 11,
      }),
    "approval-expired",
    "an old approval is refused"
  );
}
{
  const { core, gh } = makeWriteCore({ draft: true });
  const approval = await core.approvePrMerge({ feishuToken: "fs", pr_number: 11, merge_method: "squash" });
  truthy(approval.approval_id, "a draft PR can be approved");
  eq(gh.state.pr.draft, false, "approval marks the draft ready");
}

console.log("\n--- write proxy: contract gate ---");
const CONTRACT = JSON.stringify({
  levels: {
    L1: { agentMerge: false },
    L2: { agentMerge: true },
  },
  domains: [{ commands: [{ id: "cmd.l1", level: "L1" }, { id: "cmd.l2", level: "L2" }] }],
});
const opLog = (command) => `\`\`\`json\n${JSON.stringify({ command })}\n\`\`\``;
{
  const { core } = makeWriteCore({
    contract: CONTRACT,
    headContract: CONTRACT,
    commitMessage: opLog("cmd.l1"),
  });
  await rejectsWith(
    () => core.approvePrMerge({ feishuToken: "fs", pr_number: 11, merge_method: "squash" }),
    "agent-merge-denied",
    "an agentMerge:false command is refused at approval"
  );
}
{
  const { core } = makeWriteCore({
    contract: CONTRACT,
    headContract: CONTRACT,
    commitMessage: opLog("cmd.l2"),
  });
  const approval = await core.approvePrMerge({
    feishuToken: "fs",
    pr_number: 11,
    merge_method: "squash",
  });
  truthy(approval.approval_id, "an agentMerge:true command can be approved");
}
{
  const { core } = makeWriteCore({
    contract: CONTRACT,
    headContract: CONTRACT.replace('"agentMerge":true', '"agentMerge":false'),
    head: "b".repeat(40),
    commitMessage: opLog("cmd.l2"),
  });
  await rejectsWith(
    () => core.approvePrMerge({ feishuToken: "fs", pr_number: 11, merge_method: "squash" }),
    "contract-changed",
    "a PR that changes the contract cannot merge itself"
  );
}
{
  const { core } = makeWriteCore({
    contract: CONTRACT,
    headContract: CONTRACT,
    commitMessage: "no op-log here",
  });
  await rejectsWith(
    () => core.approvePrMerge({ feishuToken: "fs", pr_number: 11, merge_method: "squash" }),
    "agent-merge-denied",
    "a PR without an op-log command is refused"
  );
}

console.log("\n--- write proxy: close ownership ---");
{
  const dir = mkdtempSync(path.join(os.tmpdir(), "mmw-owners-"));
  const ownershipFile = path.join(dir, "owners.json");
  try {
    const first = makeWriteCore({ ownershipFile });
    await first.core.writeRepoEdit({
      feishuToken: "fs",
      branch: "content/feat",
      base_sha: BASE_SHA,
      message: "edit",
      edits: [{ path: "src/a.txt", mode: "replace", find: "hello", replace: "hi" }],
    });
    const same = await first.core.writePrClose({ feishuToken: "fs", pr_number: 11 });
    truthy(same.closed, "the branch owner can close their own PR");
    eq(same.already, false, "the first close actually closed the PR");

    const other = makeWriteCore({
      ownershipFile,
      authName: "李四",
      operations: ["race-ops.pr_close"],
    });
    await rejectsWith(
      () => other.core.writePrClose({ feishuToken: "fs", pr_number: 11 }),
      "pr-not-owned",
      "another editor cannot close a PR they do not own"
    );

    const privileged = makeWriteCore({
      ownershipFile,
      authName: "李四",
      operations: ["race-ops.pr_close", "race-ops.pr_merge"],
    });
    const allowed = await privileged.core.writePrClose({ feishuToken: "fs", pr_number: 11 });
    truthy(allowed.closed, "an operator can close someone else's PR");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const { core } = makeWriteCore({ operations: ["race-ops.pr_close"] });
  await rejectsWith(
    () => core.writePrClose({ feishuToken: "fs", pr_number: 11 }),
    "pr-not-owned",
    "without an ownership record only an operator may close"
  );
}

console.log("\n--- repo registry: mint for a second repository ---");
{
  const mints = [];
  const { core } = makeCore({
    repos: [{ owner: "mmw-devs", name: "xivstrat-relay", baseBranch: "master" }],
    mintInstallationToken: async (opts = {}) => {
      mints.push(opts);
      return {
        token: `ghs:${opts.repository}`,
        expiresAt: NOW + 3_600_000,
        permissions: opts.permissions ?? {},
      };
    },
  });
  const started = core.startSession();
  const res = await core.completeLogin({ code: "c", state: started.state });

  const fallback = await core.issueInstallationToken(res.sessionToken);
  eq(fallback.repository, "mmw-devs/ffxiv-race-ops", "omitting repo keeps the default repository");
  eq(mints.at(-1).repository, "mmw-devs/ffxiv-race-ops", "the default mint names its repository");

  const relay = await core.issueInstallationToken(res.sessionToken, "MMW-DEVS/xivstrat-relay");
  eq(relay.repository, "mmw-devs/xivstrat-relay", "a repo key selects the second repository (case-insensitive)");
  eq(relay.token, "ghs:mmw-devs/xivstrat-relay", "the token is minted for that repository");
  eq(
    core.repos.get("mmw-devs/xivstrat-relay").baseBranch,
    "master",
    "per-repository base branch is kept in the registry"
  );

  await rejectsWith(
    () => core.issueInstallationToken(res.sessionToken, "mmw-devs/not-configured"),
    "repo-denied",
    "an unknown repository is refused instead of falling back"
  );
}

console.log("\n--- write proxy: repository selection ---");
{
  const { core, gh } = makeWriteCore({
    repos: [{ owner: "mmw-devs", name: "xivstrat-relay", baseBranch: "master" }],
  });
  const res = await core.writeRepoEdit({
    feishuToken: "fs",
    repo: "mmw-devs/xivstrat-relay",
    branch: "content/new",
    base_sha: BASE_SHA,
    message: "m",
    edits: [{ path: "src/a.txt", mode: "insert", content: "x" }],
  });
  truthy(res.new_commit_sha, "a write to the second repository succeeds");
  truthy(
    gh.calls.some((c) => c.url.includes("/repos/mmw-devs/xivstrat-relay/git/")),
    "the GitHub calls are scoped to the selected repository"
  );
  truthy(
    gh.calls.some((c) => c.url.includes("/repos/mmw-devs/xivstrat-relay/git/ref/heads/master")),
    "the second repository uses its own base branch (master)"
  );

  await rejectsWith(
    () =>
      core.writeRepoEdit({
        feishuToken: "fs",
        repo: "mmw-devs/not-configured",
        branch: "content/feat",
        base_sha: BASE_SHA,
        message: "m",
        edits: [{ path: "src/a.txt", mode: "insert", content: "x" }],
      }),
    "repo-denied",
    "a write to an unknown repository is refused"
  );
}

console.log("\n--- repo policy ---");
{
  const yaml = [
    "version: 1",
    "allowlistPaths:",
    '  - "src/data/**"',
    "  - docs/**",
    "denylistPaths: [AGENTS.md, .github/**]",
    'branchPrefix: "content/"',
    "preflight:",
    '  cmd: "pnpm build"',
    "  timeoutSeconds: 120",
    "bootstrap:",
    '  cmd: "pnpm install --frozen-lockfile"',
    '  whenMissing: "node_modules"',
    "prDefaultDraft: false",
  ].join("\n");
  const parsed = parseRepoPolicy(yaml);
  eq(parsed.allowlistPaths[0], "src/data/**", "quoted list item is unquoted");
  eq(parsed.allowlistPaths[1], "docs/**", "bare list item is kept");
  eq(parsed.denylistPaths[1], ".github/**", "inline list is parsed");
  eq(parsed.branchPrefix, "content/", "branch prefix is parsed");
  eq(parsed.preflight.cmd, "pnpm build", "preflight command is parsed");
  eq(parsed.preflight.timeoutSeconds, 120, "preflight timeout is parsed");
  eq(parsed.bootstrap.whenMissing, "node_modules", "bootstrap whenMissing is parsed");
  eq(parsed.prDefaultDraft, false, "prDefaultDraft false is parsed");

  const bad = parseRepoPolicy("version: 2\nallowlistPaths: []\nbranchPrefix: content");
  let versionError = "";
  try {
    validateRepoPolicy(bad);
  } catch (err) {
    versionError = err.code;
  }
  eq(versionError, "repo-policy-invalid", "a non-v1 file is invalid");
  let prefixError = "";
  try {
    validateRepoPolicy(parseRepoPolicy('version: 1\nallowlistPaths: ["src/**"]\nbranchPrefix: content'));
  } catch (err) {
    prefixError = err.code;
  }
  eq(prefixError, "repo-policy-invalid", "a branch prefix without / is invalid");
}

console.log("\n--- safeEqual ---");
{
  eq(safeEqual("abc", "abc"), true, "equal strings match");
  eq(safeEqual("abc", "abd"), false, "different strings do not");
  eq(safeEqual("abc", "abcd"), false, "length mismatch does not throw");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
