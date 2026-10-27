/**
 * dsh-github-engineer MCP server — repo_read tool.
 *
 * Reads a file from the cloned working copy. Truncates at max_bytes
 * (default 100 KiB, hard cap 500 KiB). Binary content is detected
 * by NUL bytes and refused.
 *
 * Per docs/INCREMENT-3-CHECKLIST.md:
 *   - assertSafeRepoPath
 *   - assertWithinLimit on content
 */
import { readFile } from "node:fs/promises";
import { assertSafeRepoPath, assertWithinLimit, GithubRefusedError, LIMITS, } from "../guard.js";
export async function repoRead(input, cfg) {
    if (typeof input.path !== "string" || input.path.length === 0) {
        throw new GithubRefusedError("path-required", "path is required");
    }
    const absolutePath = await assertSafeRepoPath(input.path, cfg.workingDir);
    // Honor max_bytes up to the hard cap.
    let maxBytes = LIMITS.READ_MAX_BYTES;
    if (typeof input.max_bytes === "number" && input.max_bytes > 0) {
        maxBytes = Math.min(input.max_bytes, LIMITS.READ_HARD_CAP_BYTES);
    }
    // Read the file.
    let buffer;
    try {
        buffer = await readFile(absolutePath);
    }
    catch (err) {
        const e = err;
        if (e.code === "ENOENT") {
            throw new GithubRefusedError("file-not-found", `file not found: ${input.path}`);
        }
        throw err;
    }
    const truncated = buffer.length > maxBytes;
    const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
    // Refuse binary files: first NUL byte within the read window.
    if (slice.includes(0)) {
        throw new GithubRefusedError("file-binary", `file ${input.path} appears to be binary (NUL byte within first ${maxBytes} bytes)`);
    }
    const content = slice.toString("utf8");
    // Confirm size invariant.
    assertWithinLimit(content, LIMITS.READ_HARD_CAP_BYTES, "content");
    // Cheap content hash (FNV-1a 64-bit) — we don't need crypto strength,
    // just a stable identifier. Express as hex.
    let hash = 0xcbf29ce484222325n;
    for (const byte of slice) {
        hash = (hash ^ BigInt(byte)) * 0x100000001b3n & 0xffffffffffffffffn;
    }
    const sha = hash.toString(16).padStart(16, "0");
    return {
        content,
        sha,
        truncated,
        byte_size: buffer.length,
    };
}
