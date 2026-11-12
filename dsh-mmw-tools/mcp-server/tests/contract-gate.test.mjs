#!/usr/bin/env node
// mcp-server/tests/contract-gate.test.mjs
//
// The merge contract gate is pure logic over (contract, op-log commands);
// this test exercises it without GitHub. Build mcp-server first
// (`pnpm build` in mcp-server, or tsc for just this file).

import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist", "tools", "contract-gate.js");

if (!existsSync(DIST)) {
  console.error("Run `pnpm build` in mcp-server first.");
  process.exit(2);
}

const { extractCommands, evaluateMergeContract } = await import(
  pathToFileURL(DIST).href
);

let pass = 0;
let fail = 0;
const ok = (l) => {
  pass++;
  console.log(`  PASS  ${l}`);
};
const bad = (l, d) => {
  fail++;
  console.error(`  FAIL  ${l}${d ? `: ${d}` : ""}`);
};
const eq = (a, w, label) =>
  JSON.stringify(a) === JSON.stringify(w)
    ? ok(`${label} = ${JSON.stringify(w)}`)
    : bad(label, `expected ${JSON.stringify(w)}, got ${JSON.stringify(a)}`);

const CONTRACT = {
  levels: {
    L1: { agentMerge: false },
    L2: { agentMerge: true },
    L3: { agentMerge: false },
  },
  domains: [
    {
      commands: [
        { id: "query.pending-prs", level: "L1" },
        { id: "progress.update", level: "L2" },
        { id: "event.end", level: "L3" },
      ],
    },
  ],
};

// The real ops op-log shape: four backticks, CRLF, body-only text.
const OPS_MESSAGE = [
  "content: 更新战况",
  "",
  "````json",
  "{",
  '  "operator": "BlueEYEDiamond",',
  '  "timestamp": "2026-11-11T11:56:00Z",',
  '  "command": "progress.update",',
  '  "changes": []',
  "}",
  "````",
  "",
  "Co-authored-by: BlueEYEDiamond <lanyanzuanshi1104@gmail.com>",
].join("\r\n");

console.log("\n--- extractCommands ---");
eq(extractCommands(OPS_MESSAGE), ["progress.update"], "four-backtick CRLF block");
eq(
  extractCommands('```json\n{ "command": "event.end" }\n```'),
  ["event.end"],
  "three-backtick block"
);
eq(
  extractCommands(
    '````json\n{ "command": "a.b" }\n````\n\ntext\n\n````json\n{ "command": "c.d" }\n````'
  ),
  ["a.b", "c.d"],
  "two blocks"
);
eq(extractCommands("no log here"), [], "no block");
eq(extractCommands('```json\n{ "command": }\n```'), [], "malformed JSON");
eq(extractCommands('```json\n["command"]\n```'), [], "JSON array");
eq(extractCommands('```json\n{ "command": "  " }\n```'), [], "blank command");

console.log("\n--- evaluateMergeContract ---");
eq(evaluateMergeContract(CONTRACT, ["progress.update"]).allowed, true, "L2 allowed");
eq(evaluateMergeContract(CONTRACT, ["event.end"]).allowed, false, "L3 refused");
eq(evaluateMergeContract(CONTRACT, ["query.pending-prs"]).allowed, false, "L1 refused");
eq(evaluateMergeContract(CONTRACT, []).allowed, false, "no command refused");
eq(evaluateMergeContract(CONTRACT, ["nope.nope"]).allowed, false, "unknown command refused");
eq(
  evaluateMergeContract(
    { levels: { L2: {} }, domains: [{ commands: [{ id: "progress.update", level: "L2" }] }] },
    ["progress.update"]
  ).allowed,
  false,
  "level without agentMerge refused"
);
eq(
  evaluateMergeContract(CONTRACT, ["progress.update", "event.end"]).allowed,
  false,
  "L2 + L3 in one PR refused"
);
const verdict = evaluateMergeContract(CONTRACT, ["event.end"]);
if (verdict.reason.includes("agentMerge=false")) ok("L3 reason names agentMerge=false");
else bad("L3 reason names agentMerge=false", verdict.reason);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
