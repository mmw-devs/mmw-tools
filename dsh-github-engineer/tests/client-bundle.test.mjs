#!/usr/bin/env node
// tests/client-bundle.test.mjs
//
// Verifies the built lib/client.js matches the shape expected by
// DSH's `window.__ModuleLoader__`. Runs purely against the file
// contents — no React runtime needed in the test process.
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
  truthy(/id:\s*["']dsh-github-engineer["']/.test(loaderBody), "id is dsh-github-engineer");
  truthy(/factory:\s*\(/.test(loaderBody), "factory function provided");
}

// 2. The factory body must:
//    - declare `module`, `exports`
//    - require react + react/jsx-runtime
//    - export apply, inject (buildPanel optional but present)
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

// 3. Panel registration uses the slot API.
truthy(
  /ctx\.slots\.inject\(["']settings\.section["']/.test(src),
  "panel registered into settings.section slot"
);
truthy(
  /ctx\.slots\.register\(\s*\{[\s\S]*?id:\s*["']github-engineer["']/.test(src),
  "panel registered with id=dgithub-engineer"
);
truthy(
  /ctx\.slots\.register\([\s\S]*?order:\s*240[\s\S]*?label:\s*\(\)\s*=>\s*["']GitHub Engineer["']/.test(src),
  "panel label = 'GitHub Engineer' at order 240"
);

// 4. The panel must use the runtime's React hooks (no top-level React imports).
truthy(
  /buildPanel\s*\(\s*runtime\s*\)/.test(src),
  "panel built from runtime (no top-level React imports)"
);

// 5. api.js was inlined.
truthy(
  /class\s+GithubApiError/.test(src),
  "GithubApiError class inlined from api.ts"
);
truthy(
  /getStatus\(\)\s*\{[\s\S]*?\/api\/github-engineer\/status/.test(src),
  "getStatus() calls /api/github-engineer/status"
);

/* ============================================================== */
/*  Test: the panel renders only PANEL-CONTRACT §4 controls         */
/* ============================================================== */
console.log("\n--- panel controls match the contract ---");
{
  const src = readFileSync(CLIENT_JS, "utf8");
  const allowed = ["登录 GitHub", "重新获取仓库权限", "退出登录", "取消"];
  const forbidden = ["我已完成授权", "Connect GitHub", "刷新", "user_code", "verification_uri"];

  for (const text of allowed) {
    truthy(src.includes(text), `control present: ${text}`);
  }
  for (const text of forbidden) {
    truthy(!src.includes(text), `removed control absent: ${text}`);
  }

  // §5.1: authorizing polls itself, so no "I finished" step can exist.
  truthy(/setInterval\(/.test(src), "the panel polls while authorizing");
  truthy(/phase === "authorizing"/.test(src), "polling is gated on the authorizing phase");

  // The four phases must all be handled by the renderer.
  for (const phase of ["signed_out", "authorizing", "signed_in", "expired"]) {
    truthy(src.includes(`"${phase}"`), `phase handled: ${phase}`);
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);