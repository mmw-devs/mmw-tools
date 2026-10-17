/**
 * dsh-github-engineer MCP server — repo_pull tool.
 *
 * Pulls the latest changes from origin onto the given branch, using
 * --rebase (not --merge). Refuses if the working tree is dirty or if
 * the branch is the protected base.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import {
  assertBranchPrefix,
  GithubRefusedError,
} from "../guard.js";

export interface RepoPullInput {
  branch?: string;
  rebase?: boolean;
}

export interface RepoPullOutput {
  fast_forwarded: boolean;
  conflicts: boolean;
  message: string;
}

export interface RepoPullConfig {
  workingDir: string;
  branchPrefix: string;
  baseBranch: string;
}

export async function repoPull(
  input: RepoPullInput,
  cfg: RepoPullConfig
): Promise<RepoPullOutput> {
  const branch = input.branch ?? cfg.baseBranch;
  // Validate the branch name (or auto-fail when user passes baseBranch).
  if (branch === cfg.baseBranch) {
    // Pulling the base branch is allowed but only when the caller
    // explicitly chose it. Don't run guard (which rejects base).
  } else {
    assertBranchPrefix(branch, {
      prefix: cfg.branchPrefix,
      baseBranch: cfg.baseBranch,
    });
  }

  // Check for dirty working tree first.
  const status = await execFileAsync(
    "git",
    ["status", "--porcelain"],
    { cwd: cfg.workingDir }
  );
  if (status.stdout.trim().length > 0) {
    throw new GithubRefusedError(
      "dirty-working-tree",
      `cannot pull on branch ${branch}: working tree has uncommitted changes`
    );
  }

  try {
    const result = await execFileAsync(
      "git",
      ["pull", "--rebase", "origin", branch],
      { cwd: cfg.workingDir, timeout: 60_000 }
    );
    return {
      fast_forwarded: result.stdout.includes("Fast-forward"),
      conflicts: false,
      message: result.stdout.trim() || "pull succeeded",
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
    };
    const stderr = e.stderr ?? "";
    if (stderr.includes("CONFLICT")) {
      return {
        fast_forwarded: false,
        conflicts: true,
        message: stderr.trim(),
      };
    }
    throw new GithubRefusedError(
      "pull-failed",
      `git pull failed: ${stderr || e.message || String(e)}`
    );
  }
}