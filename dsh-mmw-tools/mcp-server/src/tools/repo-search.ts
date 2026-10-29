/**
 * dsh-mmw-tools MCP server — repo_search tool.
 *
 * One `git grep` pass. The output of `-n -e <pattern> [-- <pathspec>]`
 * is already `path:line:text`, which is the shape this tool returns, so
 * there is no reason to list files first and grep them again.
 *
 * An earlier version did exactly that: a `-l --heading --break` pass to
 * collect filenames, then a per-file pass for line matches. Two things
 * were wrong with it. The listing pass's output is human-oriented and
 * does not parse reliably across git builds (it produced nothing usable
 * on Git for Windows), and the per-file pass was wrapped in a bare
 * `catch {}`, so every failure became "zero hits" instead of an error.
 * A single pass removes both problems.
 *
 * Guards, per docs/INCREMENT-3-CHECKLIST.md:
 *   - the query cannot start with `!` or contain `--` or a NUL byte
 *     (argument-injection prevention)
 *   - the glob cannot contain `..`
 *   - results are capped
 *   - snippets pass through redactTokens
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
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

  if (typeof input.glob === "string" && input.glob.length > 0) {
    if (input.glob.includes("..")) {
      throw new GithubRefusedError(
        "glob-traversal",
        `glob must not contain '..' segments: ${input.glob}`
      );
    }
  }

  let maxResults: number = LIMITS.SEARCH_RESULTS_DEFAULT;
  if (typeof input.max_results === "number" && input.max_results > 0) {
    maxResults = Math.min(input.max_results, LIMITS.SEARCH_RESULTS_HARD_CAP);
  }

  // `-I` skips binary files. `-e` separates the pattern from any
  // pathspec, so the ordering that `git grep` is picky about cannot be
  // got wrong here.
  const args = [
    "grep",
    "--line-number",
    "--no-color",
    "--extended-regexp",
    "-I",
    "-e",
    input.query,
  ];
  if (input.glob && input.glob.length > 0) {
    args.push("--", input.glob);
  }

  let stdout = "";
  try {
    const result = await execFileAsync("git", args, {
      cwd: cfg.workingDir,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    // Exit 1 with no output is "no matches", not a failure.
    if (String(e.code) === "1" && (e.stdout ?? "").length === 0) {
      return { hits: [], truncated: false };
    }
    throw new GithubRefusedError(
      "search-failed",
      `git grep failed: ${e.stderr ?? e.message ?? String(e)}`
    );
  }

  const hits: RepoSearchHit[] = [];
  for (const rawLine of stdout.split("\n")) {
    // A Windows checkout with core.autocrlf leaves CRLF in the working
    // tree, and `git grep` echoes the matched line as-is, so every
    // output line then ends with "\r". JavaScript's "." does not match
    // "\r" and "$" does not sit before it, so leaving it in place made
    // every hit fail the regex and vanish — the suite saw zero matches
    // on Git for Windows while the same query matched on Linux.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    const match = line.match(/^(.*?):(\d+):(.*)$/);
    if (!match) continue;
    const [, filePath, lineNo, snippet] = match;
    hits.push({
      path: filePath,
      line: Number(lineNo),
      snippet: redactTokens(snippet),
    });
    if (hits.length >= maxResults) break;
  }

  return { hits, truncated: hits.length >= maxResults };
}
