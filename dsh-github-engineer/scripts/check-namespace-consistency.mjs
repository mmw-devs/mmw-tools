#!/usr/bin/env node
// scripts/check-namespace-consistency.mjs
//
// Verifies that the plugin's identifier strings agree across:
//   - cordis.patch.yml     (- id: and name:)
//   - src/const.ts         (PLUGIN_ID and PLUGIN_DISPLAY_NAME)
//   - mcp-server/src/index.ts (Server.serverInfo.name)
//   - package.json         (top-level `name` field)
//
// Run: node scripts/check-namespace-consistency.mjs
//
// Exits 0 if every check passes; non-zero with a diagnostic if not.
// Wired into package.json as `pnpm check:namespace`.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/** Read a TS file as text and extract every `export const X = "..."` literal. */
function readConstExports(file) {
  if (!existsSync(file)) return {};
  const src = readFileSync(file, "utf8");
  /** @type {Record<string,string>} */
  const out = {};
  const re = /export const (\w+)\s*=\s*"([^"]*)"/g;
  for (let m; (m = re.exec(src)); ) {
    out[m[1]] = m[2];
  }
  return out;
}

/** Read cordis.patch.yml and pull out the first `- id:` and `name:` after it. */
function readCordisPatch(file) {
  if (!existsSync(file)) return { id: null, name: null };
  const text = readFileSync(file, "utf8");
  const idMatch = text.match(/-\s*id:\s*([A-Za-z0-9_-]+)/);
  const afterId = idMatch ? text.slice(text.indexOf(idMatch[0]) + idMatch[0].length) : "";
  const nameMatch = afterId.match(/\bname:\s*([A-Za-z0-9._-]+)/);
  return {
    id: idMatch ? idMatch[1] : null,
    name: nameMatch ? nameMatch[1] : null,
  };
}

/** Read package.json's top-level `name`. */
function readPackageName(file) {
  if (!existsSync(file)) return null;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  return typeof pkg.name === "string" ? pkg.name : null;
}

/**
 * Read MCP server's `Server({ name: ..., version: ... })` literal.
 * Accepts either string literals or const references exported from the
 * same package (e.g. `name: PLUGIN_DISPLAY_NAME`).
 */
function readMcpServerInfo(file, localConsts) {
  if (!existsSync(file)) return { name: null, version: null };
  const src = readFileSync(file, "utf8");
  const m = src.match(
    /new\s+Server\(\s*\{\s*name:\s*(?:"([^"]*)"|(\w+))\s*,\s*version:\s*(?:"([^"]*)"|(\w+))/
  );
  if (!m) return { name: null, version: null };
  const nameRaw = m[1] ?? (m[2] ? localConsts[m[2]] ?? m[2] : null);
  const versionRaw = m[3] ?? (m[4] ? localConsts[m[4]] ?? m[4] : null);
  return { name: nameRaw, version: versionRaw };
}

const files = {
  cordis: path.join(ROOT, "cordis.patch.yml"),
  constTs: path.join(ROOT, "src", "const.ts"),
  mcpConstTs: path.join(ROOT, "mcp-server", "src", "const.ts"),
  mcpSrc: path.join(ROOT, "mcp-server", "src", "index.ts"),
  bundlePkg: path.join(ROOT, "package.json"),
  mcpPkg: path.join(ROOT, "mcp-server", "package.json"),
  clientJs: path.join(ROOT, "lib", "client.js"),
};

const cordis = readCordisPatch(files.cordis);
const consts = readConstExports(files.constTs);
const mcpConsts = readConstExports(files.mcpConstTs);
const mcpInfo = readMcpServerInfo(files.mcpSrc, mcpConsts);
const bundleName = readPackageName(files.bundlePkg);
const mcpName = readPackageName(files.mcpPkg);

/** True if lib/client.js exists AND registers an id matching
 *  `dsh-github-engineer` via __ModuleLoader__. */
function clientBundleShapeOk(file, pluginId) {
  if (!existsSync(file)) return null;
  const src = readFileSync(file, "utf8");
  const loaderBody = src.match(
    /window\.__ModuleLoader__\.load\(\s*\{([^}]+)\}/
  );
  if (!loaderBody) return false;
  return new RegExp(`id:\\s*["']${pluginId}["']`).test(loaderBody[1]);
}

const checks = [
  {
    label: "cordis.patch.yml `- id:` matches src/const.ts PLUGIN_ID",
    actual: cordis.id,
    expected: consts.PLUGIN_ID,
  },
  {
    label: "cordis.patch.yml `name:` matches src/const.ts PLUGIN_DISPLAY_NAME",
    actual: cordis.name,
    expected: consts.PLUGIN_DISPLAY_NAME,
  },
  {
    label: "package.json `name` matches src/const.ts PLUGIN_DISPLAY_NAME",
    actual: bundleName,
    expected: consts.PLUGIN_DISPLAY_NAME,
  },
  {
    label: "mcp-server package.json `name` is `dsh-github-engineer-mcp`",
    actual: mcpName,
    expected: "dsh-github-engineer-mcp",
  },
  {
    label: "mcp-server Server.serverInfo.name matches PLUGIN_DISPLAY_NAME",
    actual: mcpInfo.name,
    expected: consts.PLUGIN_DISPLAY_NAME,
  },
  {
    label: "src/const.ts PLUGIN_NAMESPACE starts with mcp__<PLUGIN_ID>__",
    actual: consts.PLUGIN_NAMESPACE,
    expected: `mcp__${consts.PLUGIN_ID}__`,
  },
  {
    label:
      "mcp-server/src/const.ts PLUGIN_DISPLAY_NAME matches src/const.ts",
    actual: mcpConsts.PLUGIN_DISPLAY_NAME,
    expected: consts.PLUGIN_DISPLAY_NAME,
  },
  {
    label: "lib/client.js exists and registers id=dsh-github-engineer",
    actual: clientBundleShapeOk(files.clientJs, "dsh-github-engineer"),
    expected: true,
  },
];

let pass = 0;
let fail = 0;
for (const c of checks) {
  const ok = c.actual === c.expected;
  if (ok) {
    pass++;
    console.log(`  PASS  ${c.label}`);
  } else {
    fail++;
    console.error(`  FAIL  ${c.label}`);
    console.error(`        expected: ${JSON.stringify(c.expected)}`);
    console.error(`        actual:   ${JSON.stringify(c.actual)}`);
  }
}

console.log(`\n${pass} pass, ${fail} fail`);

if (fail > 0) {
  console.error(
    "\nFix the discrepancies. The plugin's identifier strings must be\n" +
      "edited in src/const.ts FIRST, then propagated to the matching\n" +
      "field in cordis.patch.yml, package.json, and mcp-server/src/index.ts."
  );
  process.exit(1);
}