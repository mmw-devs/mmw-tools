#!/usr/bin/env node
/**
 * tests/github-app.test.mjs
 *
 * Offline tests for the GitHub App auth module (docs/AUTH-BROKER.md §8a).
 *
 * Everything here runs without network: the RSA keypair is generated in
 * the test, and `fetch` is a stub. That matters because the App private
 * key is the single most sensitive secret in this design, and its
 * signing path must be provable without ever touching GitHub.
 */

import { generateKeyPairSync, createVerify } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, "..", "lib", "auth", "github-app.js");
const { mintAppJwt, createInstallationToken, InstallationTokenCache, GithubAppError } =
  await import(pathToFileURL(LIB).href);

let pass = 0;
let fail = 0;
function ok(label) {
  pass++;
  console.log(`  PASS  ${label}`);
}
function bad(label, detail) {
  fail++;
  console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
}
function eq(actual, want, label) {
  if (actual === want) ok(`${label} = ${JSON.stringify(want)}`);
  else bad(label, `expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
}
function truthy(v, label, detail) {
  if (v) ok(label);
  else bad(label, detail ?? "expected truthy");
}
const b64urlJson = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

/* ---------- keypair ---------- */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const APP_ID = 123456;

/* ============================================================== */
console.log("\n--- mintAppJwt: structure ---");
{
  const now = 1_800_000_000;
  const jwt = mintAppJwt({ appId: APP_ID, privateKeyPem: PRIVATE_PEM, now });
  const parts = jwt.split(".");
  eq(parts.length, 3, "JWT has three segments");

  const header = b64urlJson(parts[0]);
  eq(header.alg, "RS256", "header alg");
  eq(header.typ, "JWT", "header typ");

  const payload = b64urlJson(parts[1]);
  eq(payload.iss, String(APP_ID), "iss is the App id as a string");
  eq(payload.iat, now - 60, "iat is backdated 60s");
  eq(payload.exp, now + 540, "exp is 9 minutes out");
  truthy(payload.exp - payload.iat === 600, "total lifetime is 600s (under GitHub's 10-minute cap)");
  eq(
    jwt.includes("="),
    false,
    "every segment is unpadded base64url"
  );
}

console.log("\n--- mintAppJwt: the signature actually verifies ---");
{
  const jwt = mintAppJwt({ appId: APP_ID, privateKeyPem: PRIVATE_PEM, now: 1_800_000_000 });
  const [h, p, s] = jwt.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  verifier.end();
  truthy(
    verifier.verify(PUBLIC_PEM, Buffer.from(s, "base64url")),
    "signature verifies against the public key"
  );

  const tampered = `${h}.${p}.${s.slice(0, -4)}AAAA`;
  const v2 = createVerify("RSA-SHA256");
  v2.update(`${h}.${p}`);
  v2.end();
  truthy(!v2.verify(PUBLIC_PEM, Buffer.from(tampered.split(".")[2], "base64url")), "a tampered signature fails");
}

console.log("\n--- mintAppJwt: bad key is reported without leaking it ---");
{
  let caught = null;
  try {
    mintAppJwt({ appId: APP_ID, privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----" });
  } catch (err) {
    caught = err;
  }
  truthy(caught instanceof GithubAppError, "throws GithubAppError");
  eq(caught?.code, "jwt-invalid-key", "error code");
  truthy(!String(caught?.message).includes("not-a-key"), "message does not echo the key material");
}

/* ============================================================== */
console.log("\n--- createInstallationToken: request shape ---");

function stubFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { impl, calls };
}

function jsonResponse(body, status = 201) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

{
  const { impl, calls } = stubFetch(
    jsonResponse({
      token: "ghs_testtoken",
      expires_at: new Date(1_800_003_600_000).toISOString(),
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      repositories: [{ full_name: "mmw-devs/ffxiv-race-ops" }],
    })
  );
  const out = await createInstallationToken({
    appId: APP_ID,
    privateKeyPem: PRIVATE_PEM,
    installationId: 98765,
    repositories: ["ffxiv-race-ops"],
    fetchImpl: impl,
    now: 1_800_000_000,
  });

  eq(calls.length, 1, "one request");
  eq(
    calls[0].url,
    "https://api.github.com/app/installations/98765/access_tokens",
    "posts to the installation token endpoint"
  );
  eq(calls[0].init.method, "POST", "method is POST");
  truthy(
    String(calls[0].init.headers.Authorization).startsWith("Bearer ey"),
    "authorization carries the App JWT"
  );
  eq(calls[0].init.headers.Accept, "application/vnd.github+json", "accept header");
  eq(
    JSON.parse(calls[0].init.body).repositories[0],
    "ffxiv-race-ops",
    "repository scoping is sent"
  );

  eq(out.token, "ghs_testtoken", "token returned");
  eq(out.expiresAt, 1_800_003_600_000, "expiry parsed from expires_at");
  eq(out.permissions.contents, "write", "permission surfaced");
  eq(out.repositories[0], "mmw-devs/ffxiv-race-ops", "repository surfaced");
}

console.log("\n--- createInstallationToken: failures ---");
{
  const { impl } = stubFetch(jsonResponse({ message: "A JSON web token could not be decoded" }, 401));
  let caught = null;
  try {
    await createInstallationToken({
      appId: APP_ID,
      privateKeyPem: PRIVATE_PEM,
      installationId: 1,
      fetchImpl: impl,
    });
  } catch (err) {
    caught = err;
  }
  eq(caught?.code, "token-exchange-failed", "401 maps to token-exchange-failed");
  truthy(/could not be decoded/.test(caught?.message ?? ""), "GitHub's message is surfaced");
  truthy(!(caught?.message ?? "").includes("eyJ"), "the JWT is not echoed in the error");
}

{
  const { impl } = stubFetch(jsonResponse({ expires_at: "2030-01-01T00:00:00Z" }, 201));
  let caught = null;
  try {
    await createInstallationToken({ appId: APP_ID, privateKeyPem: PRIVATE_PEM, installationId: 1, fetchImpl: impl });
  } catch (err) {
    caught = err;
  }
  eq(caught?.code, "token-response-malformed", "a response without a token is refused");
}

{
  const { impl } = stubFetch(jsonResponse({ token: "ghs_x", expires_at: "not-a-date" }, 201));
  let caught = null;
  try {
    await createInstallationToken({ appId: APP_ID, privateKeyPem: PRIVATE_PEM, installationId: 1, fetchImpl: impl });
  } catch (err) {
    caught = err;
  }
  eq(caught?.code, "token-response-malformed", "an unparseable expiry is refused");
}

{
  const failing = async () => {
    throw new Error("ECONNREFUSED");
  };
  let caught = null;
  try {
    await createInstallationToken({ appId: APP_ID, privateKeyPem: PRIVATE_PEM, installationId: 1, fetchImpl: failing });
  } catch (err) {
    caught = err;
  }
  eq(caught?.code, "token-exchange-failed", "network failure maps to token-exchange-failed");
}

/* ============================================================== */
console.log("\n--- InstallationTokenCache ---");
{
  const cache = new InstallationTokenCache(10 * 60 * 1000);
  const token = { token: "t", expiresAt: 1_000_000, permissions: {}, repositories: [] };
  eq(cache.get(0), null, "empty cache returns null");
  cache.set(token);
  eq(cache.get(0)?.token, "t", "returns the cached token");
  eq(cache.get(1_000_000 - 10 * 60 * 1000), null, "returns null inside the refresh margin");
  eq(cache.get(1_000_000 - 10 * 60 * 1000 - 1)?.token, "t", "returns the token just outside the margin");
  cache.clear();
  eq(cache.get(0), null, "clear empties the cache");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
