#!/usr/bin/env node
// Reports which documents must change when a source file changes, and fails
// when a changed object's document was left untouched. The single map lives in
// docs/doc-map.json; AGENTS.md only links to it and does not copy the table.
//
// Usage:
//   node scripts/doc-impact.mjs --list
//   node scripts/doc-impact.mjs --base origin/main
//   node scripts/doc-impact.mjs --base origin/main --worktree
//   node scripts/doc-impact.mjs --changed src/a.ts,README.md
//
// CI runs the check against the pull request's base commit.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = "docs/doc-map.json";

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

export function listDocuments(documents) {
  return documents
    .map((document) => `${document.path} [${document.status}] — ${document.defines}`)
    .join("\n");
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

Options:
  --base <commit>  Diff base (default: DOC_BASE or origin/main)
  --worktree       Include uncommitted tracked and untracked files
  --changed <paths>  Comma-separated changed files; skips git (useful in a sandbox)
  --list           Print the document map and exit
  --json           Print the check result as JSON
  --help           Show this help`);
}

function main() {
  const argv = process.argv.slice(2);
  const options = {
    base: null,
    worktree: false,
    list: false,
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

  if (options.list) {
    console.log(listDocuments(documents));
    return 0;
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
