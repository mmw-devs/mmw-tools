/**
 * dsh-github-engineer MCP server — repo_edit tool.
 *
 * The highest-risk tool. Applies file edits to a content/* branch,
 * runs preflight, and commits. **No push** — push happens in pr_create.
 *
 * Per docs/INCREMENT-3-CHECKLIST.md, the state machine is:
 *
 *   1. assertSafeRepoPath × every path
 *   2. assertAllowlisted × every path
 *   3. validate edits content (length, mode-specific shape)
 *   4. validate commit_message (length, redactTokens blacklist)
 *   5. git checkout -b <branch> (or reuse existing)
 *   6. apply each edit (atomic per-edit via tmp + rename)
 *   7. runPreflight
 *   8. git add <paths>
 *   9. git commit -m <message>
 *
 * On any failure after step 6, the working tree is rolled back to
 * the previous commit via `git checkout -- <paths>`. The user can
 * retry after fixing the inputs.
 *
 * Output is the new commit SHA, the file list, and pre-flight result.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  rename,
  unlink,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  assertSafeRepoPath,
  assertAllowlisted,
  assertBranchPrefix,
  assertWithinLimit,
  assertNoTokens,
  runPreflight,
  GithubRefusedError,
  LIMITS,
} from "../guard.js";

const execFileAsync = promisify(execFile);

export type EditMode = "replace" | "insert" | "patch";

export interface Edit {
  path: string;
  mode: EditMode;
  /** Required for mode=replace */
  find?: string;
  /** Required for mode=replace */
  replace?: string;
  /** Required for mode=insert */
  content?: string;
  /** Required for mode=patch */
  patch?: string;
}

export interface RepoEditInput {
  branch: string;
  edits: Edit[];
  commit_message: string;
}

export interface RepoEditOutput {
  branch: string;
  new_commit_sha: string;
  files_changed: string[];
  preflight: { ran: boolean; exit_code: number; stdout: string; stderr: string };
}

export interface RepoEditConfig {
  workingDir: string;
  allowlistPaths: string[];
  denylistPaths: string[];
  branchPrefix: string;
  baseBranch: string;
  preflight: { cmd: string; timeoutSeconds: number };
}

/* ============================================================== */
/*  State machine                                                  */
/* ============================================================== */

export async function repoEdit(
  input: RepoEditInput,
  cfg: RepoEditConfig
): Promise<RepoEditOutput> {
  // ---------- Step 1-2: validate paths + scopes ----------
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new GithubRefusedError("edits-empty", "edits must be a non-empty array");
  }
  if (input.edits.length > LIMITS.EDITS_PER_COMMIT_MAX) {
    throw new GithubRefusedError(
      "edits-too-many",
      `edits.length=${input.edits.length} exceeds limit ${LIMITS.EDITS_PER_COMMIT_MAX}`
    );
  }
  for (const e of input.edits) {
    if (typeof e.path !== "string" || e.path.length === 0) {
      throw new GithubRefusedError("edit-path-required", "every edit.path must be a non-empty string");
    }
  }

  // Validate branch.
  const branch = assertBranchPrefix(input.branch, {
    prefix: cfg.branchPrefix,
    baseBranch: cfg.baseBranch,
  });

  // Resolve + allowlist every path.
  const absolutePaths: string[] = [];
  for (const e of input.edits) {
    const abs = await assertSafeRepoPath(e.path, cfg.workingDir);
    assertAllowlisted(e.path, {
      allowlistPaths: cfg.allowlistPaths,
      denylistPaths: cfg.denylistPaths,
    });
    absolutePaths.push(abs);
  }

  // ---------- Step 3: validate edit content ----------
  for (const e of input.edits) {
    validateEdit(e);
  }

  // ---------- Step 4: validate commit_message ----------
  if (typeof input.commit_message !== "string" || input.commit_message.length === 0) {
    throw new GithubRefusedError("commit-message-empty", "commit_message required");
  }
  assertWithinLimit(input.commit_message, LIMITS.COMMIT_MESSAGE_MAX_BYTES, "commit_message");
  assertNoTokens(input.commit_message, "commit_message");

  // Subject line must be ≤ 72 chars and contain no newlines.
  const newlineIdx = input.commit_message.indexOf("\n");
  const subject =
    newlineIdx === -1
      ? input.commit_message
      : input.commit_message.slice(0, newlineIdx);
  if (subject.length > LIMITS.COMMIT_MESSAGE_SUBJECT_MAX_CHARS) {
    throw new GithubRefusedError(
      "commit-message-subject-too-long",
      `commit_message subject is ${subject.length} chars (max ${LIMITS.COMMIT_MESSAGE_SUBJECT_MAX_CHARS})`
    );
  }

  // ---------- Step 5: ensure branch exists ----------
  await ensureBranch(cfg.workingDir, branch, cfg.baseBranch);

  // ---------- Step 6: apply each edit (atomic per-edit) ----------
  const originalContents = new Map<string, string | null>();
  for (let i = 0; i < input.edits.length; i++) {
    const e = input.edits[i];
    const abs = absolutePaths[i];
    try {
      const original = await readOrNull(abs);
      originalContents.set(abs, original);
      const next = applyEdit(original, e);
      await writeAtomic(abs, next);
    } catch (err) {
      // Roll back all previous edits before propagating the failure.
      await rollbackWorkingTree(cfg.workingDir, absolutePaths, originalContents);
      throw err;
    }
  }

  // ---------- Step 7: preflight ----------
  let preflightResult: RepoEditOutput["preflight"];
  let preflightFailed = false;
  if (cfg.preflight.cmd && cfg.preflight.cmd.length > 0) {
    const r = await runPreflight({
      cmd: cfg.preflight.cmd,
      cwd: cfg.workingDir,
      timeoutSeconds: cfg.preflight.timeoutSeconds,
    });
    preflightResult = {
      ran: true,
      exit_code: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
    };
    if (r.exitCode !== 0) {
      preflightFailed = true;
    }
  } else {
    preflightResult = {
      ran: false,
      exit_code: 0,
      stdout: "",
      stderr: "",
    };
  }

  if (preflightFailed) {
    await rollbackWorkingTree(cfg.workingDir, absolutePaths, originalContents);
    throw new GithubRefusedError(
      "preflight-failed",
      `preflight ${JSON.stringify(cfg.preflight.cmd)} exited non-zero: ${preflightResult.stderr || preflightResult.stdout}`
    );
  }

  // ---------- Step 8: git add ----------
  for (const abs of absolutePaths) {
    try {
      await execFileAsync("git", ["add", "--", relPath(cfg.workingDir, abs)], {
        cwd: cfg.workingDir,
      });
    } catch (err) {
      await rollbackWorkingTree(cfg.workingDir, absolutePaths, originalContents);
      throw new GithubRefusedError(
        "git-add-failed",
        `git add failed for ${abs}: ${(err as Error).message}`
      );
    }
  }

  // ---------- Step 9: git commit ----------
  let newSha = "";
  try {
    const result = await execFileAsync(
      "git",
      ["commit", "-m", input.commit_message],
      { cwd: cfg.workingDir }
    );
    // git commit output ends with [branch sha] subject — pull sha out.
    const match = result.stdout.match(/\[[^\]]+\s+([0-9a-f]+)\]/);
    newSha = match ? match[1] : "";
  } catch (err) {
    await rollbackWorkingTree(cfg.workingDir, absolutePaths, originalContents);
    throw new GithubRefusedError(
      "git-commit-failed",
      `git commit failed: ${(err as Error).message}`
    );
  }

  return {
    branch,
    new_commit_sha: newSha,
    files_changed: input.edits.map((e) => e.path),
    preflight: preflightResult,
  };
}

/* ============================================================== */
/*  Edit validation + application                                 */
/* ============================================================== */

function validateEdit(e: Edit): void {
  switch (e.mode) {
    case "replace": {
      if (typeof e.find !== "string" || e.find.length === 0) {
        throw new GithubRefusedError("edit-find-required", "replace mode requires non-empty find");
      }
      if (typeof e.replace !== "string") {
        throw new GithubRefusedError("edit-replace-required", "replace mode requires replace string");
      }
      assertWithinLimit(e.find, LIMITS.EDIT_CONTENT_MAX_BYTES, "edit.find");
      assertWithinLimit(e.replace, LIMITS.EDIT_CONTENT_MAX_BYTES, "edit.replace");
      return;
    }
    case "insert": {
      if (typeof e.content !== "string" || e.content.length === 0) {
        throw new GithubRefusedError("edit-content-required", "insert mode requires non-empty content");
      }
      assertWithinLimit(e.content, LIMITS.EDIT_CONTENT_MAX_BYTES, "edit.content");
      return;
    }
    case "patch": {
      if (typeof e.patch !== "string" || e.patch.length === 0) {
        throw new GithubRefusedError("edit-patch-required", "patch mode requires non-empty patch");
      }
      assertWithinLimit(e.patch, LIMITS.EDIT_CONTENT_MAX_BYTES, "edit.patch");
      // Patch must be a valid unified diff. Light validation only —
      // the actual application does proper parse.
      if (!/^--- |^---$|^diff --git /m.test(e.patch)) {
        throw new GithubRefusedError(
          "edit-patch-malformed",
          "patch does not look like a unified diff (expected `--- a/...` header or `diff --git ...`)"
        );
      }
      return;
    }
    default: {
      throw new GithubRefusedError(
        "edit-mode-invalid",
        `unknown edit mode: ${JSON.stringify((e as { mode: unknown }).mode)}`
      );
    }
  }
}

function applyEdit(original: string | null, e: Edit): string {
  switch (e.mode) {
    case "replace": {
      if (original === null) {
        throw new GithubRefusedError(
          "replace-no-file",
          `replace mode requires existing file at ${e.path}`
        );
      }
      if (!original.includes(e.find!)) {
        throw new GithubRefusedError(
          "find-not-found",
          `find string not found in ${e.path} (cannot replace a substring that doesn't exist)`
        );
      }
      // Replace exactly one occurrence. If multiple matches, refuse.
      const occurrences = original.split(e.find!).length - 1;
      if (occurrences !== 1) {
        throw new GithubRefusedError(
          "find-ambiguous",
          `find string matches ${occurrences} occurrences in ${e.path}; supply a more specific snippet`
        );
      }
      return original.replace(e.find!, e.replace!);
    }
    case "insert": {
      const base = original ?? "";
      return base + e.content!;
    }
    case "patch": {
      // Patch mode is handled separately by writing the patch to a
      // temp file and running `git apply --3way` (see below). For v1
      // we don't support patch mode end-to-end; refuse with a clear
      // error.
      throw new GithubRefusedError(
        "patch-not-implemented-v1",
        "patch mode is not implemented in v1; use replace (path-level edit) or insert (append)"
      );
    }
  }
}

/* ============================================================== */
/*  File I/O                                                      */
/* ============================================================== */

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup if rename fails.
    try {
      await unlink(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

function relPath(workingDir: string, abs: string): string {
  // Working tree paths in git are POSIX-style relative.
  if (abs.startsWith(workingDir)) {
    let rel = abs.slice(workingDir.length);
    if (rel.startsWith("/") || rel.startsWith("\\")) rel = rel.slice(1);
    return rel.replace(/\\/g, "/");
  }
  return abs;
}

/* ============================================================== */
/*  Branch / rollback                                              */
/* ============================================================== */

async function ensureBranch(
  workingDir: string,
  branch: string,
  baseBranch: string
): Promise<void> {
  // List local branches.
  const list = await execFileAsync(
    "git",
    ["branch", "--list", branch],
    { cwd: workingDir }
  );
  if (list.stdout.trim().length > 0) {
    // Branch exists locally — switch to it.
    await execFileAsync("git", ["checkout", branch], { cwd: workingDir });
    return;
  }
  // Try to use an existing tracking branch from origin.
  try {
    await execFileAsync(
      "git",
      ["checkout", "-b", branch, `origin/${branch}`],
      { cwd: workingDir }
    );
    return;
  } catch {
    // No remote branch either; create from local base.
  }
  await execFileAsync("git", ["checkout", "-b", branch, baseBranch], {
    cwd: workingDir,
  });
}

async function rollbackWorkingTree(
  workingDir: string,
  absolutePaths: string[],
  originals: Map<string, string | null>
): Promise<void> {
  // git checkout -- <paths...> restores working tree to HEAD. This is
  // the safest single-step rollback.
  const rels = absolutePaths.map((p) => relPath(workingDir, p));
  try {
    await execFileAsync("git", ["checkout", "--", ...rels], { cwd: workingDir });
  } catch {
    // Worst-case fallback: nuke each file to its original content.
    for (const abs of absolutePaths) {
      const original = originals.get(abs);
      if (original === null) {
        try {
          await unlink(abs);
        } catch {
          // ignore — file might not exist
        }
      } else if (typeof original === "string") {
        try {
          await writeAtomic(abs, original);
        } catch {
          // ignore
        }
      }
    }
  }
}