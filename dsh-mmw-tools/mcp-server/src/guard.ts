/**
 * dsh-mmw-tools MCP server — hard guards.
 *
 * Every tool runs through these before any I/O. A guard that rejects
 * throws `GithubRefusedError`, which the MCP layer maps to
 * `isError: true`. No guard is "best effort" — they are all mandatory.
 *
 * Cross-cutting guards (every tool):
 *   - assertSafeRepoPath: path traversal + symlink escape
 *   - assertAllowlisted: allowlist / denylist enforcement
 *   - assertBranchPrefix: branch name validation
 *   - redactTokens: token-shaped string detection
 *   - runPreflight: pre-commit validation script
 *   - size limits: per-file / per-PR / per-commit caps
 *
 * See docs/INCREMENT-3-CHECKLIST.md for the rationale.
 */
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { realpath, stat } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/** Thrown by every guard when it rejects an input. */
export class GithubRefusedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GithubRefusedError";
    this.code = code;
  }
}

/* ============================================================== */
/*  Path safety                                                   */
/* ============================================================== */

/**
 * True when `target` is `root` itself or lives beneath it.
 *
 * Uses `path.relative` rather than a prefix comparison: on Windows it
 * compares case-insensitively and normalizes separators, so a short-form
 * root (`C:\Users\RUNNER~1\...`) and a long-form target
 * (`C:\Users\runneradmin\...`) that name the same directory are not
 * mistaken for an escape. `path.relative` returns "" for the root, a
 * plain relative path for a child, and something starting with ".." (or
 * an absolute path, across drives) otherwise.
 */
function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

/**
 * Normalize and validate that `input` stays inside `repoRoot`.
 * Rejects:
 *   - absolute paths
 *   - paths containing `..` segments
 *   - paths with NUL bytes
 *   - symlinks that escape the root
 * Returns the resolved absolute path on success.
 */
export async function assertSafeRepoPath(
  input: string,
  repoRoot: string
): Promise<string> {
  if (typeof input !== "string") {
    throw new GithubRefusedError("path-not-string", `path must be a string, got ${typeof input}`);
  }
  if (input.length === 0) {
    throw new GithubRefusedError("path-empty", "path must be non-empty");
  }
  if (input.includes("\0")) {
    throw new GithubRefusedError("path-null-byte", "path must not contain NUL bytes");
  }
  if (path.isAbsolute(input)) {
    throw new GithubRefusedError("path-absolute", `path must be relative, got ${input}`);
  }

  // Normalize via path.resolve, then verify it's inside repoRoot.
  const absolute = path.resolve(repoRoot, input);
  if (!isInsideRoot(repoRoot, absolute)) {
    throw new GithubRefusedError(
      "path-traversal",
      `path ${JSON.stringify(input)} resolves to ${absolute} which is outside repo root`
    );
  }

  // Symlink check: if the resolved path itself exists, ensure realpath
  // stays inside the root. We allow non-existent paths (write targets)
  // and skip the check on those.
  //
  // Both sides are canonicalized before comparing. On Windows the root
  // this function is handed often comes from `os.tmpdir()`, which can be
  // the 8.3 short form (`C:\Users\RUNNER~1\...`) while `realpath()`
  // returns the long form (`C:\Users\runneradmin\...`). A plain
  // `startsWith` then reports every legitimate path as an escape, which
  // is exactly what happened on the Windows CI runner.
  try {
    const real = await realpath(absolute);
    const realRoot = await realpath(repoRoot).catch(() => repoRoot);
    if (!isInsideRoot(realRoot, real)) {
      throw new GithubRefusedError(
        "path-symlink-escape",
        `path ${JSON.stringify(input)} is a symlink escaping repo root: ${real}`
      );
    }
  } catch (err) {
    if (err instanceof GithubRefusedError) throw err;
    // realpath throws ENOENT for paths that don't exist yet (e.g. write
    // targets). For those, fall back to stat on the parent directory.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const parent = path.dirname(absolute);
      try {
        const parentStat = await stat(parent);
        if (!parentStat.isDirectory()) {
          throw new GithubRefusedError(
            "path-parent-not-dir",
            `parent of ${JSON.stringify(input)} is not a directory`
          );
        }
      } catch (e2) {
        if (e2 instanceof GithubRefusedError) throw e2;
        // A missing parent is not a safety problem: the path cannot
        // escape through a directory that does not exist. Let the caller
        // proceed so its own error is the useful one — `repo_read`
        // reports file-not-found, `repo_edit` fails its write and rolls
        // back. Anything else (for example ENOTDIR) is a real refusal.
        if ((e2 as NodeJS.ErrnoException).code === "ENOENT") {
          return absolute;
        }
        throw e2;
      }
    } else {
      throw err;
    }
  }

  return absolute;
}

/* ============================================================== */
/*  Allowlist / denylist                                           */
/* ============================================================== */

interface AllowDenylistConfig {
  allowlistPaths: string[];
  denylistPaths: string[];
}

/**
 * Test whether a path matches a single minimatch-style glob.
 *
 * Supported patterns (a subset of minimatch):
 *   `**`   matches any number of segments (including zero)
 *   `*`    matches a single segment (no slashes)
 *   `?`    matches one character
 *   literals otherwise
 *
 * Patterns are matched against POSIX-style relative paths (forward
 * slashes regardless of host OS).
 */
export function matchGlob(pattern: string, path: string): boolean {
  // Normalize both: forward slashes only, strip leading `./`.
  const norm = (s: string): string =>
    s.replace(/\\/g, "/").replace(/^\.\//, "");

  const p = norm(pattern);
  const t = norm(path);
  return matchRegex(globToRegex(p), t);
}

function globToRegex(pattern: string): RegExp {
  // Split pattern on `/` and handle each segment with `**` and `*`.
  const segs = pattern.split("/");
  const parts: string[] = [];
  let leadingDoubleStar = false;

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === "**") {
      if (i === 0) leadingDoubleStar = true;
      else parts.push(".*"); // mid-path `**` = any chars incl. `/`
    } else {
      parts.push(escapeForRegex(seg).replace(/\*/g, "[^/]*").replace(/\?/g, "."));
    }
  }

  let body: string;
  // Pattern `**` and nothing else: pure wildcard, match anything.
  if (leadingDoubleStar && parts.length === 0) {
    body = ".*";
  } else if (leadingDoubleStar) {
    body = "(?:.*/)?" + parts.slice(1).join("/");
  } else {
    body = parts.join("/");
  }

  return new RegExp("^" + body + "$");
}

function escapeForRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function matchRegex(re: RegExp, target: string): boolean {
  return re.test(target);
}

/**
 * Decide whether `path` may be modified.
 *
 *   - If `denylistPaths` matches → refuse (deny wins over allow).
 *   - If `allowlistPaths` is non-empty AND no match → refuse.
 *   - Otherwise → allow.
 *
 * Returns true on success; throws on rejection.
 */
export function assertAllowlisted(
  path: string,
  cfg: AllowDenylistConfig
): true {
  const posixPath = path.replace(/\\/g, "/");

  for (const deny of cfg.denylistPaths) {
    if (matchGlob(deny, posixPath)) {
      throw new GithubRefusedError(
        "denylisted",
        `path ${JSON.stringify(path)} is in denylist (matches ${JSON.stringify(deny)})`
      );
    }
  }

  if (cfg.allowlistPaths.length === 0) {
    // Empty allowlist = closed by default. Allowlist is mandatory for
    // any write.
    throw new GithubRefusedError(
      "no-allowlist",
      "allowlist is empty: no paths are writable"
    );
  }

  let allowed = false;
  for (const allow of cfg.allowlistPaths) {
    if (matchGlob(allow, posixPath)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    throw new GithubRefusedError(
      "not-allowlisted",
      `path ${JSON.stringify(path)} is not in allowlist`
    );
  }

  return true;
}

/* ============================================================== */
/*  Branch name validation                                         */
/* ============================================================== */

const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;
const BRANCH_REF_PREFIX_RE = /^(refs\/|HEAD$)/;

export interface BranchGuardConfig {
  prefix: string;
  baseBranch: string;
}

/**
 * Validate a branch name. Returns the cleaned name on success.
 *
 *   - Must match `^[A-Za-z0-9._/-]+$` (no spaces, no `..`, no `~`).
 *   - Must not start with `refs/` or be `HEAD`.
 *   - Must start with `cfg.prefix` (default `content/`).
 *   - Must not equal `cfg.baseBranch` (default `main`).
 *   - Must not start with `<baseBranch>/` (no nested base-branch names).
 */
export function assertBranchPrefix(
  branch: string,
  cfg: BranchGuardConfig
): string {
  if (!branch || typeof branch !== "string") {
    throw new GithubRefusedError("branch-empty", "branch name required");
  }
  if (BRANCH_REF_PREFIX_RE.test(branch)) {
    throw new GithubRefusedError(
      "branch-ref-prefix",
      `branch ${JSON.stringify(branch)} starts with refs/ or is HEAD`
    );
  }
  if (!BRANCH_NAME_RE.test(branch)) {
    throw new GithubRefusedError(
      "branch-chars",
      `branch ${JSON.stringify(branch)} contains forbidden characters (allowed: A-Z a-z 0-9 . _ / -)`
    );
  }
  if (branch.includes("..")) {
    throw new GithubRefusedError(
      "branch-double-dot",
      `branch ${JSON.stringify(branch)} contains '..'`
    );
  }
  if (branch === cfg.baseBranch) {
    throw new GithubRefusedError(
      "branch-is-base",
      `branch ${JSON.stringify(branch)} equals base branch ${JSON.stringify(cfg.baseBranch)}; refusing to commit on base`
    );
  }
  if (branch.startsWith(cfg.baseBranch + "/") || branch.startsWith(cfg.baseBranch)) {
    throw new GithubRefusedError(
      "branch-is-base-subpath",
      `branch ${JSON.stringify(branch)} is nested under base branch`
    );
  }
  if (!branch.startsWith(cfg.prefix)) {
    throw new GithubRefusedError(
      "branch-prefix-mismatch",
      `branch ${JSON.stringify(branch)} does not start with required prefix ${JSON.stringify(cfg.prefix)}`
    );
  }
  return branch;
}

/* ============================================================== */
/*  Token redaction                                                */
/* ============================================================== */

/** A token-shaped substring. The blacklist matches the patterns listed
 *  in docs/INCREMENT-3-CHECKLIST.md §3. */
const TOKEN_BLACKLIST = [
  // GitHub classic PAT (gho_, ghp_, ghu_, ghs_, ghr_) — 36+ chars,
  // counting from the prefix (after the leading underscore) we need
  // ≥ 20 base62 chars to match.
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g,
  // GitHub fine-grained PAT — `github_pat_11XXX_` + base62 (underscores
  // and alphanumerics), ≥ 20 chars.
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Bearer / token / key / secret / password forms. Both:
  //   (a) with separator: `key: value` or `key=value`
  //   (b) bare, with whitespace after the keyword: `Bearer <token>`,
  //       `Authorization: <token>`, `key <token>`
  /\b(access_token|authorization|bearer|api[-_]?key|client[-_]?secret|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._-]+/gi,
  /\b(bearer|token|key|secret)\s+["']?[A-Za-z0-9_.-]{16,}/gi,
];

/** Detect token-shaped substrings. */
export function detectTokens(s: string): string[] {
  const hits: string[] = [];
  for (const re of TOKEN_BLACKLIST) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      hits.push(m[0]);
    }
  }
  return hits;
}

/**
 * Refuse if the string contains anything token-shaped.
 *
 *   - Detects GitHub PAT formats (`gh[oprsu]_...`).
 *   - Detects `access_token=...`, `Bearer ...`, `api_key=...`,
 *     `secret=...`, `password=...` patterns.
 *   - Returns silently on clean strings.
 *
 * Used for commit messages, PR titles, PR bodies, and any other
 * string that the LLM provides as a content payload.
 */
export function assertNoTokens(s: string, fieldName: string): true {
  const hits = detectTokens(s);
  if (hits.length > 0) {
    throw new GithubRefusedError(
      "token-in-string",
      `${fieldName} contains token-shaped substrings: ${hits
        .slice(0, 3)
        .map((h) => JSON.stringify(h))
        .join(", ")}${hits.length > 3 ? ` (+${hits.length - 3} more)` : ""}`
    );
  }
  return true;
}

/**
 * Soft-redact tokens in a free-text log line. Use for logger output;
 * do NOT use for content that's about to be committed (use
 * `assertNoTokens` first).
 */
export function redactTokens(s: string): string {
  let out = s;
  for (const re of TOKEN_BLACKLIST) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

/* ============================================================== */
/*  Preflight                                                     */
/* ============================================================== */

/**
 * Run a preflight command in `cwd` and return its exit code + combined
 * output. Uses `execFile` (no shell interpolation).
 */
export async function runPreflight(opts: {
  cmd: string;
  cwd: string;
  timeoutSeconds: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Parse cmd into [program, ...args] using a simple split. We do NOT
  // support shell pipes or redirects — those are not needed for the
  // `npm run validate`-style commands this plugin runs.
  const parts = opts.cmd.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") {
    throw new GithubRefusedError("preflight-cmd-empty", "preflight cmd is empty");
  }
  // Windows: run the whole command string through the shell so `.cmd`
  // shims (`npm.cmd`) resolve. Passing an argv to execFile with
  // `shell: true` triggers DEP0190 ("arguments are not escaped, only
  // concatenated"), so the string form is used instead — it is the same
  // execution with a narrower surface.
  if (process.platform === "win32") {
    try {
      const { stdout, stderr } = await execAsync(opts.cmd, {
        cwd: opts.cwd,
        timeout: opts.timeoutSeconds * 1000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: string | number;
      };
      if (typeof e.code === "number") {
        return { exitCode: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
      throw new GithubRefusedError(
        "preflight-spawn-failed",
        `preflight ${JSON.stringify(opts.cmd)} failed to spawn: ${e.message}`
      );
    }
  }
  try {
    const { stdout, stderr } = await execFileAsync(parts[0], parts.slice(1), {
      cwd: opts.cwd,
      timeout: opts.timeoutSeconds * 1000,
      maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    // execFile rejects on non-zero exit. Pull the data out.
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    if (typeof e.code === "number") {
      return {
        exitCode: e.code,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
    throw new GithubRefusedError(
      "preflight-spawn-failed",
      `preflight ${JSON.stringify(opts.cmd)} failed to spawn: ${e.message ?? String(e)}`
    );
  }
}

/* ============================================================== */
/*  Limits                                                         */
/* ============================================================== */

export const LIMITS = {
  READ_MAX_BYTES: 100 * 1024, // 100 KiB
  READ_HARD_CAP_BYTES: 500 * 1024,
  EDIT_CONTENT_MAX_BYTES: 100 * 1024,
  // 64 KiB, not 500 bytes.
  //
  // The target repository requires a structured op-log in every commit
  // message, and for a *new* top-level object that log must spell out
  // `from: null → to: { ... }` in full — the whole object, not a hash or
  // a path. `public/data.json` already holds ~10 KB objects, so the
  // honest message for such a change runs to several KB. A 500-byte cap
  // made the repository's own rule impossible to satisfy and forced an
  // agent to either fabricate the log or give up; 0.8.0 did the latter
  // (reported 2026-10-29, 2179 bytes for a new ops object).
  //
  // This limit exists to stop a runaway message, not to police size, so
  // it is set well above any single top-level object and in line with
  // PR_BODY_MAX_BYTES. The subject-line limit below is what keeps the
  // message readable.
  COMMIT_MESSAGE_MAX_BYTES: 64 * 1024,
  COMMIT_MESSAGE_SUBJECT_MAX_CHARS: 72,
  PR_TITLE_MAX_BYTES: 200,
  PR_BODY_MAX_BYTES: 65 * 1024,
  EDITS_PER_COMMIT_MAX: 5,
  SEARCH_RESULTS_DEFAULT: 50,
  SEARCH_RESULTS_HARD_CAP: 200,
} as const;

export function assertWithinLimit(value: string, limit: number, fieldName: string): true {
  if (Buffer.byteLength(value, "utf8") > limit) {
    throw new GithubRefusedError(
      "size-limit",
      `${fieldName} exceeds ${limit} bytes (got ${Buffer.byteLength(value, "utf8")})`
    );
  }
  return true;
}