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
 *
 * The handshake polls for each response instead of waiting a fixed
 * time or closing stdin: closing stdin can shut the transport down
 * before the reply is flushed, and a fixed sleep is a race on a loaded
 * runner.
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

const RESPONSE_TIMEOUT_MS = 10_000;

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
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch (err) {
  if (err?.code === "EPERM") skip("child_process.spawn denied (EPERM) in this sandbox");
  throw err;
}

let out = "";
let errOut = "";

child.stdout.on("data", (b) => {
  out += b.toString("utf8");
});
child.stderr.on("data", (b) => {
  errOut += b.toString("utf8");
});

const spawnError = new Promise((_resolve, reject) => {
  child.on("error", (err) => {
    if (err?.code === "EPERM") skip("child_process.spawn denied (EPERM) in this sandbox");
    reject(err);
  });
});

function parsedResponses() {
  return out
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
}

function waitForResponse(id) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const found = parsedResponses().find((r) => r.id === id);
      if (found) {
        clearInterval(timer);
        resolve(found);
        return;
      }
      if (Date.now() - started > RESPONSE_TIMEOUT_MS) {
        clearInterval(timer);
        reject(
          new Error(
            `timed out after ${RESPONSE_TIMEOUT_MS}ms waiting for response id=${id}` +
              (errOut ? `; stderr: ${errOut.slice(0, 300)}` : "")
          )
        );
      }
    }, 50);
    timer.unref?.();
  });
}

let init;
let toolsResp;
let failure = null;

try {
  await Promise.race([
    (async () => {
      for (const request of [
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
      ]) {
        child.stdin.write(JSON.stringify(request) + "\n");
      }
      init = await waitForResponse(1);
      toolsResp = await waitForResponse(2);
    })(),
    spawnError,
  ]);
} catch (err) {
  failure = err;
} finally {
  child.kill();
}

if (failure) {
  console.error(`  FAIL  ${failure.message}`);
  process.exit(1);
}

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
  init?.result?.serverInfo?.name === "dsh-mmw-tools",
  "serverInfo.name is dsh-mmw-tools",
  init?.result?.serverInfo?.name
);
check(Boolean(toolsResp), "tools/list responded");

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
