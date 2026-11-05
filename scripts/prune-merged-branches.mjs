#!/usr/bin/env node
/**
 * Delete remote branches only when the repository's own history proves that
 * nothing still depends on them.
 *
 * The decision is deliberately conservative: every check below must pass, and
 * any unreadable signal keeps the branch. "Will we need it later?" is not
 * observable, so it is represented by an explicit retention window
 * (`--min-age-days`) plus keep patterns.
 *
 * Usage:
 *   GITHUB_TOKEN=... node scripts/prune-merged-branches.mjs
 *   GITHUB_TOKEN=... node scripts/prune-merged-branches.mjs --apply
 *
 * The default is a dry run. `--apply` is the only way this script deletes
 * anything. The scheduled workflow uses `--apply` after the retention window.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_URL = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
const DEFAULT_KEEP = ["main", "master", "release/*", "hotfix/*"];
const DEFAULT_MIN_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONFIG_PATHSPECS = [".github", "*.json", "*.yml", "*.yaml", "*.toml", "*.ini", "*.conf", "*.sh"];

const HELP = `Usage: node scripts/prune-merged-branches.mjs [options]

Options:
  --apply                 Delete eligible branches (default: dry run)
  --min-age-days <n>      Retention window after merge (default: ${DEFAULT_MIN_AGE_DAYS})
  --base <branch>         Base branch (default: repository default branch)
  --repo <owner/name>     Repository (default: GITHUB_REPOSITORY or origin)
  --keep <pattern>        Additional keep pattern, repeatable; supports prefix/*
  --help                  Show this help
`;

/**
 * @param {string} name
 * @param {string} pattern
 */
export function matchesKeepPattern(name, pattern) {
  if (pattern.endsWith("/*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/**
 * Pure decision function so the policy can be tested without GitHub.
 *
 * @param {{
 *   name: string,
 *   base: string,
 *   mergedPr: {number?: number, merged_at?: string|null, html_url?: string}|null,
 *   openPrs?: Array<{number?: number, head?: {ref?: string}, base?: {ref?: string}}>,
 *   protectedBranch?: "protected"|"unprotected"|"unknown",
 *   fullyMerged?: boolean,
 *   hasReference?: boolean,
 *   now?: number,
 *   minAgeDays?: number,
 *   keepPatterns?: string[],
 * }} input
 * @returns {{action: "delete"|"keep", reason: string}}
 */
export function decideBranch(input) {
  const {
    name,
    base,
    mergedPr,
    openPrs = [],
    protectedBranch = "unknown",
    fullyMerged = false,
    hasReference = false,
    now = Date.now(),
    minAgeDays = DEFAULT_MIN_AGE_DAYS,
    keepPatterns = [],
  } = input;

  if (name === base) return { action: "keep", reason: "default branch" };
  if (keepPatterns.some((pattern) => matchesKeepPattern(name, pattern))) {
    return { action: "keep", reason: "matches a keep pattern" };
  }

  const openPr = openPrs.find((pr) => pr.head?.ref === name || pr.base?.ref === name);
  if (openPr) return { action: "keep", reason: `open PR #${openPr.number ?? "?"} uses this branch` };

  if (!mergedPr || !mergedPr.merged_at) {
    return { action: "keep", reason: "no merged PR" };
  }
  if (!fullyMerged) return { action: "keep", reason: "contains commits not in the base branch" };
  if (protectedBranch !== "unprotected") {
    return { action: "keep", reason: "branch is protected or protection is unreadable" };
  }
  if (hasReference) return { action: "keep", reason: "referenced by workflow/config" };

  const mergedAt = Date.parse(mergedPr.merged_at);
  if (!Number.isFinite(mergedAt)) return { action: "keep", reason: "merged timestamp is unreadable" };
  if (now - mergedAt < minAgeDays * DAY_MS) {
    return { action: "keep", reason: `inside the ${minAgeDays}-day retention window` };
  }

  return {
    action: "delete",
    reason: `merged ${Math.floor((now - mergedAt) / DAY_MS)} days ago in PR #${mergedPr.number ?? "?"}`,
  };
}

function parseArgs(argv) {
  const options = {
    apply: false,
    minAgeDays: DEFAULT_MIN_AGE_DAYS,
    base: null,
    repo: null,
    keep: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--min-age-days") {
      const value = argv[++i];
      if (!/^\d+$/.test(value ?? "")) throw new Error("--min-age-days expects a non-negative integer");
      options.minAgeDays = Number(value);
    } else if (arg === "--base") {
      options.base = argv[++i];
      if (!options.base) throw new Error("--base expects a branch name");
    } else if (arg === "--repo") {
      options.repo = argv[++i];
      if (!/^[^/]+\/[^/]+$/.test(options.repo ?? "")) throw new Error("--repo expects owner/name");
    } else if (arg === "--keep") {
      const pattern = argv[++i];
      if (!pattern) throw new Error("--keep expects a pattern");
      options.keep.push(pattern);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function inferRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  let remote;
  try {
    remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("cannot infer repository; pass --repo or set GITHUB_REPOSITORY");
  }
  const match = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`cannot parse a GitHub repository from origin: ${remote}`);
  return `${match[1]}/${match[2]}`;
}

function hasConfigReference(branch) {
  try {
    execFileSync("git", ["grep", "-F", "-q", "--", branch, "--", ...CONFIG_PATHSPECS], {
      cwd: ROOT,
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    if (error && error.status === 1) return false;
    throw new Error(`workflow/config reference scan failed for ${branch}`);
  }
}

async function github(pathname, token, { method = "GET", allow404 = false } = {}) {
  const response = await fetch(`${API_URL}${pathname}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "mmw-tools-branch-cleanup",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (allow404 && response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${method} ${pathname} failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function nextLink(header) {
  if (!header) return null;
  const match = header.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

async function paginate(pathname, token) {
  let url = `${API_URL}${pathname}${pathname.includes("?") ? "&" : "?"}per_page=100`;
  const items = [];
  while (url) {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "mmw-tools-branch-cleanup",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`GET ${url} failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`GET ${url} did not return an array`);
    items.push(...page);
    url = nextLink(response.headers.get("link"));
  }
  return items;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");

  const [owner, repo] = (options.repo || inferRepo()).split("/");
  if (!owner || !repo) throw new Error("repository must be owner/name");

  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const repoInfo = await github(repoPath, token);
  const base = options.base || repoInfo.default_branch;
  if (!base) throw new Error("cannot determine the base branch");

  const keepPatterns = [...DEFAULT_KEEP, ...options.keep];
  const branches = await paginate(`${repoPath}/branches`, token);
  const openPrs = await paginate(`${repoPath}/pulls?state=open`, token);
  const mergedPrs = await paginate(
    `${repoPath}/pulls?state=closed&base=${encodeURIComponent(base)}`,
    token
  );
  const now = Date.now();
  const mode = options.apply ? "apply" : "dry run";
  const results = [];

  console.log(`# branch cleanup (${mode}) repo=${owner}/${repo} base=${base} minAge=${options.minAgeDays}d`);

  for (const branch of branches) {
    const name = branch.name;
    const branchOpenPrs = openPrs.filter((pr) => pr.head?.ref === name || pr.base?.ref === name);
    const mergedPr =
      mergedPrs
        .filter((pr) => pr.merged_at && pr.base?.ref === base && pr.head?.ref === name)
        .sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))[0] ?? null;

    let fullyMerged = false;
    let hasReference = false;
    const protectedBranch = branch.protected === true ? "protected" : branch.protected === false ? "unprotected" : "unknown";
    if (name !== base && !keepPatterns.some((pattern) => matchesKeepPattern(name, pattern))) {
      const comparison = await github(
        `${repoPath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(name)}`,
        token
      );
      fullyMerged = comparison.ahead_by === 0;
      if (fullyMerged) hasReference = hasConfigReference(name);
    }

    const decision = decideBranch({
      name,
      base,
      mergedPr,
      openPrs: branchOpenPrs,
      protectedBranch,
      fullyMerged,
      hasReference,
      now,
      minAgeDays: options.minAgeDays,
      keepPatterns,
    });

    let action = decision.action;
    if (action === "delete" && options.apply) {
      await github(`${repoPath}/git/refs/heads/${encodeURIComponent(name)}`, token, { method: "DELETE" });
      action = "deleted";
    } else if (action === "delete") {
      action = "would-delete";
    }

    results.push({ name, action, reason: decision.reason });
    console.log(`${action}\t${name}\t${decision.reason}`);
  }

  const deleted = results.filter((result) => result.action === "deleted").length;
  const wouldDelete = results.filter((result) => result.action === "would-delete").length;
  console.log(
    `\nSummary: deleted=${deleted} would-delete=${wouldDelete} kept=${results.length - deleted - wouldDelete}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`branch-cleanup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
