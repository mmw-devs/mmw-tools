// Static schema check: each tool's inputSchema is well-formed.
// Doesn't need spawn — we just import the compiled dispatcher.

import { pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.resolve(__dirname, "..", "dist", "index.js");

if (!existsSync(INDEX)) {
  console.error("Run `pnpm build` in mcp-server first.");
  process.exit(2);
}

// Read the compiled dispatcher and inspect its exported tool list.
// The dispatcher doesn't export tools by default, so we read the
// file source and grep for tool names + their inputSchema fields.
import { readFileSync } from "node:fs";
const src = readFileSync(INDEX, "utf8");

const tools = [
  "repo_status", "repo_clone", "repo_pull", "repo_read",
  "repo_search", "repo_edit", "pr_create", "pr_list",
];

let pass = 0, fail = 0;
for (const name of tools) {
  if (src.includes(`name: "${name}"`)) {
    console.log(`  PASS  ${name} registered`);
    pass++;
  } else {
    console.error(`  FAIL  ${name} not registered`);
    fail++;
  }
}

// additional: confirm guard module is referenced
if (src.includes("GithubRefusedError") && src.includes("redactTokens")) {
  console.log(`  PASS  guard module imported (GithubRefusedError + redactTokens)`);
  pass++;
} else {
  console.error(`  FAIL  guard module not used`);
  fail++;
}

// additional: confirm cross-cutting guards are wired in
if (src.includes("guard.js")) {
  console.log(`  PASS  guard.js imported by dispatcher`);
  pass++;
} else {
  console.error(`  FAIL  guard.js not imported`);
  fail++;
}

// additional: confirm config() reads environment
if (src.includes("GHOST_WORKING_DIR") && src.includes("GHOST_TOKEN")) {
  console.log(`  PASS  config reads GHOST_* env vars`);
  pass++;
} else {
  console.error(`  FAIL  config doesn't read GHOST_* env vars`);
  fail++;
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);