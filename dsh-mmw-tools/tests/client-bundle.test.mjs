#!/usr/bin/env node
// tests/client-bundle.test.mjs
//
// Verifies the built lib/client.js matches the shape expected by
// DSH's `window.__ModuleLoader__`. Runs purely against the file
// contents — no React runtime needed in the test process.
//
// The client has exactly one credential surface: Feishu. The GitHub user
// login (and its second settings section) was removed deliberately; the
// broker owns the GitHub App identity.
//
// Run: node tests/client-bundle.test.mjs

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CLIENT_JS = path.join(ROOT, "lib", "client.js");

let pass = 0;
let fail = 0;

function ok(label) {
  pass++;
  console.log(`  PASS  ${label}`);
}
function bad(label, msg) {
  fail++;
  console.error(`  FAIL  ${label}: ${msg}`);
}
function truthy(value, hint) {
  if (value) ok(hint);
  else bad(hint, "expected truthy");
}

if (!existsSync(CLIENT_JS)) {
  console.error(`SKIP: ${CLIENT_JS} not found. Run \`pnpm build:all\` first.`);
  process.exit(0);
}

const src = readFileSync(CLIENT_JS, "utf8");

// 1. Must register itself with __ModuleLoader__.load({ id, factory }).
const loaderMatch = src.match(/window\.__ModuleLoader__\.load\(\s*\{([^}]+)\}/);
truthy(loaderMatch !== null, "window.__ModuleLoader__.load called");

if (loaderMatch) {
  const loaderBody = loaderMatch[1];
  truthy(/id:\s*["']dsh-mmw-tools["']/.test(loaderBody), "id is dsh-mmw-tools");
  truthy(/factory:\s*\(/.test(loaderBody), "factory function provided");
}

// 2. The factory body must:
//    - declare `module`, `exports`
//    - require react + react/jsx-runtime
//    - export apply, inject
const factoryMatch = src.match(/factory:\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*)\n\s*\}\s*,\s*\}\)[\s;]*$/m);
truthy(factoryMatch !== null, "factory is an arrow function");

if (factoryMatch) {
  const factoryBody = factoryMatch[2];

  truthy(
    /var\s+module\s*=\s*\{\s*exports:\s*\{\s*\}\s*\}/.test(factoryBody),
    "factory declares module = { exports: {} }"
  );
  truthy(
    /let\s+react\s*=\s*require\(["']react["']\)/.test(factoryBody),
    "factory requires react"
  );
  truthy(
    /let\s+react_jsx_runtime\s*=\s*require\(["']react\/jsx-runtime["']\)/.test(factoryBody),
    "factory requires react/jsx-runtime"
  );
  truthy(/exports\.apply\s*=\s*apply;/.test(factoryBody), "exports.apply = apply");
  truthy(/exports\.inject\s*=\s*inject;/.test(factoryBody), "exports.inject = inject");
  truthy(/return\s+module\.exports/.test(factoryBody), "returns module.exports");
}

// 3. Exactly one settings section, labelled MMW Tools.
truthy(
  /ctx\.slots\.inject\(["']settings\.section["']/.test(src),
  "panel registered into settings.section slot"
);
truthy(
  /ctx\.slots\.register\(\s*\{[\s\S]*?id:\s*["']mmw-tools["']/.test(src),
  "panel registered with id=dmmw-tools"
);
truthy(
  /ctx\.slots\.register\([\s\S]*?order:\s*240[\s\S]*?label:\s*\(\)\s*=>\s*["']MMW Tools["']/.test(src),
  "panel label = 'MMW Tools' at order 240"
);
truthy(!src.includes("mmw-tools-feishu"), "the second settings section is gone");

// 4. The panel must use the runtime's React hooks (no top-level React imports).
truthy(
  /buildFeishuPanel\s*\(\s*runtime\s*\)/.test(src),
  "Feishu panel built from runtime (no top-level React imports)"
);

// 5. api.js and the shared route table were inlined; the GitHub API is gone.
truthy(!src.includes("GithubApiError"), "GithubApiError no longer inlined");
truthy(!src.includes("githubApi"), "no GitHub API client in the bundle");
truthy(
  /const API = \{[\s\S]*?status:\s*"\/api\/mmw-tools\/status"/.test(src),
  "shared route table inlined from src/shared/api-paths.ts"
);
truthy(
  /getStatus\(\)\s*\{[\s\S]*?request\(API\.feishuStatus\)/.test(src),
  "getStatus() uses the shared Feishu status constant"
);
truthy(src.includes("feishuLoginStart"), "Feishu login route is inlined");
truthy(!src.includes("/api/mmw-tools/oauth/"), "no OAuth route strings remain");

/* ============================================================== */
/*  Test: the panel renders only the Feishu controls                */
/* ============================================================== */
console.log("\n--- panel controls match the contract ---");
{
  const allowed = ["使用飞书登录", "退出飞书", "等待浏览器授权"];
  const forbidden = ["登录 GitHub", "Connect GitHub", "GithubApi", "user_code", "verification_uri"];

  for (const text of allowed) {
    truthy(src.includes(text), `control present: ${text}`);
  }
  for (const text of forbidden) {
    truthy(!src.includes(text), `removed control absent: ${text}`);
  }

  // Login polls itself; there is no "I finished" step.
  truthy(/setInterval\(/.test(src), "the panel polls while authorizing");
  truthy(/loginPoll\(\)/.test(src), "polling calls the Feishu login endpoint");
  truthy(/view\.signedIn/.test(src), "the panel renders from the Feishu status");
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
