#!/usr/bin/env node
/**
 * tests/broker-client.test.mjs
 *
 * Offline tests for the broker client. `fetch` is always a stub: the
 * point is the contract with the broker and the failure behaviour, not
 * the network. Two properties get extra attention because they are the
 * whole reason this layer exists — a session token is never used without
 * being sent as a bearer, and no error message ever contains a token.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, "..", "lib", "auth", "broker-client.js");
const { BrokerClient, BrokerError } = await import(pathToFileURL(LIB).href);

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
async function rejectsWith(fn, code, label) {
  try {
    await fn();
    bad(label, `expected ${code}, but it resolved`);
  } catch (err) {
    if (err instanceof BrokerError && err.code === code) ok(`${label} (${code})`);
    else bad(label, `expected BrokerError ${code}, got ${err?.code ?? err?.message}`);
  }
}

const BASE = "https://broker.example.com";

function stub(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}
function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

console.log("\n--- constructor ---");
{
  let caught = null;
  try {
    new BrokerClient({ brokerUrl: "broker.example.com" });
  } catch (err) {
    caught = err;
  }
  eq(caught?.code, "broker-unreachable", "rejects a URL without a scheme");
  ok("a bare host is refused rather than silently prefixed");
}

console.log("\n--- startSession ---");
{
  const { impl, calls } = stub(() =>
    json({
      state: "st-1",
      pollSecret: "ps-1",
      loginUrl: "https://broker.example.com/auth/github/start?state=st-1",
      expiresAt: 1_800_000_000_000,
    })
  );
  const client = new BrokerClient({ brokerUrl: BASE + "/", fetchImpl: impl });
  const started = await client.startSession();
  eq(calls.length, 1, "one request");
  eq(calls[0].url, `${BASE}/session/start`, "a trailing slash in brokerUrl is normalized away");
  eq(calls[0].init.method, "POST", "POST");
  eq(started.state, "st-1", "state returned");
  eq(started.pollSecret, "ps-1", "pollSecret returned");
  truthy(started.loginUrl.includes("/auth/github/start"), "loginUrl returned");
}

{
  const { impl } = stub(() => json({ state: "st-1" }));
  const client = new BrokerClient({ brokerUrl: BASE, fetchImpl: impl });
  await rejectsWith(() => client.startSession(), "broker-bad-response", "a partial reply is refused");
}

console.log("\n--- pollSession ---");
{
  for (const status of ["pending", "expired"]) {
    const { impl } = stub(() => json({ status }));
    const client = new BrokerClient({ brokerUrl: BASE, fetchImpl: impl });
    const r = await client.pollSession("st-1", "ps-1");
    eq(r.status, status, `status ${status} passes through`);
  }

  const { impl, calls } = stub(() => json({ status: "denied", reason: "not-a-member" }));
  const client = new BrokerClient({ brokerUrl: BASE, fetchImpl: impl });
  const r = await client.pollSession("st 1", "p&s");
  eq(r.status, "denied", "denied status");
  eq(r.reason, "not-a-member", "denial reason is surfaced");
  truthy(calls[0].url.includes("st%201"), "state is URL-encoded");
  truthy(calls[0].url.includes("p%26s"), "pollSecret is URL-encoded");
}

{
  const { impl } = stub(() =>
    json({ status: "authorized", sessionToken: "sess_abcdefgh", login: "octocat", expiresAt: 1_800_000_000_000 })
  );
  const client = new BrokerClient({ brokerUrl: BASE, fetchImpl: impl });
  const r = await client.pollSession("st-1", "ps-1");
  eq(r.status, "authorized", "authorized status");
  eq(r.sessionToken, "sess_abcdefgh", "session token returned");
  eq(r.login, "octocat", "login returned");
}

{
  const { impl } = stub(() => json({ status: "wat" }));
  const client = new BrokerClient({ brokerUrl: BASE, fetchImpl: impl });
  await rejectsWith(() => client.pollSession("s", "p"), "broker-bad-response", "an unknown status is refused");
}

{
  const { impl } = stub(() => json({ status: "authorized" }));
  const client = new BrokerClient({ brokerUrl: BASE, fetchImpl: impl });
  await rejectsWith(
    () => client.pollSession("s", "p"),
    "broker-bad-response",
    "authorized without a session token is refused"
  );
}

console.log("\n--- getInstallationToken ---");
{
  const { impl, calls } = stub(() =>
    json({
      token: "ghs_installationtoken",
      expiresAt: 1_800_003_600_000,
      repository: "mmw-devs/ffxiv-race-ops",
      permissions: { contents: "write", pull_requests: "write" },
    })
  );
  const client = new BrokerClient({ brokerUrl: BASE, fetchImpl: impl });
  const t = await client.getInstallationToken("sess_abcdefgh");
  eq(calls[0].url, `${BASE}/installation-token`, "posts to /installation-token");
  eq(calls[0].init.headers.Authorization, "Bearer sess_abcdefgh", "the session is sent as a bearer");
  eq(t.token, "ghs_installationtoken", "token returned");
  eq(t.repository, "mmw-devs/ffxiv-race-ops", "repository returned");
  eq(t.permissions.contents, "write", "permissions returned");
}

{
  const { impl } = stub(() => json({ message: "nope" }, 401));
  const client = new BrokerClient({ brokerUrl: BASE, fetchImpl: impl });
  await rejectsWith(() => client.getInstallationToken("s"), "session-rejected", "401 means the session is gone");
}

{
  const { impl } = stub(() => json({ message: "slow down" }, 429));
  const client = new BrokerClient({ brokerUrl: BASE, fetchImpl: impl });
  await rejectsWith(() => client.getInstallationToken("s"), "broker-bad-response", "429 is reported as rate limiting");
}

{
  const { impl, calls } = stub(() => json({ token: "ghs_x" }));
  const client = new BrokerClient({ brokerUrl: BASE, fetchImpl: impl });
  await rejectsWith(
    () => client.getInstallationToken("s"),
    "broker-bad-response",
    "a reply without an expiry is refused"
  );
  eq(calls.length, 1, "one attempt, no retry storm");
}

{
  const client = new BrokerClient({
    brokerUrl: BASE,
    fetchImpl: stub(() => json({})).impl,
  });
  await rejectsWith(() => client.getInstallationToken(""), "session-required", "no session, no call");
}

console.log("\n--- failure mapping ---");
{
  const timeoutErr = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const client = new BrokerClient({
    brokerUrl: BASE,
    fetchImpl: async () => {
      throw timeoutErr;
    },
    timeoutMs: 1234,
  });
  let caught = null;
  try {
    await client.startSession();
  } catch (err) {
    caught = err;
  }
  eq(caught?.code, "broker-timeout", "a timeout maps to broker-timeout");
  truthy(/1234ms|1.234s|within 1/.test(caught?.message ?? ""), "the message names the deadline");
}

{
  const client = new BrokerClient({
    brokerUrl: BASE,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await rejectsWith(() => client.startSession(), "broker-unreachable", "a network error maps to broker-unreachable");
}

console.log("\n--- revoke ---");
{
  const { impl, calls } = stub(() => json({ ok: true }));
  const client = new BrokerClient({ brokerUrl: BASE, fetchImpl: impl });
  await client.revoke("sess_abcdefgh");
  eq(calls[0].url, `${BASE}/session/revoke`, "posts to /session/revoke");
  eq(calls[0].init.headers.Authorization, "Bearer sess_abcdefgh", "revoke is authenticated");
}
{
  const { impl, calls } = stub(() => json({ ok: true }));
  const client = new BrokerClient({ brokerUrl: BASE, fetchImpl: impl });
  await client.revoke("");
  eq(calls.length, 0, "no session means no request");
}

console.log("\n--- tokens never appear in error messages ---");
{
  const { impl } = stub(() => json({ status: "authorized", sessionToken: "sess_should_not_leak" }));
  const client = new BrokerClient({ brokerUrl: BASE, fetchImpl: impl });
  let caught = null;
  try {
    await client.pollSession("s", "p");
  } catch (err) {
    caught = err;
  }
  truthy(Boolean(caught), "the malformed reply throws");
  truthy(!String(caught?.message).includes("should_not_leak"), "the message does not quote the token");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
