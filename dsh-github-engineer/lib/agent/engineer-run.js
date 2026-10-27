/**
 * dsh-github-engineer — engineer_run wrapper (v0.5.0).
 *
 * Per INCREMENT-4-CHECKLIST.md: this is a **lightweight bootstrap** that
 * prepares a project context for the DSH agent. The agent itself
 * drives the LLM loop; this module does NOT call any LLM.
 *
 * The function reads AGENTS.md + README.md from the cloned working
 * copy, validates inputs, computes a suggested branch name, and
 * returns a structured context the agent uses to do its work.
 *
 * Pure function where possible: the host bundle wires it up via
 * defineTool(). The unit testable surface is here; the glue is in
 * src/index.ts.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertInsideRepo, detectTokens, redactTokens } from "../util/redaction.js";
export const LIMITS = {
    USER_REQUEST_MAX_BYTES: 8 * 1024,
    USER_REQUEST_MIN_BYTES: 1,
    BRANCH_NAME_MAX_BYTES: 200,
    AGENTS_MD_MAX_BYTES: 4 * 1024,
    README_MAX_BYTES: 2 * 1024,
};
export class EngineerRunError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "EngineerRunError";
        this.code = code;
    }
}
/**
 * Sanity-check input. Throws EngineerRunError on rejection.
 *
 *   - user_request is non-empty, ≤ 8 KiB, no token-shaped substrings
 *     (fail-closed: a request that itself has a token means the user
 *     pasted one in by mistake; refuse rather than risk it being
 *     echoed into commit messages / PR bodies by the agent).
 *   - branch_name (optional) is non-empty, ≤ 200 bytes.
 */
export function validateInput(input) {
    if (typeof input.user_request !== "string" || input.user_request.length === 0) {
        throw new EngineerRunError("user-request-empty", "user_request required");
    }
    if (Buffer.byteLength(input.user_request, "utf8") > LIMITS.USER_REQUEST_MAX_BYTES) {
        throw new EngineerRunError("user-request-too-long", `user_request exceeds ${LIMITS.USER_REQUEST_MAX_BYTES} bytes`);
    }
    const tokenHits = detectTokens(input.user_request);
    if (tokenHits.length > 0) {
        throw new EngineerRunError("user-request-contains-token", `user_request contains token-shaped substrings: ${tokenHits
            .slice(0, 3)
            .map((h) => JSON.stringify(h))
            .join(", ")}${tokenHits.length > 3 ? ` (+${tokenHits.length - 3} more)` : ""}`);
    }
    if (input.branch_name !== undefined) {
        if (input.branch_name.length === 0) {
            throw new EngineerRunError("branch-name-empty", "branch_name must be non-empty");
        }
        if (Buffer.byteLength(input.branch_name, "utf8") > LIMITS.BRANCH_NAME_MAX_BYTES) {
            throw new EngineerRunError("branch-name-too-long", `branch_name exceeds ${LIMITS.BRANCH_NAME_MAX_BYTES} bytes`);
        }
    }
}
/**
 * Compute a branch name from `user_request`. Format:
 *   `content/<YYYY-MM-DD>-<slug>`
 * where slug is the first 5 words of the request, lowercased, with
 * non-alphanumeric chars replaced by `-`.
 *
 * Exported for testing; pure function, no I/O.
 */
export function suggestBranchName(userRequest, prefix) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const words = userRequest
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .slice(0, 5);
    let slug = words.join("-");
    if (slug.length === 0)
        slug = "update";
    if (slug.length > 50)
        slug = slug.slice(0, 50).replace(/-+$/, "");
    return `${prefix}${today}-${slug}`;
}
/**
 * Read a file with byte cap. Returns the truncated content + a
 * `present` flag. Catches ENOENT and other errors gracefully
 * (returns `{ present: false, content: "" }`).
 *
 * `relPath` must be a relative path inside `repoRoot`. We check that
 * via `assertInsideRepo`; absolute paths or `..` segments throw.
 */
async function readWithCap(relPath, repoRoot, maxBytes) {
    assertInsideRepo(relPath, repoRoot, relPath);
    const absolute = path.resolve(repoRoot, relPath);
    try {
        const buf = await readFile(absolute);
        if (buf.length === 0)
            return { present: false, content: "" };
        const truncated = buf.length > maxBytes;
        const slice = truncated ? buf.subarray(0, maxBytes) : buf;
        if (slice.includes(0)) {
            return {
                present: true,
                content: `(binary file, ${buf.length} bytes, omitted)`,
            };
        }
        return { present: true, content: slice.toString("utf8") };
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return { present: false, content: "" };
        }
        throw err;
    }
}
/**
 * Format the agent-facing instructions block. Plain text, no markdown
 * fancy formatting, since the agent will embed it in its context.
 */
function buildInstructions(out) {
    return [
        `OPERATING ENVIRONMENT`,
        `  Repo: ${out.repo.owner}/${out.repo.name}`,
        `  Base branch: ${out.repo.base_branch}`,
        `  Working directory: ${out.working_dir}`,
        `  Branch prefix: ${out.branch_prefix} (any push/branch MUST start with this)`,
        ``,
        `WHAT YOU MAY EDIT`,
        `  Allowlist:`,
        ...out.allowlist.map((p) => `    - ${p}`),
        ``,
        `WHAT YOU MAY NOT EDIT (denylist)`,
        ...out.denylist.map((p) => `    - ${p}`),
        ``,
        `PRE-COMMIT CHECK`,
        `  Before every commit the host runs: ${out.preflight_cmd}`,
        `  If preflight exits non-zero, the commit is refused automatically.`,
        ``,
        `RECOMMENDED BRANCH`,
        `  ${out.branch_suggestion}`,
        ``,
        `TOOLS YOU SHOULD USE`,
        ...out.tool_inventory.map((t) => `  - ${t}`),
        ``,
        `WORKFLOW`,
        `  1. Run repo_status to confirm the working copy state.`,
        `  2. If working_dir is empty (not yet cloned), call repo_clone first.`,
        `  3. Read project files with repo_read / repo_search to understand current state.`,
        `  4. Apply your changes via repo_edit. The host validates paths against`,
        `     the allowlist and commit_message + PR title against a token blacklist.`,
        `  5. Open a draft PR via pr_create (default: draft=true). DO NOT call any`,
        `     merge API — CI + human review handles that.`,
        ``,
        `HARD RULES`,
        `  - Never push directly to ${out.repo.base_branch}.`,
        `  - Never edit anything outside the allowlist.`,
        `  - Never include credentials, tokens, or API keys in commit messages`,
        `    or PR titles/bodies. The host will refuse such edits.`,
    ].join("\n");
}
/**
 * Run the engineer_run pipeline (without DSH agent involvement).
 * Pure async function; the host bundle wires it via defineTool().
 *
 * Throws EngineerRunError on input rejection. Other errors (readFile
 * failures on workspace files) are reported in the output as
 * `present: false`, not as exceptions.
 */
export async function engineerRun(input, cfg) {
    validateInput(input);
    const branch = input.branch_name ??
        suggestBranchName(input.user_request, cfg.branchPrefix);
    const [agentsMd, readme] = await Promise.all([
        readWithCap("AGENTS.md", cfg.workingDir, LIMITS.AGENTS_MD_MAX_BYTES),
        readWithCap("README.md", cfg.workingDir, LIMITS.README_MAX_BYTES),
    ]);
    const agentsMdExcerpt = agentsMd.present
        ? redactTokens(agentsMd.content)
        : "(no AGENTS.md found in working copy)";
    const readmeExcerpt = readme.present
        ? redactTokens(readme.content)
        : "(no README.md found in working copy)";
    const toolInventory = [
        "mcp__github-engineer__repo_status",
        "mcp__github-engineer__repo_clone",
        "mcp__github-engineer__repo_pull",
        "mcp__github-engineer__repo_read",
        "mcp__github-engineer__repo_search",
        "mcp__github-engineer__repo_edit",
        "mcp__github-engineer__pr_create",
        "mcp__github-engineer__pr_list",
        "engineer_oauth_start / _finish / _refresh / _revoke",
        "engineer_status",
    ];
    const out = {
        branch_suggestion: branch,
        working_dir: cfg.workingDir,
        repo: {
            owner: cfg.repo.owner,
            name: cfg.repo.name,
            base_branch: cfg.repo.baseBranch,
        },
        agents_md_excerpt: agentsMdExcerpt,
        readme_excerpt: readmeExcerpt,
        agents_md_present: agentsMd.present,
        readme_present: readme.present,
        allowlist: [...cfg.allowlistPaths],
        denylist: [...cfg.denylistPaths],
        branch_prefix: cfg.branchPrefix,
        preflight_cmd: cfg.preflightCmd,
        tool_inventory: toolInventory,
    };
    return { ...out, instructions: buildInstructions(out) };
}
