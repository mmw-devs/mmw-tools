import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GithubRefusedError } from "../guard.js";
import { brokerWrite, brokerWriteEnabled } from "../broker-write.js";

const execFileAsync = promisify(execFile);

export type MergeMethod = "merge" | "squash" | "rebase";

export interface PrMergeInput {
  pr_number: number;
  merge_method?: MergeMethod;
  commit_title?: string;
}

export interface PrMergeConfig {
  workingDir: string;
  repoOwner: string;
  repoName: string;
  branchPrefix: string;
  brokerUrl?: string;
  writeAuthFile?: string;
}

interface PrView {
  number: number;
  isDraft: boolean;
  state: string;
  headRefName: string;
  mergeStateStatus?: string;
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
 * Merge a pull request, but only when the human has asked for it.
 *
 * The consent half lives in the host: `apply()` installs a
 * `tools/pre-execute` gate that answers `ask` for this tool, so the call
 * cannot complete without a person confirming in the UI.
 *
 * This half enforces only what GitHub cannot:
 *   - the PR belongs to this plugin's content/* branches, and
 *   - it is not still a draft (a draft is marked ready first: the human has
 *     already approved the merge, and sending them to the web UI to click
 *     "Ready for review" adds a step without adding a decision).
 *
 * It deliberately does **not** re-derive "is CI green". `mergeStateStatus`
 * is GitHub's own verdict, computed from branch protection - required checks,
 * required reviews, conflicts. Relaying that verdict keeps GitHub the single
 * authority; enumerating check names here would be a second, drifting copy of
 * the same rule.
 */
export async function prMerge(
  input: PrMergeInput,
  cfg: PrMergeConfig
): Promise<{ number: number; merged: boolean; method: MergeMethod; branch: string }> {
  const repo = `${cfg.repoOwner}/${cfg.repoName}`;
  const number = input.pr_number;

  if (!Number.isInteger(number) || number <= 0) {
    throw new GithubRefusedError("bad-pr-number", `pr_number 必须是正整数，收到 ${String(input.pr_number)}`);
  }

  const method: MergeMethod = input.merge_method ?? "squash";
  if (!["merge", "squash", "rebase"].includes(method)) {
    throw new GithubRefusedError("bad-merge-method", `不支持的 merge_method: ${String(method)}`);
  }

  // ---------- Broker proxy ----------
  // The host already asked the human; the broker additionally pins the
  // approval to this PR, this head SHA and a five-minute window, and consumes
  // it on use. That makes a replayed or stale call fail instead of merging
  // whatever the branch happens to point at later.
  if (
    brokerWriteEnabled({
      brokerUrl: cfg.brokerUrl ?? "",
      writeAuthFile: cfg.writeAuthFile ?? "",
    })
  ) {
    const approval = await brokerWrite<{
      approval_id?: unknown;
      head_sha?: unknown;
    }>(
      { brokerUrl: cfg.brokerUrl ?? "", writeAuthFile: cfg.writeAuthFile ?? "" },
      "/v1/write/pr_merge/approval",
      {
        pr_number: number,
        merge_method: method,
        commit_title: input.commit_title,
      },
      { timeoutMs: 90_000 }
    );
    const approvalId =
      typeof approval.approval_id === "string" ? approval.approval_id : "";
    const headSha = typeof approval.head_sha === "string" ? approval.head_sha : "";
    if (!approvalId || !headSha) {
      throw new GithubRefusedError(
        "approval-invalid",
        "broker 没有返回有效的合并审批凭据"
      );
    }
    const merged = await brokerWrite<{ branch?: unknown }>(
      { brokerUrl: cfg.brokerUrl ?? "", writeAuthFile: cfg.writeAuthFile ?? "" },
      "/v1/write/pr_merge",
      {
        approval_id: approvalId,
        pr_number: number,
        head_sha: headSha,
        merge_method: method,
        commit_title: input.commit_title,
      },
      { timeoutMs: 120_000 }
    );
    return {
      number,
      merged: true,
      method,
      branch: typeof merged.branch === "string" ? merged.branch : "",
    };
  }

  const readView = async (): Promise<PrView> =>
    JSON.parse(
      await gh(
        ["pr", "view", String(number), "--repo", repo, "--json", "number,isDraft,state,headRefName,mergeStateStatus"],
        cfg.workingDir
      )
    ) as PrView;

  let view: PrView;
  try {
    view = await readView();
  } catch (err) {
    throw new GithubRefusedError(
      "pr-not-found",
      `无法读取 PR #${number}：${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (view.state !== "OPEN") {
    throw new GithubRefusedError("pr-not-open", `PR #${number} 状态是 ${view.state}，只能合并 open 的 PR`);
  }
  if (view.isDraft) {
    // See the note above: consent is the host prompt, and a draft is only a
    // review-state flag on the same PR.
    await gh(["pr", "ready", String(number), "--repo", repo], cfg.workingDir);
    view = await readView();
  }
  if (!view.headRefName.startsWith(cfg.branchPrefix)) {
    throw new GithubRefusedError(
      "pr-out-of-scope",
      `PR #${number} 的头分支是 ${view.headRefName}，本插件只合并 ${cfg.branchPrefix}* 分支的 PR。`
    );
  }

  let status = view.mergeStateStatus ?? "UNKNOWN";
  // GitHub recomputes mergeability after a state change; a couple of reads
  // are cheaper for the caller than a confusing "UNKNOWN" refusal.
  for (let attempt = 0; attempt < 5 && status === "UNKNOWN"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    view = await readView();
    status = view.mergeStateStatus ?? "UNKNOWN";
  }

  if (status !== "CLEAN") {
    throw new GithubRefusedError(
      "not-mergeable",
      `PR #${number} 的 mergeStateStatus 是 ${status}，不是 CLEAN —— 以 GitHub 的分支保护结论为准` +
        `（BLOCKED 通常表示检查未通过或缺少 review，DIRTY 表示有冲突，UNKNOWN 表示 GitHub 还在计算）。`
    );
  }

  const methodArgs = ["pr", "merge", String(number), "--repo", repo, `--${method}`];
  if (typeof input.commit_title === "string" && input.commit_title.trim() !== "") {
    methodArgs.push("--subject", input.commit_title.trim());
  }
  await gh(methodArgs, cfg.workingDir);

  return { number, merged: true, method, branch: view.headRefName };
}
