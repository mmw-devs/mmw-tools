#!/usr/bin/env node
/**
 * Resolve the Feishu tenant_key from the app credentials, so it can be copied
 * into MMW_ORIGIN's sibling setting FEISHU_TENANT_KEY.
 *
 * Usage (from mmw-tools-auth/):
 *   node scripts/fetch-tenant-key.mjs
 *
 * Requires a valid App ID / App Secret. It prints the tenant key and tenant
 * name only; the tenant_access_token is never printed.
 */
import { existsSync } from "node:fs";

if (existsSync(".env")) {
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    console.error(`could not load .env: ${error.message}`);
    process.exit(1);
  }
}

const appId = process.env.FEISHU_APP_ID?.trim();
const appSecret = process.env.FEISHU_APP_SECRET?.trim();
if (!appId || !appSecret) {
  console.error("FEISHU_APP_ID / FEISHU_APP_SECRET are missing (put them in .env)");
  process.exit(1);
}

async function postJson(url, body, token) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    throw new Error(`HTTP ${response.status}, code=${data.code ?? "?"}, msg=${data.msg ?? "?"}`);
  }
  return data;
}

async function getJson(url, token) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    throw new Error(`HTTP ${response.status}, code=${data.code ?? "?"}, msg=${data.msg ?? "?"}`);
  }
  return data;
}

try {
  const token = await postJson(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    { app_id: appId, app_secret: appSecret }
  );
  const tenant = await getJson(
    "https://open.feishu.cn/open-apis/tenant/v2/tenant/query",
    token.tenant_access_token
  );
  const info = tenant.tenant ?? {};
  console.log(`tenant_key: ${info.tenant_key ?? "(missing)"}`);
  console.log(`name:       ${info.name ?? "(missing)"}`);
  if (!info.tenant_key) {
    console.error("the response did not contain tenant_key; check the app permissions");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`could not fetch tenant_key: ${error.message}`);
  process.exitCode = 1;
}
