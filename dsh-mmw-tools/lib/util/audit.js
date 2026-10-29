/**
 * dsh-mmw-tools — audit trail (host-side).
 *
 * Records what the plugin did, when, and with what outcome, into an
 * append-only JSONL file at `~/.dsh/dsh-mmw-tools-audit.jsonl`
 * (mode 0600). Every string field passes through `redactTokens` before
 * it is written, so a token that slips into a commit message or a
 * branch name never lands on disk.
 *
 * Design constraints:
 *
 *   - **Never blocks the caller.** If the audit write fails (disk full,
 *     permission denied), we log a warning through the supplied logger
 *     and continue. An audit trail is valuable, but refusing to work
 *     because the trail is unwritable is worse.
 *   - **Bounded on disk.** Rotates to `<file>.1` once the live file
 *     exceeds `MAX_BYTES`, so a long-running session cannot fill the
 *     disk.
 *   - **Redacted by construction.** Callers pass structured fields;
 *     the writer stringifies + redacts. There is no "raw" escape hatch.
 */
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { redactTokens } from "./redaction.js";
/** Default audit file location. Overridable via env for tests. */
export function auditPath() {
    const override = process.env.DSH_GITHUB_ENGINEER_AUDIT;
    if (override !== undefined && override !== "")
        return override;
    return path.join(homedir(), ".dsh", "dsh-mmw-tools-audit.jsonl");
}
/** Rotate once the live file passes this size. */
export const MAX_BYTES = 1024 * 1024; // 1 MiB
/**
 * Redact every string inside a value, recursively. Arrays and plain
 * objects are walked; everything else passes through. This is what
 * makes "redacted by construction" true for structured events.
 */
export function redactDeep(value, depth = 0) {
    if (depth > 8)
        return "[depth-limit]";
    if (typeof value === "string")
        return redactTokens(value);
    if (Array.isArray(value))
        return value.map((v) => redactDeep(v, depth + 1));
    if (value !== null && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = redactDeep(v, depth + 1);
        }
        return out;
    }
    return value;
}
/**
 * Create the audit logger. Returns a handle whose `record` is
 * fire-and-forget-safe: it resolves even when the write failed.
 */
export function createAuditLogger(cfg) {
    let warned = false;
    async function rotateIfNeeded() {
        try {
            const info = await stat(cfg.file);
            if (info.size < cfg.maxBytes)
                return;
            await rename(cfg.file, `${cfg.file}.1`);
        }
        catch (err) {
            // Missing file is the normal first-write path.
            if (err.code !== "ENOENT")
                throw err;
        }
    }
    return {
        async record(event) {
            try {
                const line = JSON.stringify({
                    ...redactDeep(event),
                    at: new Date().toISOString(),
                }) + "\n";
                await mkdir(path.dirname(cfg.file), { recursive: true });
                await rotateIfNeeded();
                await appendFile(cfg.file, line, { encoding: "utf8", mode: 0o600 });
            }
            catch (err) {
                // Never let auditing break the plugin. Warn once so the operator
                // sees a single diagnostic instead of one per event.
                if (!warned) {
                    warned = true;
                    cfg.warn(`mmw-tools: audit write failed (${cfg.file}): ${err instanceof Error ? err.message : String(err)} — further audit failures are silent`);
                }
            }
        },
    };
}
/**
 * Wrap a DSH logger so every message is token-redacted on the way out.
 * The plugin logs branch names, PR titles, and preflight stderr; any of
 * those could carry a token the user pasted in.
 */
export function createRedactingLogger(base) {
    return {
        info: (m) => base.info(redactTokens(String(m))),
        warn: (m) => base.warn(redactTokens(String(m))),
        error: (m) => base.error(redactTokens(String(m))),
    };
}
