#!/usr/bin/env node
// Reports which documents must change when a source file changes, and fails
// when a changed object's document was left untouched. The map lives in
// docs/doc-map.json; AGENTS.md carries a generated copy of the same table.
//
// Usage:
//   node scripts/doc-impact.mjs --list
//   node scripts/doc-impact.mjs --base origin/main
//   node scripts/doc-impact.mjs --base origin/main --worktree
//   node scripts/doc-impact.mjs --changed src/a.ts,README.md
//   node scripts/doc-impact.mjs --write-agents
//
// Run `--write-agents` after editing docs/doc-map.json. CI runs the check
// against the pull request's base commit.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = "docs/doc-map.json";
export const AGENTS_PATH = "AGENTS.md";
export const START_MARKER = "<!-- doc-map:start -->";
export const END_MARKER = "<!-- doc-map:end -->";

const STATUSES = new Set(["living", "target design", "historical", "generated"]);

export function normalizePath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

export function globToRegExp(glob) {
  const pattern = normalizePath(glob);
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`${source}$`);
}

export function evaluateImpact(documents, changedFiles) {
  const changed = new Set(changedFiles.map(normalizePath));
  const violations = [];
  for (const document of documents) {
    if (changed.has(normalizePath(document.path))) continue;
    const triggers = [];
    for (const source of document.sources ?? []) {
      const matcher = globToRegExp(source);
      for (const file of changed) {
        if (matcher.test(file)) triggers.push(file);
      }
    }
    if (triggers.length > 0) {
      violations.push({
        document: document.path,
        defines: document.defines,
        triggers: [...new Set(triggers)].sort(),
      });
    }
  }
  return violations;
}

export function validateManifest(documents, root = ROOT) {
  const errors = [];
  if (!Array.isArray(documents) || documents.length === 0) {
    return ["docs/doc-map.json: expected a non-empty documents array"];
  }
  const seen = new Set();
  for (const document of documents) {
    const rel = normalizePath(document.path ?? "");
    const label = rel || "(missing path)";
    if (!rel || path.isAbsolute(rel) || rel.split("/").includes("..")) {
      errors.push(`${label}: path must be repository-relative and must not contain ".."`);
      continue;
    }
    if (seen.has(rel)) errors.push(`${label}: duplicate document entry`);
    seen.add(rel);
    if (!existsSync(path.join(root, rel))) errors.push(`${label}: file does not exist`);
    if (!STATUSES.has(document.status)) {
      errors.push(`${label}: status must be one of ${[...STATUSES].join(", ")}`);
    }
    if (typeof document.defines !== "string" || document.defines.trim() === "") {
      errors.push(`${label}: add a one-line "defines" description`);
    }
    if (document.status === "generated" && !document.generatedBy) {
      errors.push(`${label}: generated documents need "generatedBy"`);
    }
    if (!Array.isArray(document.sources)) {
      errors.push(`${label}: "sources" must be an array (use [] for snapshots)`);
      continue;
    }
    for (const source of document.sources) {
      const normalized = normalizePath(source);
      if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
        errors.push(`${label}: source "${source}" must be repository-relative`);
      }
      if (normalized === rel) {
        errors.push(`${label}: a document cannot list itself as a source`);
      }
    }
  }
  return errors;
}

export function validateManifestCoverage(documents, trackedFiles) {
  const errors = [];
  const tracked = [...new Set(trackedFiles.map(normalizePath))].sort();
  const trackedSet = new Set(tracked);
  const mapped = new Set(documents.map((document) => normalizePath(document.path)));

  for (const file of tracked) {
    if (file.endsWith(".md") && !mapped.has(file)) {
      errors.push(`${file}: tracked markdown is not listed in docs/doc-map.json`);
    }
  }

  for (const document of documents) {
    const rel = normalizePath(document.path);
    if (!trackedSet.has(rel)) {
      errors.push(`${rel}: document is not tracked by git`);
    }
    for (const source of document.sources ?? []) {
      const matcher = globToRegExp(source);
      if (!tracked.some((file) => matcher.test(file))) {
        errors.push(`${rel}: source "${source}" matches no tracked file`);
      }
    }
  }

  return errors;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const STATUS_LABELS = {
  living: "常青",
  "target design": "目标设计",
  historical: "历史快照",
  generated: "生成",
};

export function renderDocMap(documents) {
  const lines = [
    "<!-- 由 docs/doc-map.json 生成。请勿手改。 -->",
    "<!-- 重新生成：node scripts/doc-impact.mjs --write-agents -->",
    "",
    "| 文档 | 状态 | 定义内容 | 这些变化时更新 |",
    "|---|---|---|---|",
  ];
  for (const document of documents) {
    const sources = document.sources.length === 0
      ? (document.status === "historical"
        ? "—（历史快照；无自动触发）"
        : "—（手动维护；无自动触发）")
      : document.sources.map((source) => `\`${escapeCell(source)}\``).join("<br>");
    lines.push(
      `| [\`${escapeCell(document.path)}\`](${document.path}) | ${escapeCell(STATUS_LABELS[document.status] ?? document.status)} | ${escapeCell(document.defines)} | ${sources} |`,
    );
  }
  return lines.join("\n");
}

export function replaceDocMapBlock(text, block) {
  const start = text.indexOf(START_MARKER);
  const end = text.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`AGENTS.md is missing ${START_MARKER} / ${END_MARKER}`);
  }
  return `${text.slice(0, start)}${START_MARKER}\n${block}\n${END_MARKER}${text.slice(end + END_MARKER.length)}`;
}

export function expectedAgentsText(text, documents) {
  return replaceDocMapBlock(text, renderDocMap(documents));
}

export function loadManifest(root = ROOT) {
  const manifestPath = path.join(root, MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1) {
    throw new Error(`${MANIFEST_PATH}: unsupported version ${manifest.version}`);
  }
  return manifest.documents;
}

function git(args, cwd = ROOT) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function trackedFilesOrNull() {
  try {
    return splitNull(git(["ls-files", "-z"]));
  } catch {
    return null;
  }
}

function splitNull(value) {
  return value.split("\0").map(normalizePath).filter(Boolean);
}

function changedSince(base, includeWorktree) {
  git(["rev-parse", "--verify", `${base}^{commit}`]);
  const changed = new Set(
    splitNull(git(["diff", "--name-only", "-z", "--diff-filter=ACMRD", `${base}...HEAD`])),
  );
  if (includeWorktree) {
    for (const file of splitNull(git(["diff", "--name-only", "-z", "--diff-filter=ACMRD", "HEAD"]))) {
      changed.add(file);
    }
    for (const file of splitNull(git(["ls-files", "--others", "--exclude-standard", "-z"]))) {
      changed.add(file);
    }
  }
  return [...changed].sort();
}

function resolveBase(explicit) {
  const base = explicit || process.env.DOC_BASE || "origin/main";
  if (!base) throw new Error("pass --base <commit> or set DOC_BASE");
  return base;
}

function usage() {
  console.log(`Usage:
  node scripts/doc-impact.mjs --list
  node scripts/doc-impact.mjs --base <commit> [--worktree] [--json]
  node scripts/doc-impact.mjs --changed <paths> [--json]
  node scripts/doc-impact.mjs --write-agents

Options:
  --base <commit>  Diff base (default: DOC_BASE or origin/main)
  --worktree       Include uncommitted tracked and untracked files
  --changed <paths>  Comma-separated changed files; skips git (useful in a sandbox)
  --list           Print the document map and exit
  --write-agents   Rewrite the generated table in AGENTS.md
  --json           Print the check result as JSON
  --help           Show this help`);
}

function main() {
  const argv = process.argv.slice(2);
  const options = {
    base: null,
    worktree: false,
    list: false,
    writeAgents: false,
    json: false,
    changed: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") {
      options.base = argv[index + 1];
      index += 1;
      if (!options.base) throw new Error("--base needs a commit");
    } else if (arg === "--changed") {
      const value = argv[index + 1];
      index += 1;
      if (!value) throw new Error("--changed needs a comma-separated path list");
      options.changed.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
    } else if (arg === "--worktree") {
      options.worktree = true;
    } else if (arg === "--list") {
      options.list = true;
    } else if (arg === "--write-agents") {
      options.writeAgents = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      return 0;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  const documents = loadManifest();
  const errors = validateManifest(documents, ROOT);
  const trackedFiles = trackedFilesOrNull();
  if (trackedFiles) {
    errors.push(...validateManifestCoverage(documents, trackedFiles));
  } else if (process.env.CI) {
    errors.push("cannot list tracked files with git; the coverage check would be skipped in CI");
  }
  if (errors.length > 0) {
    console.error("docs/doc-map.json is invalid:\n");
    for (const error of errors) console.error(`- ${error}`);
    return 2;
  }

  const agentsFile = path.join(ROOT, AGENTS_PATH);
  if (!existsSync(agentsFile)) {
    console.error(`${AGENTS_PATH}: missing; create it and add the doc-map markers`);
    return 2;
  }
  const agentsText = readFileSync(agentsFile, "utf8");
  const expected = expectedAgentsText(agentsText, documents);
  const agentsCurrent = agentsText.replace(/\r\n/g, "\n") === expected.replace(/\r\n/g, "\n");

  if (options.writeAgents) {
    writeFileSync(agentsFile, expected, "utf8");
    console.log(`updated ${AGENTS_PATH}: ${documents.length} document entries`);
    return 0;
  }

  if (options.list) {
    console.log(renderDocMap(documents));
    return 0;
  }

  if (!agentsCurrent) {
    console.error(`${AGENTS_PATH}: generated document table is stale.`);
    console.error("Run: node scripts/doc-impact.mjs --write-agents");
    return 1;
  }

  let base;
  let changedFiles;
  if (options.changed.length > 0) {
    base = "(explicit file list)";
    changedFiles = [...new Set(options.changed.map(normalizePath))].sort();
  } else {
    try {
      base = resolveBase(options.base);
      git(["rev-parse", "--verify", `${base}^{commit}`]);
    } catch (error) {
      console.error(`cannot resolve base "${options.base ?? process.env.DOC_BASE ?? "origin/main"}": ${error.message}`);
      console.error("Fetch full history (git fetch --unshallow), pass --base <commit>, or pass --changed <paths>.");
      return 2;
    }
    changedFiles = changedSince(base, options.worktree);
  }
  const violations = evaluateImpact(documents, changedFiles);

  if (options.json) {
    console.log(JSON.stringify({
      ok: violations.length === 0,
      base,
      changedFiles,
      violations,
    }, null, 2));
    return violations.length === 0 ? 0 : 1;
  }

  console.log(`document impact: base ${base}, ${changedFiles.length} changed file(s)`);
  if (violations.length === 0) {
    console.log("document impact OK: every changed source is covered by its document");
    return 0;
  }

  console.error("\ndocument impact check failed:\n");
  for (const violation of violations) {
    console.error(`- ${violation.document} — ${violation.defines}`);
    for (const trigger of violation.triggers) console.error(`    changed: ${trigger}`);
    console.error("    action: update the document, or change docs/doc-map.json if it no longer defines this fact.");
  }
  console.error("\nSee docs/DOCUMENTATION.md and AGENTS.md.");
  return 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
const self = path.resolve(fileURLToPath(import.meta.url));
if (process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`doc-impact: ${error.message}`);
    process.exitCode = 2;
  }
}
