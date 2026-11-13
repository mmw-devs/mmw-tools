/**
 * dsh-mmw-tools MCP server — repo_pull tool.
 *
 * Pulls the latest changes from origin onto the given branch, using
 * --rebase (not --merge). Refuses if the working tree is dirty or if
 * the branch is the protected base.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

import {
  assertBranchPrefix,
  GithubRefusedError,
} from "../guard.js";
import { brokerReadBundle, brokerReadEnabled } from "../broker-read.js";

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
  brokerUrl?: string;
  writeAuthFile?: string;
  repoOwner?: string;
  repoName?: string;
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

  if (brokerReadEnabled({ brokerUrl: cfg.brokerUrl ?? "", writeAuthFile: cfg.writeAuthFile ?? "" })) {
    return pullThroughBroker(cfg, branch);
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

/**
 * Refresh from a broker bundle instead of the GitHub remote. The local tree
 * is intentionally fast-forwarded with a hard reset: repo_edit never writes
 * the local checkout, so there is no local work to preserve here, and the
 * dirty-tree check above already rejected a hand-edited tree.
 */
async function pullThroughBroker(
  cfg: RepoPullConfig,
  branch: string
): Promise<RepoPullOutput> {
  const owner = cfg.repoOwner ?? "";
  const name = cfg.repoName ?? "";
  if (!owner || !name) {
    throw new GithubRefusedError("repo-missing", "broker read proxy needs owner/name");
  }
  const tmp = mkdtempSync(path.join(tmpdir(), "mmw-read-bundle-"));
  const bundle = path.join(tmp, "repo.bundle");
  const remoteRef = `refs/remotes/broker/${branch}`;
  try {
    await brokerReadBundle(
      { brokerUrl: cfg.brokerUrl ?? "", writeAuthFile: cfg.writeAuthFile ?? "" },
      "/v1/read/pull",
      { repo: `${owner}/${name}`, ref: branch },
      bundle
    );
    const before = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cfg.workingDir });
    await execFileAsync(
      "git",
      ["fetch", bundle, `+refs/heads/${branch}:${remoteRef}`],
      { cwd: cfg.workingDir, timeout: 60_000 }
    );
    await execFileAsync("git", ["checkout", "-B", branch, remoteRef], {
      cwd: cfg.workingDir,
      timeout: 30_000,
    });
    const after = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cfg.workingDir });
    const changed = before.stdout.trim() !== after.stdout.trim();
    return {
      fast_forwarded: changed,
      conflicts: false,
      message: changed ? `updated ${branch} from broker bundle` : `already up to date on ${branch}`,
    };
  } catch (err) {
    if (err instanceof GithubRefusedError) throw err;
    throw new GithubRefusedError(
      "pull-failed",
      `pull from broker bundle failed: ${(err as Error).message ?? String(err)}`
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}