#!/usr/bin/env node
// Smoke test: verify the MCP server spawns and exposes one echo tool.
//   pnpm exec tsx tests/smoke.mjs
//   (or: node tests/smoke.mjs after `pnpm build` in mcp-server/)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MCP_ENTRY = path.join(ROOT, "mcp-server", "dist", "index.js");

if (!existsSync(MCP_ENTRY)) {
  console.error(`MCP server not built. Run \`pnpm install && pnpm build\` in ${path.join(ROOT, "mcp-server")} first.`);
  process.exit(2);
}

const child = spawn(process.execPath, [MCP_ENTRY], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, REPO_OWNER: "mmw-devs", REPO_NAME: "ffxiv-race-ops", GHOST_TOKEN: "probe-not-real" },
});

const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
const responses = new Map();

child.stdout.on("data", (buf) => {
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined) {
      responses.set(msg.id, msg);
    }
  }
});

(async () => {
  // initialize
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  await sleep(100);

  // initialized notification
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await sleep(100);

  // tools/list
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await sleep(100);

  // tools/call echo
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { message: "hello from smoke test" } } });
  await sleep(300);

  child.kill();

  const ok_init = responses.get(1)?.result?.serverInfo?.name === "dsh-github-engineer-mcp";
  const tools = responses.get(2)?.result?.tools ?? [];
  const echoTool = tools.find((t) => t.name === "echo");
  const echoResp = responses.get(3)?.result?.content?.[0]?.text ?? "";

  let pass = true;
  if (!ok_init) { console.error("FAIL: initialize"); pass = false; }
  if (!echoTool) { console.error("FAIL: tools/list missing echo"); pass = false; }
  if (!echoResp.includes("hello from smoke test")) { console.error("FAIL: echo did not echo"); pass = false; }
  if (!echoResp.includes("REPO_OWNER=mmw-devs")) { console.error("FAIL: env not propagated"); pass = false; }

  if (pass) {
    console.log("OK: dsh-github-engineer MCP server smoke test passed");
    process.exit(0);
  } else {
    console.error("\n--- echo response ---\n" + echoResp);
    process.exit(1);
  }
})();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }