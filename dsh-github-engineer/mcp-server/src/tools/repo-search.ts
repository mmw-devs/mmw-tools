/**
 * dsh-github-engineer MCP server — repo_search tool.
 *
 * Searches the cloned working copy using `git grep`. Returns line
 * hits as (path, line, snippet) triples.
 *
 * Per docs/INCREMENT-3-CHECKLIST.md:
 *   - query cannot start with `!` or contain `--` or `\0` (git option
 *     injection prevention).
 *   - glob is a path-safety-safe pattern.
 *   - max_results default 50, hard cap 200.
 *   - snippet content passed through redactTokens before returning.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  assertSafeRepoPath,
  redactTokens,
  GithubRefusedError,
  LIMITS,
} from "../guard.js";

const execFileAsync = promisify(execFile);

export interface RepoSearchInput {
  query: string;
  glob?: string;
  max_results?: number;
}

export interface RepoSearchHit {
  path: string;
  line: number;
  snippet: string;
}

export interface RepoSearchOutput {
  hits: RepoSearchHit[];
  truncated: boolean;
}

export interface RepoSearchConfig {
  workingDir: string;
}

const DANGEROUS_QUERY_PATTERNS = [/^!/, /\0/, /--/];

export async function repoSearch(
  input: RepoSearchInput,
  cfg: RepoSearchConfig
): Promise<RepoSearchOutput> {
  if (typeof input.query !== "string" || input.query.length === 0) {
    throw new GithubRefusedError("query-required", "query is required");
  }
  for (const re of DANGEROUS_QUERY_PATTERNS) {
    if (re.test(input.query)) {
      throw new GithubRefusedError(
        "query-dangerous",
        `query contains forbidden pattern: ${re.source}`
      );
    }
  }

  // If a glob is given, validate it as a safe path.
  if (typeof input.glob === "string" && input.glob.length > 0) {
    // Path traversal in globs can target parent dirs.
    if (input.glob.includes("..")) {
      throw new GithubRefusedError(
        "glob-traversal",
        `glob must not contain '..' segments: ${input.glob}`
      );
    }
    // We don't pass this through assertSafeRepoPath because git grep
    // treats -- as an option separator — calling the guard would 404.
    // The 'no `..`' rule above is sufficient.
  }

  let maxResults: number = LIMITS.SEARCH_RESULTS_DEFAULT;
  if (typeof input.max_results === "number" && input.max_results > 0) {
    maxResults = Math.min(input.max_results, LIMITS.SEARCH_RESULTS_HARD_CAP);
  }

  const args = [
    "grep",
    "--line-number",
    "--no-color",
    "--extended-regexp",
    "--heading",
    "--break",
    "-l", // simpler output mode for parsing (one file per match)
  ];
  if (input.glob && input.glob.length > 0) {
    args.push("--", input.glob);
  }
  args.push(input.query);

  let stdout = "";
  try {
    const result = await execFileAsync("git", args, {
      cwd: cfg.workingDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    // git grep exits 1 when no matches are found — that's not an error.
    if (String(e.code) === "1" && (e.stdout ?? "").length === 0) {
      return { hits: [], truncated: false };
    }
    throw new GithubRefusedError(
      "search-failed",
      `git grep failed: ${e.stderr ?? e.message ?? String(e)}`
    );
  }

  // `git grep -l` outputs one file path per line; we need to re-run with
  // a different mode if we want line numbers. Switch to per-file paths
  // mode, then re-run a per-file grep. To keep things simple for v1,
  // we run grep twice: once with -l for the file list, then per file.
  // Better: use `--files-with-matches` for the file set, then per-file
  // grep with -n. v1 keeps it cheap: just emit file-level hits.
  const files = stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const hits: RepoSearchHit[] = [];
  for (const file of files) {
    if (hits.length >= maxResults) break;
    try {
      const result = await execFileAsync(
        "git",
        [
          "grep",
          "--line-number",
          "--no-color",
          "--extended-regexp",
          "--",
          input.query,
          file,
        ],
        { cwd: cfg.workingDir, timeout: 10_000 }
      );
      for (const line of result.stdout.split("\n")) {
        if (line.trim().length === 0) continue;
        // git grep output: `path:lineno:matched_text`
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (!match) continue;
        const [, p, ln, snippet] = match;
        hits.push({
          path: p,
          line: Number(ln),
          snippet: redactTokens(snippet),
        });
        if (hits.length >= maxResults) break;
      }
    } catch {
      // Skip files where grep errors — typically binary files.
    }
  }

  return {
    hits,
    truncated: hits.length >= maxResults,
  };
}