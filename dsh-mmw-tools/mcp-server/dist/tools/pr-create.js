/**
 * dsh-mmw-tools MCP server — pr_create tool.
 *
 * Pushes the current content/* branch and creates a draft PR.
 * Per docs/INCREMENT-3-CHECKLIST.md:
 *   - assertBranchPrefix on head_branch
 *   - redactTokens blacklist on title + body
 *   - default draft=true (design §6.3 — CI + human review only)
 *   - URL validation: must match github.com/.../pull/N
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { assertBranchPrefix, assertWithinLimit, assertNoTokens, GithubRefusedError, LIMITS, runPreflight, } from "../guard.js";
const execFileAsync = promisify(execFile);
const PR_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;
export async function prCreate(input, cfg) {
    // ---------- Validate branch ----------
    const head = assertBranchPrefix(input.head_branch, {
        prefix: cfg.branchPrefix,
        baseBranch: cfg.baseBranch,
    });
    const base = input.base ?? cfg.baseBranch;
    if (base !== cfg.baseBranch) {
        throw new GithubRefusedError("pr-base-not-default", `base must equal configured base branch ${JSON.stringify(cfg.baseBranch)}`);
    }
    // ---------- Validate title + body ----------
    if (typeof input.title !== "string" || input.title.length === 0) {
        throw new GithubRefusedError("pr-title-empty", "title is required");
    }
    assertWithinLimit(input.title, LIMITS.PR_TITLE_MAX_BYTES, "title");
    assertNoTokens(input.title, "title");
    if (typeof input.body !== "string") {
        throw new GithubRefusedError("pr-body-required", "body must be a string (use empty string for no description)");
    }
    assertWithinLimit(input.body, LIMITS.PR_BODY_MAX_BYTES, "body");
    assertNoTokens(input.body, "body");
    const draft = input.draft !== false; // default true
    // ---------- Push ----------
    const remote = cfg.remoteName ?? "origin";
    await assertRepoGates(cfg);
    await pushBranch(cfg.workingDir, cfg, head);
    // ---------- Create PR via gh CLI ----------
    // We use gh CLI (not Octokit) here because gh has built-in
    // --fill/--editor-free semantics and is already authenticated. The
    // gh binary is required — refuse if missing.
    const args = [
        "pr", "create",
        "--head", head,
        "--base", base,
        "--title", input.title,
        "--body", input.body,
    ];
    if (draft)
        args.push("--draft");
    let stdout = "";
    try {
        const result = await execFileAsync("gh", args, {
            cwd: cfg.workingDir,
            timeout: 60_000,
            maxBuffer: 1024 * 1024,
            env: {
                ...process.env,
                GH_TOKEN: cfg.githubToken ?? "",
            },
        });
        stdout = result.stdout;
    }
    catch (err) {
        const e = err;
        const stderr = e.stderr ?? e.message ?? String(err);
        if (stderr.includes("No commits between")) {
            throw new GithubRefusedError("pr-no-commits", `branch ${head} has no commits ahead of ${base}; push it first or commit something`);
        }
        if (stderr.includes("already exists")) {
            throw new GithubRefusedError("pr-already-exists", `a PR for ${head} → ${base} already exists`);
        }
        throw new GithubRefusedError("pr-create-failed", `gh pr create failed: ${stderr}`);
    }
    // ---------- Parse output ----------
    // gh prints the URL on its own line.
    const urlLine = stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("https://"));
    if (!urlLine) {
        throw new GithubRefusedError("pr-url-missing", `gh pr create succeeded but returned no URL; full output: ${stdout}`);
    }
    if (!PR_URL_RE.test(urlLine)) {
        throw new GithubRefusedError("pr-url-malformed", `gh pr create returned unexpected URL: ${urlLine}`);
    }
    const numberMatch = urlLine.match(/\/pull\/(\d+)$/);
    const number = numberMatch ? Number(numberMatch[1]) : 0;
    // ---------- Get head SHA ----------
    let headSha = "";
    try {
        const r = await execFileAsync("git", ["rev-parse", `origin/${head}`], { cwd: cfg.workingDir });
        headSha = r.stdout.trim();
    }
    catch {
        // Non-blocking — the PR is created regardless.
    }
    return { number, url: urlLine, head_sha: headSha };
}
/**
 * Run the repository's own pre-push gate, if it has one.
 *
 * `mmw-devs/ffxiv-race-ops` validates every `content/*` commit message in
 * CI: it must carry a structured op-log block, and the declared changes
 * must match the actual `data.json` diff. Our `preflight` (`npm run
 * validate`) covers schema and value rules only, so a commit could pass
 * locally and still fail CI - which is exactly what happened on PR #19.
 *
 * Rather than reimplement that rule (and drift from it), run the script
 * the repository already uses. When a repo has no such script this is a
 * no-op, so the plugin stays repo-agnostic.
 */
async function assertRepoGates(cfg) {
    const script = join(cfg.workingDir, "scripts", "validate-op-log.ts");
    if (!existsSync(script))
        return;
    const result = await runPreflight({
        cmd: `npx tsx scripts/validate-op-log.ts origin/${cfg.baseBranch}`,
        cwd: cfg.workingDir,
        timeoutSeconds: 120,
    });
    if (result.exitCode === 0)
        return;
    const detail = `${result.stdout}\n${result.stderr}`.trim().slice(-1500);
    throw new GithubRefusedError("op-log-invalid", `commit message 未通过仓库的操作日志校验（scripts/validate-op-log.ts）。` +
        `每个 commit 需要一段 \`\`\`\`json 包住的结构化日志块，必填 operator / timestamp / changes，` +
        `且 changes 必须与 data.json 的实际改动一致。校验输出：\n${detail}`);
}
async function pushBranch(workingDir, cfg, branch) {
    // Push to an explicit credentialed URL rather than to `origin`:
    // repo_clone deliberately leaves `origin` credential-free so the token
    // never lands in .git/config, and `-u` is omitted for the same reason
    // (`-u <url>` would store that URL, token included, as
    // branch.<name>.remote). Upstream tracking buys this tool nothing.
    const remote = cfg.remoteName ?? "origin";
    const baseUrl = `https://github.com/${cfg.repoOwner}/${cfg.repoName}.git`;
    const pushUrl = cfg.githubToken
        ? baseUrl.replace("https://", `https://x-access-token:${cfg.githubToken}@`)
        : remote;
    try {
        await execFileAsync("git", ["push", pushUrl, branch], { cwd: workingDir, timeout: 60_000 });
    }
    catch (err) {
        const e = err;
        throw new GithubRefusedError("push-failed", `git push failed: ${e.stderr ?? err.message}`);
    }
}
