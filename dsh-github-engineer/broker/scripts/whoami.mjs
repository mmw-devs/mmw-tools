/**
 * One-shot: identify the App and list its installations.
 * Reads the key from a path; never prints key material or the JWT.
 *
 *   APP_ID=5469681 APP_KEY=secrets/....pem node broker/scripts/whoami.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const { mintAppJwt } = await import(
  pathToFileURL(path.join(pluginRoot, "lib", "auth", "github-app.js")).href
);

const appId = process.env.APP_ID;
const keyPath = process.env.APP_KEY;
if (!appId || !keyPath) {
  console.error("APP_ID and APP_KEY must be set");
  process.exit(2);
}

const pem = readFileSync(keyPath, "utf8");
console.log(`key: ${path.basename(keyPath)} (${pem.length} bytes, ${pem.includes("BEGIN RSA PRIVATE KEY") ? "PKCS#1" : pem.includes("BEGIN PRIVATE KEY") ? "PKCS#8" : "unknown"})`);

const jwt = mintAppJwt({ appId, privateKeyPem: pem });
console.log(`jwt: minted (${jwt.length} chars)`);

async function get(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dsh-github-engineer-setup",
    },
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

const app = await get("https://api.github.com/app");
console.log(`\nGET /app -> ${app.status}`);
if (app.status === 200) {
  const a = JSON.parse(app.body);
  console.log(`  name: ${a.name}`);
  console.log(`  slug: ${a.slug}`);
  console.log(`  owner: ${a.owner?.login}`);
  const p = a.permissions ?? {};
  console.log(`  permissions: ${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`);
  const events = a.events ?? [];
  console.log(`  webhook events: ${events.length === 0 ? "(none — good)" : events.join(", ")}`);
} else {
  console.log(`  ${app.body.slice(0, 300)}`);
}

const list = await get("https://api.github.com/app/installations");
console.log(`\nGET /app/installations -> ${list.status}`);
if (list.status === 200) {
  const arr = JSON.parse(list.body);
  if (arr.length === 0) {
    console.log("  no installations — install the App on ffxiv-race-ops first");
  }
  for (const inst of arr) {
    console.log(`  installation id: ${inst.id}`);
    console.log(`    account: ${inst.account?.login} (${inst.account?.type})`);
    console.log(`    target: ${inst.target_type}`);
    console.log(`    repository_selection: ${inst.repository_selection}`);
  }
} else {
  console.log(`  ${list.body.slice(0, 300)}`);
}
