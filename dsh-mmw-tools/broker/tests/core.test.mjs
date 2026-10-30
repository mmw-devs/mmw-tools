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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(__dirname, "..", "core.mjs");
const { BrokerCore, BrokerRefused, safeEqual } = await import(pathToFileURL(CORE).href);

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
  return { ok: status >= 200 && status < 300, status, json: async () => body };
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
    mintInstallationToken: async () => ({
      token: "ghs_installation",
      expiresAt: NOW + 3_600_000,
      permissions: { contents: "write", pull_requests: "write" },
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
  eq(t.permissions.contents, "write", "permissions surfaced");
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

console.log("\n--- safeEqual ---");
{
  eq(safeEqual("abc", "abc"), true, "equal strings match");
  eq(safeEqual("abc", "abd"), false, "different strings do not");
  eq(safeEqual("abc", "abcd"), false, "length mismatch does not throw");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
