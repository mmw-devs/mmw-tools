#!/usr/bin/env node
/**
 * broker/tests/server.test.mjs
 *
 * Drives the HTTP layer end to end against a real listening socket on
 * loopback — still fully offline: GitHub is a stub inside the core.
 *
 * This is the only test that exercises the whole broker lifecycle as a
 * client would: start → authorize → poll → mint → revoke.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER = path.resolve(__dirname, "..");
const { BrokerCore } = await import(pathToFileURL(path.join(BROKER, "core.mjs")).href);
const { createBrokerServer } = await import(pathToFileURL(path.join(BROKER, "server.mjs")).href);

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

/* ---------------- fixtures ---------------- */

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fakeGithub({ membership = "active" } = {}) {
  const state = { membership, login: "octocat" };
  const impl = async (url) => {
    const u = String(url);
    if (u.includes("/login/oauth/access_token")) return json({ access_token: "user-token-abc" });
    if (u.endsWith("/user")) return json({ login: state.login });
    if (String(url).includes("/orgs/") && String(url).includes("/members/")) {
      // GitHub answers 204 with no body for a member, 404 otherwise.
      return state.membership === "none" ? json({ message: "Not Found" }, 404) : json({}, 204);
    }
    return json({ message: "unexpected" }, 500);
  };
  return { impl, state };
}

function makeCore(overrides = {}) {
  const gh = fakeGithub();
  const core = new BrokerCore({
    appId: 5469681,
    privateKeyPem: "injected-mint-so-unused",
    installationId: 1,
    clientId: "Iv23.test",
    clientSecret: "shhh-client-secret",
    publicUrl: "https://race-ops-broker.mmw-team.icu",
    owner: "mmw-devs",
    repo: "ffxiv-race-ops",
    fetchImpl: gh.impl,
    mintInstallationToken: async () => ({
      token: "ghs_installationtoken",
      expiresAt: Date.now() + 3_600_000,
      permissions: { contents: "write" },
    }),
    ...overrides,
  });
  return { core, gh };
}

async function withServer(coreOpts, run, serverOpts = {}) {
  const { core } = makeCore(coreOpts);
  let ip = "10.0.0.1";
  const server = createBrokerServer(core, {
    clientIp: () => ip,
    ...serverOpts,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, core, setIp: (v) => (ip = v) });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const get = (base, p) => fetch(base + p, { redirect: "manual" });
const post = (base, p, opts = {}) =>
  fetch(base + p, { method: "POST", redirect: "manual", ...opts });

/* ============================================================== */
console.log("\n--- /health ---");
await withServer({}, async ({ base }) => {
  const res = await get(base, "/health");
  eq(res.status, 200, "health status");
  const body = await res.json();
  eq(body.ok, true, "ok flag");
  eq(body.repository, "mmw-devs/ffxiv-race-ops", "repository reported");
  eq(body.appId, 5469681, "app id reported");
  truthy(!("installationToken" in body), "no token field");
  truthy(JSON.stringify(body).length < 300, "health stays small");
  truthy(!JSON.stringify(body).includes("shhh-client-secret"), "the client secret is not exposed");
});

console.log("\n--- unknown endpoint ---");
await withServer({}, async ({ base }) => {
  const res = await get(base, "/nope");
  eq(res.status, 404, "unknown path is 404");
  eq((await res.json()).error, "not-found", "error body is machine-readable");
});

console.log("\n--- full lifecycle over HTTP ---");
await withServer({}, async ({ base }) => {
  const started = await (await post(base, "/session/start")).json();
  truthy(started.state, "state issued");
  truthy(started.pollSecret, "pollSecret issued");
  truthy(started.loginUrl.startsWith("https://race-ops-broker.mmw-team.icu"), "loginUrl points at the broker");

  const redirect = await get(base, `/auth/github/start?state=${encodeURIComponent(started.state)}`);
  eq(redirect.status, 302, "browser entry redirects");
  const location = redirect.headers.get("location") ?? "";
  truthy(location.startsWith("https://github.com/login/oauth/authorize"), "redirect goes to GitHub");
  truthy(location.includes("redirect_uri=https%3A%2F%2Frace-ops-broker.mmw-team.icu%2Fauth%2Fgithub%2Fcallback"), "callback is the broker's own URL");

  const pending = await (await get(base, `/session/${encodeURIComponent(started.state)}?secret=${encodeURIComponent(started.pollSecret)}`)).json();
  eq(pending.status, "pending", "poll reports pending before the browser returns");

  const cb = await get(base, `/auth/github/callback?code=abc&state=${encodeURIComponent(started.state)}`);
  eq(cb.status, 200, "callback renders a page");
  const cbBody = await cb.text();
  truthy(cbBody.includes("octocat"), "the page names the account");
  truthy(!cbBody.includes("user-token-abc"), "the user token is never rendered");

  const authorized = await (await get(base, `/session/${encodeURIComponent(started.state)}?secret=${encodeURIComponent(started.pollSecret)}`)).json();
  eq(authorized.status, "authorized", "poll returns authorized");
  truthy(authorized.sessionToken, "session token delivered");

  const again = await (await get(base, `/session/${encodeURIComponent(started.state)}?secret=${encodeURIComponent(started.pollSecret)}`)).json();
  eq(again.status, "expired", "the state cannot deliver twice");

  const noAuth = await post(base, "/installation-token");
  eq(noAuth.status, 401, "minting without a bearer is 401");

  const minted = await post(base, "/installation-token", {
    headers: { Authorization: `Bearer ${authorized.sessionToken}` },
  });
  eq(minted.status, 200, "minting with a session works");
  const mintedBody = await minted.json();
  eq(mintedBody.token, "ghs_installationtoken", "installation token returned");
  eq(mintedBody.repository, "mmw-devs/ffxiv-race-ops", "repository pinned in the reply");

  const revoked = await post(base, "/session/revoke", {
    headers: { Authorization: `Bearer ${authorized.sessionToken}` },
  });
  eq((await revoked.json()).revoked, true, "revoke succeeds");

  const afterRevoke = await post(base, "/installation-token", {
    headers: { Authorization: `Bearer ${authorized.sessionToken}` },
  });
  eq(afterRevoke.status, 401, "a revoked session cannot mint");
});

console.log("\n--- denial renders a page, and issues nothing ---");
await withServer({ fetchImpl: fakeGithub({ membership: "none" }).impl }, async ({ base }) => {
  const started = await (await post(base, "/session/start")).json();
  const res = await get(base, `/auth/github/callback?code=abc&state=${encodeURIComponent(started.state)}`);
  eq(res.status, 403, "a non-member is refused at the callback");
  const body = await res.text();
  truthy(body.includes("没有使用权限"), "the page explains it in plain language");
  truthy(!body.includes("sessionToken"), "no token is rendered");

  const polled = await (await get(base, `/session/${encodeURIComponent(started.state)}?secret=${encodeURIComponent(started.pollSecret)}`)).json();
  eq(polled.status, "denied", "the poller learns the reason");
  truthy(/not-a-member/.test(polled.reason ?? ""), "the reason names the org");
});

console.log("\n--- github error param is swallowed safely ---");
await withServer({}, async ({ base }) => {
  const res = await get(base, "/auth/github/callback?error=access_denied&state=x");
  eq(res.status, 400, "error param yields 400");
  truthy((await res.text()).includes("授权未完成"), "the page explains it in plain language");
});

console.log("\n--- poll secret is enforced over HTTP ---");
await withServer({}, async ({ base }) => {
  const started = await (await post(base, "/session/start")).json();
  const noSecret = await get(base, `/session/${encodeURIComponent(started.state)}`);
  eq(noSecret.status, 400, "a poll without a secret is refused");

  const wrong = await get(base, `/session/${encodeURIComponent(started.state)}?secret=wrong`);
  eq(wrong.status, 401, "a wrong secret is refused");
});

console.log("\n--- rate limiting ---");
{
  // The limiter is injected at construction, so this block builds its own
  // server rather than reusing withServer().
  const core = makeCore().core;
  let n = 0;
  const server = createBrokerServer(core, {
    clientIp: () => "10.9.9.9",
    limiter: { allow: () => ++n <= 3, sweep: () => {} },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let i = 0; i < 3; i++) {
      const r = await get(b, "/health");
      eq(r.status, 200, `request ${i + 1} allowed`);
    }
    const limited = await get(b, "/health");
    eq(limited.status, 429, "the next request is rate limited");
    eq((await limited.json()).error, "rate-limited", "429 carries a machine-readable error");
  } finally {
    await new Promise((r) => server.close(r));
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
