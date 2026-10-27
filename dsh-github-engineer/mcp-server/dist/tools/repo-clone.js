/**
 * dsh-github-engineer MCP server — repo_clone tool.
 *
 * Clones the bound repository to working_dir at the configured base
 * branch, with depth=1 (we only need HEAD, not history). Refuses if
 * working_dir already contains a .git unless `force = true`.
 *
 * Per docs/INCREMENT-3-CHECKLIST.md:
 *   - execFile (no shell)
 *   - --depth 1, no --bare, no --mirror
 *   - refuses if .git exists without force
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { statfs } from "node:fs/promises";
import { GithubRefusedError } from "../guard.js";
const execFileAsync = promisify(execFile);
const MIN_FREE_BYTES = 100 * 1024 * 1024;
export async function repoClone(input, cfg) {
    const alreadyInitialized = existsSync(path.join(cfg.workingDir, ".git"));
    if (alreadyInitialized && input.force !== true) {
        throw new GithubRefusedError("already-initialized", `working_dir ${cfg.workingDir} already has a .git directory. Pass force=true to re-clone (will wipe existing contents)`);
    }
    if (alreadyInitialized && input.force === true) {
        // `git clone` refuses to write into a non-empty directory, so force
        // has to mean what it says: remove the old checkout first.
        rmSync(cfg.workingDir, { recursive: true, force: true });
    }
    // Disk space check
    try {
        const fs = await statfs(cfg.workingDir);
        if (fs.bavail * fs.bsize < MIN_FREE_BYTES) {
            throw new GithubRefusedError("disk-space-low", `working_dir has < ${MIN_FREE_BYTES} bytes free`);
        }
    }
    catch (err) {
        // statfs can fail on some Windows configurations. Don't block. But a
        // disk-space refusal above must not be swallowed.
        if (err instanceof GithubRefusedError)
            throw err;
    }
    mkdirSync(cfg.workingDir, { recursive: true });
    // Build clone args. We pass the token via a temporary URL rewrite
    // for https://github.com URLs to authenticate private clones.
    // For SSH URLs or public repos, no rewrite is needed.
    const args = [
        "clone",
        "--depth",
        "1",
        "--branch",
        cfg.baseBranch,
        "--single-branch",
        rewriteUrl(cfg.repoUrl, cfg.githubToken),
        cfg.workingDir,
    ];
    try {
        await execFileAsync("git", args, {
            cwd: path.dirname(cfg.workingDir),
            timeout: 120_000,
            maxBuffer: 8 * 1024 * 1024,
        });
    }
    catch (err) {
        const e = err;
        throw new GithubRefusedError("clone-failed", `git clone failed: ${e.stderr ?? e.message ?? String(e)}`);
    }
    // `git clone <url-with-token>` stores that URL as `origin`, which puts
    // the access token in plaintext in .git/config — a file that gets
    // copied, backed up and shared. Put the clean URL back immediately;
    // push authenticates per command (see pr-create.ts) instead of relying
    // on a credentialed remote.
    if (cfg.githubToken && rewriteUrl(cfg.repoUrl, cfg.githubToken) !== cfg.repoUrl) {
        try {
            await execFileAsync("git", ["remote", "set-url", "origin", cfg.repoUrl], {
                cwd: cfg.workingDir,
                timeout: 15_000,
            });
        }
        catch (err) {
            throw new GithubRefusedError("clone-cleanup-failed", `cloned, but could not remove credentials from .git/config: ${err.message}. Delete ${cfg.workingDir} and clone again.`);
        }
    }
    return {
        cloned_to: cfg.workingDir,
        branch: cfg.baseBranch,
    };
}
/**
 * If the URL is an https://github.com/... URL and a token is present,
 * embed the token as basic-auth credentials. The token is passed via
 * argv (NOT stdin or env), which is visible to ps on Linux — that's a
 * known weakness of this approach. v2 should use git's GIT_ASKPASS or
 * SSH key for auth. For v1 the risk is bounded: this runs once per
 * clone or push, the token is exposed in process listing for ~1s, and
 * the plugin only ever runs on the user's own machine. What it must not
 * do is persist: nothing keeps this URL on disk.
 */
function rewriteUrl(url, token) {
    if (!token)
        return url;
    if (!url.startsWith("https://github.com/"))
        return url;
    // https://x-access-token:TOKEN@github.com/owner/repo
    return url.replace("https://", `https://x-access-token:${token}@`);
}
