#!/usr/bin/env node
// mcp-server/tests/repo-status.test.mjs
//
// repo_status reports the checkout's remote URL. The URL may embed the
// installation token used by git; the agent-facing output must not leak it.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "..", "dist", "tools", "repo-status.js");

if (!existsSync(DIST)) {
  console.error("Run `pnpm build` in mcp-server first.");
  process.exit(2);
}

const { redactRemoteUrl } = await import(pathToFileURL(DIST).href);

let pass = 0;
let fail = 0;
const ok = (label) => { pass++; console.log(`  PASS  ${label}`); };
const bad = (label, detail) => { fail++; console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`); };
const eq = (a, w, label) => (a === w ? ok(label) : bad(label, `expected ${JSON.stringify(w)}, got ${JSON.stringify(a)}`));

eq(
  redactRemoteUrl("https://x-access-token:ghs_secret@github.com/mmw-devs/xivstrat-relay.git"),
  "https://github.com/mmw-devs/xivstrat-relay.git",
  "the installation token is stripped"
);
eq(
  redactRemoteUrl("https://github.com/mmw-devs/xivstrat-relay.git"),
  "https://github.com/mmw-devs/xivstrat-relay.git",
  "a credential-free URL is unchanged"
);
eq(
  redactRemoteUrl("git@github.com:mmw-devs/xivstrat-relay.git"),
  "git@github.com:mmw-devs/xivstrat-relay.git",
  "an ssh URL is unchanged"
);

console.log(`\nrepo-status: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
