#!/usr/bin/env node
/**
 * Print the effective auth-core configuration and the two Feishu URLs that must
 * match the developer console. Never prints the app secret or any token.
 *
 * Usage (from mmw-tools-auth/):
 *   node scripts/check-config.mjs
 *   node scripts/check-config.mjs --verify-feishu
 *
 * The optional Feishu check calls the app_access_token endpoint. It is the only
 * way to prove the App ID / App Secret pair without a browser login; it prints
 * only the result code, never the token.
 */
import { existsSync } from "node:fs";
import { loadConfig, ConfigError } from "../src/config.mjs";
import { Policy, PolicyError } from "../src/policy.mjs";

const VERIFY = process.argv.includes("--verify-feishu");
const EXPECTED_ORIGIN = "https://mmw-tools.mmw-team.icu";

if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
    console.log("loaded .env");
  } catch (error) {
    console.error(`could not load .env: ${error.message}`);
    process.exitCode = 1;
  }
} else {
  console.warn("warning: .env not found; relying on the current environment");
}

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`config error: ${error.message}`);
    console.error("fill the missing keys in .env (see .env.example)");
  } else {
    console.error("config error:", error);
  }
  process.exit(1);
}

let policy;
try {
  policy = Policy.load(config.contractsDir);
} catch (error) {
  console.error(error instanceof PolicyError ? `contract error: ${error.message}` : error);
  process.exit(1);
}

const mask = (value) => {
  if (!value) return "(missing)";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)} (len=${value.length})`;
};

console.log("");
console.log("Feishu app");
console.log(`  appId:        ${config.appId}`);
console.log(`  appSecret:    ${mask(config.appSecret)}`);
console.log(`  tenantKey:    ${mask(config.tenantKey)}`);
console.log(`  adminOpenId:  ${config.adminOpenId ? mask(config.adminOpenId) : "(missing)"}`);
console.log(`  bootstrap:    ${config.bootstrapToken ? "set (one-time)" : "(missing)"}`);
console.log("");
console.log("Public URLs (must match the Feishu console exactly)");
console.log(`  MMW_ORIGIN:   ${config.origin}`);
console.log(`  homepage:     ${config.origin}/`);
console.log(`  redirect URI: ${config.origin}/auth/feishu/callback`);
if (config.origin !== EXPECTED_ORIGIN) {
  console.warn(`  warning: production origin is ${EXPECTED_ORIGIN}; current config is ${config.origin}`);
}
console.log("");
console.log("Contracts");
console.log(`  directory:    ${config.contractsDir}`);
console.log(`  catalog:      ${policy.catalogRevision}`);
console.log(`  tools:        ${policy.toolCount}`);
console.log("");

if (!config.adminOpenId && !config.bootstrapToken) {
  console.warn("warning: neither MMW_ADMIN_OPEN_ID nor MMW_BOOTSTRAP_TOKEN is set; nobody can administer members");
}

if (VERIFY) {
  console.log("Verifying Feishu app credentials against the token endpoint…");
  try {
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.code === 0) {
      console.log("  Feishu app credentials: valid");
    } else {
      console.error(
        `  Feishu app credentials: rejected (HTTP ${response.status}, code=${body.code ?? "?"}, msg=${body.msg ?? "?"})`
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`  Feishu app credentials: could not verify (${error.message})`);
    process.exitCode = 1;
  }
}

if (process.exitCode) {
  console.error("\nconfiguration check failed");
} else {
  console.log("configuration check passed");
}
