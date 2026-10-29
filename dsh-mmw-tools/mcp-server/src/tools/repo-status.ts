/**
 * dsh-mmw-tools MCP server — repo_status tool.
 *
 * Reports the current state of the cloned working copy: branch,
 * dirty flag, last commit SHA, uncommitted file list.
 *
 * Per docs/INCREMENT-3-CHECKLIST.md: no high-risk surface; no guards
 * beyond the cross-cutting ones applied in the tool dispatcher.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepoStatusInput {
  // (none)
}

export interface RepoStatusOutput {
  cloned: boolean;
  current_branch: string | null;
  dirty: boolean;
  last_commit_sha: string | null;
  uncommitted_files: string[];
  remote_url: string | null;
}

export async function repoStatus(input: RepoStatusInput): Promise<RepoStatusOutput> {
  // Probe whether a .git exists.
  // Caller passes working_dir via the MCP framework env (GHOST_WORKING_DIR)
  // but we read it via env here for simplicity.
  const workingDir = process.env.GHOST_WORKING_DIR ?? "";
  if (!workingDir) {
    return {
      cloned: false,
      current_branch: null,
      dirty: false,
      last_commit_sha: null,
      uncommitted_files: [],
      remote_url: null,
    };
  }

  // Three commands in sequence: branch, status --porcelain, rev-parse HEAD.
  try {
    const branchR = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: workingDir }
    );
    const branch = branchR.stdout.trim() || null;

    const dirtyR = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd: workingDir }
    );
    const uncommitted = dirtyR.stdout
      .split("\n")
      .map((line) =>
        line.replace(/^[ MADU?!]{2} ?/, "").replace(/"$/, "").trim()
      )
      .filter((line) => line.length > 0);

    const headR = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: workingDir }
    );
    const head = headR.stdout.trim() || null;

    let remote: string | null = null;
    try {
      const remoteR = await execFileAsync(
        "git",
        ["remote", "get-url", "origin"],
        { cwd: workingDir }
      );
      remote = remoteR.stdout.trim() || null;
    } catch {
      // No remote configured — that's fine.
      remote = null;
    }

    return {
      cloned: true,
      current_branch: branch,
      dirty: uncommitted.length > 0,
      last_commit_sha: head,
      uncommitted_files: uncommitted,
      remote_url: remote,
    };
  } catch (err) {
    // git rev-parse failed → not a git repo or not initialized.
    return {
      cloned: false,
      current_branch: null,
      dirty: false,
      last_commit_sha: null,
      uncommitted_files: [],
      remote_url: null,
    };
  }
}