import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GithubRefusedError } from "../guard.js";
import { brokerWrite, brokerWriteEnabled } from "../broker-write.js";

const execFileAsync = promisify(execFile);

export interface PrCloseInput {
  pr_number: number;
}

export interface PrCloseConfig {
  repo?: string;
  workingDir: string;
  repoOwner: string;
  repoName: string;
  branchPrefix: string;
  brokerUrl?: string;
  writeAuthFile?: string;
}

interface PrView {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefName: string;
}

async function gh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    cwd,
    env: { ...process.env },
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Close a PR without merging it.
 *
 * The broker path is the normal one: it checks the `pr_close` operation
 * against the Feishu route table, refuses PRs outside `content/*`, and is
 * idempotent for an already closed/merged PR. The local `gh` path is the
 * standalone fallback used before the broker write proxy exists.
 *
 * The host asks for confirmation before this tool runs (`tools/pre-execute`),
 * because closing is a state change people should make deliberately.
 */
export async function prClose(
  input: PrCloseInput,
  cfg: PrCloseConfig
): Promise<{ number: number; closed: boolean; already: boolean }> {
  const number = input.pr_number;
  if (!Number.isInteger(number) || number <= 0) {
    throw new GithubRefusedError("bad-pr-number", `pr_number 必须是正整数，收到 ${String(input.pr_number)}`);
  }

  const brokerCfg = {
    brokerUrl: cfg.brokerUrl ?? "",
    writeAuthFile: cfg.writeAuthFile ?? "",
  };
  if (brokerWriteEnabled(brokerCfg)) {
    const result = await brokerWrite<{
      number: number;
      closed: boolean;
      already?: boolean;
    }>(brokerCfg, "/v1/write/pr_close", { pr_number: number, repo: cfg.repo });
    return {
      number: result.number ?? number,
      closed: true,
      already: Boolean(result.already),
    };
  }

  let view: PrView;
  try {
    view = JSON.parse(
      await gh(["pr", "view", String(number), "--json", "number,state,headRefName"], cfg.workingDir)
    ) as PrView;
  } catch (err) {
    throw new GithubRefusedError(
      "pr-view-failed",
      `无法读取 PR #${number}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (view.state !== "OPEN") {
    return { number, closed: true, already: true };
  }
  if (!String(view.headRefName).startsWith(cfg.branchPrefix)) {
    throw new GithubRefusedError(
      "branch-prefix",
      `PR #${number} 的头分支不是 ${cfg.branchPrefix}*，拒绝关闭`
    );
  }

  try {
    await gh(["pr", "close", String(number)], cfg.workingDir);
  } catch (err) {
    throw new GithubRefusedError(
      "pr-close-failed",
      `关闭 PR #${number} 失败: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return { number, closed: true, already: false };
}
