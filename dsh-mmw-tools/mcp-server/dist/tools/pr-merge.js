import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GithubRefusedError } from "../guard.js";
const execFileAsync = promisify(execFile);
async function gh(args, cwd) {
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
 *   - it is not a draft.
 *
 * It deliberately does **not** re-derive "is CI green". `mergeStateStatus`
 * is GitHub's own verdict, computed from branch protection - required checks,
 * required reviews, conflicts. Relaying that verdict keeps GitHub the single
 * authority; enumerating check names here would be a second, drifting copy of
 * the same rule.
 */
export async function prMerge(input, cfg) {
    const repo = `${cfg.repoOwner}/${cfg.repoName}`;
    const number = input.pr_number;
    if (!Number.isInteger(number) || number <= 0) {
        throw new GithubRefusedError("bad-pr-number", `pr_number 必须是正整数，收到 ${String(input.pr_number)}`);
    }
    let view;
    try {
        view = JSON.parse(await gh(["pr", "view", String(number), "--repo", repo, "--json", "number,isDraft,state,headRefName,mergeStateStatus"], cfg.workingDir));
    }
    catch (err) {
        throw new GithubRefusedError("pr-not-found", `无法读取 PR #${number}：${err instanceof Error ? err.message : String(err)}`);
    }
    if (view.state !== "OPEN") {
        throw new GithubRefusedError("pr-not-open", `PR #${number} 状态是 ${view.state}，只能合并 open 的 PR`);
    }
    if (view.isDraft) {
        throw new GithubRefusedError("pr-is-draft", `PR #${number} 还是 draft。请先在 GitHub 上标记为 ready for review，再要求合并。`);
    }
    if (!view.headRefName.startsWith(cfg.branchPrefix)) {
        throw new GithubRefusedError("pr-out-of-scope", `PR #${number} 的头分支是 ${view.headRefName}，本插件只合并 ${cfg.branchPrefix}* 分支的 PR。`);
    }
    const status = view.mergeStateStatus ?? "UNKNOWN";
    if (status !== "CLEAN") {
        throw new GithubRefusedError("not-mergeable", `PR #${number} 的 mergeStateStatus 是 ${status}，不是 CLEAN —— 以 GitHub 的分支保护结论为准` +
            `（BLOCKED 通常表示检查未通过或缺少 review，DIRTY 表示有冲突，UNKNOWN 表示 GitHub 还在计算）。`);
    }
    const method = input.merge_method ?? "squash";
    if (!["merge", "squash", "rebase"].includes(method)) {
        throw new GithubRefusedError("bad-merge-method", `不支持的 merge_method: ${String(method)}`);
    }
    const args = ["pr", "merge", String(number), "--repo", repo, `--${method}`];
    if (typeof input.commit_title === "string" && input.commit_title.trim() !== "") {
        args.push("--subject", input.commit_title.trim());
    }
    await gh(args, cfg.workingDir);
    return { number, merged: true, method, branch: view.headRefName };
}
