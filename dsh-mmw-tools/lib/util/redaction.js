/**
 * dsh-mmw-tools — token-redaction + path-safety utilities (host).
 *
 * Mirrors `mcp-server/src/guard.ts::detectTokens / redactTokens /
 * assertSafeRepoPath` so the host bundle can use the same regex
 * without taking a runtime dependency on the mcp-server subpackage.
 * Keep the two copies in sync; the mcp-server copy is the
 * authority for "what counts as a token" because it's the place
 * where the assertion actually fails tool calls.
 *
 * If you add a pattern here, add it to mcp-server/src/guard.ts too.
 */
import path from "node:path";
const TOKEN_BLACKLIST = [
    // GitHub classic PAT (gho_, ghp_, ghu_, ghs_, ghr_) — 36+ chars,
    // counting from the prefix (after the leading underscore) we need
    // ≥ 20 base62 chars to match.
    /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g,
    // GitHub fine-grained PAT — `github_pat_11XXX_` + base62 (underscores
    // and alphanumerics), ≥ 20 chars.
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    // Bearer / token / key / secret / password forms. Both:
    //   (a) with separator: `key: value` or `key=value`
    //   (b) bare, with whitespace after the keyword: `Bearer <token>`,
    //       `Authorization: <token>`, `key <token>`
    /\b(access_token|authorization|bearer|api[-_]?key|client[-_]?secret|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._-]+/gi,
    /\b(bearer|token|key|secret)\s+["']?[A-Za-z0-9_.-]{16,}/gi,
];
/** Detect token-shaped substrings. */
export function detectTokens(s) {
    const hits = [];
    for (const re of TOKEN_BLACKLIST) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(s)) !== null) {
            hits.push(m[0]);
        }
    }
    return hits;
}
/** Soft-redact tokens. Use for logger output / excerpts sent to LLMs. */
export function redactTokens(s) {
    let out = s;
    for (const re of TOKEN_BLACKLIST) {
        out = out.replace(re, "[REDACTED]");
    }
    return out;
}
/**
 * Refuse if any token-shaped substring is present. Throws
 * `Error` (host-side) — mcp-server's `assertNoTokens` throws a
 * typed `GithubRefusedError`. Both surfaces use the same detection.
 */
export function assertNoTokens(s, fieldName) {
    const hits = detectTokens(s);
    if (hits.length > 0) {
        throw new Error(`${fieldName} contains token-shaped substrings: ${hits
            .slice(0, 3)
            .map((h) => JSON.stringify(h))
            .join(", ")}${hits.length > 3 ? ` (+${hits.length - 3} more)` : ""}`);
    }
}
/**
 * Lightweight host-side path safety for files inside a known working
 * directory. Refuses absolute paths, `..` segments, and NUL bytes.
 * Symlink escape is NOT enforced here (mcp-server's `assertSafeRepoPath`
 * does that); this is a defence for the host's own file reads.
 */
export function assertInsideRepo(input, repoRoot, fieldName) {
    if (typeof input !== "string" || input.length === 0) {
        throw new Error(`${fieldName} must be a non-empty path`);
    }
    if (input.includes("\0")) {
        throw new Error(`${fieldName} contains NUL byte`);
    }
    if (path.isAbsolute(input)) {
        throw new Error(`${fieldName} must be relative, got ${input}`);
    }
    const absolute = path.resolve(repoRoot, input);
    // `path.relative` instead of a prefix comparison: on Windows it is
    // case-insensitive and separator-normalizing, so a short-form root
    // (`C:\Users\RUNNER~1\...`) does not falsely reject a long-form child.
    // Same reasoning as guard.ts::isInsideRoot.
    const rel = path.relative(repoRoot, absolute);
    const inside = rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
    if (!inside) {
        throw new Error(`${fieldName} resolves to ${absolute} which is outside ${repoRoot}`);
    }
}
