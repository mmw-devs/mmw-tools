/**
 * mcp-server/tests/tools-list.test.mjs
 *
 * Starts the MCP server as a real stdio child process, performs the
 * JSON-RPC handshake, and asserts that `tools/list` advertises the
 * eight tools with object input schemas.
 *
 * This is the only suite that proves the server *starts*: every other
 * MCP-side test imports the compiled modules in-process and therefore
 * never exercises `StdioServerTransport`.
 *
 * Requires `child_process.spawn` with piped stdio. Where the sandbox
 * denies that with EPERM, the suite prints SKIP and exits 0; it runs
 * for real in CI and in an ordinary terminal.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(__dirname, "..", "dist", "index.js");

const EXPECTED = [
  "pr_create",
  "pr_list",
  "repo_clone",
  "repo_edit",
  "repo_pull",
  "repo_read",
  "repo_search",
  "repo_status",
];

const REQUESTS = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "tools-list-test", version: "0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
];

function skip(reason) {
  console.log("");
  console.log(`  SKIP  ${reason}`);
  console.log("        The MCP server was NOT started; stdio transport is unverified.");
  console.log("");
  process.exit(0);
}

let child;
try {
  child = spawn(process.execPath, [ENTRY], {
    // stdin must be piped: the handshake is written to the child.
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env },
  });
} catch (err) {
  if (err?.code === "EPERM") skip("child_process.spawn denied (EPERM) in this sandbox");
  throw err;
}

let stderrSeen = "";
child.stderr?.on("data", (b) => (stderrSeen += b.toString("utf8")));

// A spawn that fails asynchronously (rather than throwing) surfaces here.
child.on("error", (err) => {
  if (err?.code === "EPERM") skip("child_process.spawn denied (EPERM) in this sandbox");
  console.error(`  FAIL  spawn error: ${err?.message}`);
  process.exit(1);
});

let out = "";
child.stdout.on("data", (b) => (out += b.toString("utf8")));

for (const request of REQUESTS) {
  child.stdin.write(JSON.stringify(request) + "\n");
}
// Close stdin so the server sees end-of-input if it ever waits for it.
child.stdin.end();

const timeout = setTimeout(() => {
  console.error("  FAIL  the MCP server did not answer tools/list within 5s");
  if (stderrSeen) console.error(`        stderr: ${stderrSeen.slice(0, 400)}`);
  child.kill();
  process.exit(1);
}, 5000);
timeout.unref?.();

await new Promise((resolve) => child.on("close", resolve));
clearTimeout(timeout);

const responses = out
  .split("\n")
  .filter((line) => line.trim().startsWith("{"))
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const init = responses.find((r) => r.id === 1);
const toolsResp = responses.find((r) => r.id === 2);

let fail = 0;
function check(condition, label, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
  }
}

check(Boolean(init?.result?.serverInfo?.name), "initialize returned serverInfo", JSON.stringify(init));
check(
  init?.result?.serverInfo?.name === "dsh-github-engineer",
  "serverInfo.name is dsh-github-engineer",
  init?.result?.serverInfo?.name
);
check(Boolean(toolsResp), "tools/list responded", stderrSeen.slice(0, 200));

const tools = toolsResp?.result?.tools ?? [];
check(Array.isArray(tools), "result.tools is an array");

const names = tools.map((t) => t.name).sort();
check(names.length === 8, `tools/list advertises 8 tools (got ${names.length})`, names.join(", "));
for (const name of EXPECTED) {
  check(names.includes(name), `${name} advertised`);
}

const badSchemas = tools.filter((t) => t.inputSchema?.type !== "object");
check(badSchemas.length === 0, "every tool has an object inputSchema", badSchemas.map((t) => t.name).join(", "));

console.log("");
if (fail > 0) {
  console.error(`${fail} check(s) failed`);
  process.exit(1);
}
console.log(`OK: MCP server started over stdio and advertised ${names.length} tools`);
