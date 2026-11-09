#!/usr/bin/env node
// Guards the documentation rules in docs/DOCUMENTATION.md. Narrative docs must
// link to the contract instead of copying facts that drift. This check is
// deliberately small: it catches the known stale identifiers and missing
// status labels, not prose quality.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LIVING_DOCS = [
  "README.md",
  "AGENTS.md",
  "contracts/README.md",
  "docs/DOCUMENTATION.md",
  "docs/OBSERVABILITY.md",
  "mmw-tools-routing-layer-plan.md",
  "mmw-tools-auth/README.md",
  "dsh-mmw-tools/README.md",
];

const STATUS_DOCS = [
  "docs/OBSERVABILITY.md",
  "mmw-tools-routing-layer-plan.md",
  "mmw-tools-routing-state-machine.md",
  "dsh-mmw-tools/docs/NEXT-STEPS.md",
];

// [pattern, why] — only identifiers that were actually stale at some point.
const FORBIDDEN = [
  [/\bfeatures\.json\b/, "the feature catalog file was replaced by contracts/tools.json"],
  [/\brace-ops\.(?:read|edit|pr)\b/, "the old permission names were replaced by tool/operation roles"],
  [/当前\s*\d+\s*个用例/, "test counts drift; describe coverage instead"],
  [/\b\d+\s+(?:[\w.-]+\s+){0,3}(?:tests?|assertions?)\b/i, "test counts drift; describe coverage instead"],
  [/\b(?:ten|nine|eleven|twelve)\s+MCP tools\b/i, "tool counts drift; link to contracts instead"],
];

const failures = [];

for (const rel of LIVING_DOCS) {
  const file = path.join(ROOT, rel);
  if (!existsSync(file)) {
    failures.push(`${rel}: missing living document`);
    continue;
  }
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(line)) {
        failures.push(`${rel}:${index + 1}: ${why}\n  ${line.trim()}`);
      }
    }
  });
}

for (const rel of STATUS_DOCS) {
  const file = path.join(ROOT, rel);
  if (!existsSync(file)) {
    failures.push(`${rel}: missing document with a status label`);
    continue;
  }
  const head = readFileSync(file, "utf8").split(/\r?\n/).slice(0, 20).join("\n");
  if (!/Status:\s*\**(?:living|target design|historical)/i.test(head)) {
    failures.push(`${rel}: add a "Status: living | target design | historical" line near the top`);
  }
}

if (failures.length > 0) {
  console.error("docs check failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("\nSee docs/DOCUMENTATION.md for the rules.");
  process.exit(1);
}

console.log(`docs OK: ${LIVING_DOCS.length} living document(s), ${STATUS_DOCS.length} status label(s)`);
