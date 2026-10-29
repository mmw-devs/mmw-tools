/**
 * Session store — the broker's session token, and nothing else.
 *
 * This replaces the previous token store. That one held a GitHub
 * `access_token` and `refresh_token`, which only made sense while the
 * plugin itself performed OAuth. Under the broker design
 * (docs/AUTH-BROKER.md) the plugin never holds a GitHub credential:
 * it holds a 12-hour session token that can only be exchanged, against a
 * live allowlist check, for a 1-hour installation token that stays in
 * memory.
 *
 * Consequences worth stating, because they are the point of the split:
 *   - Nothing here can write to a repository.
 *   - Losing this file costs one sign-in, not a repository.
 *   - "Revoke" is a server call, not just a local file deletion.
 */
import { readFile, writeFile, mkdir, chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
const DEFAULT_SESSION_FILE = path.join(homedir(), ".dsh", "dsh-mmw-tools-session.json");
/** Overridable for tests and for multi-profile machines. */
export function sessionPath() {
    const override = process.env.DSH_GITHUB_ENGINEER_SESSION;
    return override && override.length > 0 ? override : DEFAULT_SESSION_FILE;
}
export class SessionStore {
    file;
    constructor(opts = {}) {
        this.file = opts.file ?? sessionPath();
    }
    get path() {
        return this.file;
    }
    /** Returns null on any read problem: a corrupt file means "sign in". */
    async read() {
        if (!existsSync(this.file))
            return null;
        try {
            const raw = await readFile(this.file, "utf8");
            const parsed = JSON.parse(raw);
            if (typeof parsed.sessionToken !== "string" ||
                parsed.sessionToken.length === 0 ||
                typeof parsed.expiresAt !== "number") {
                return null;
            }
            return {
                sessionToken: parsed.sessionToken,
                login: typeof parsed.login === "string" ? parsed.login : "",
                expiresAt: parsed.expiresAt,
                brokerUrl: typeof parsed.brokerUrl === "string" ? parsed.brokerUrl : "",
                updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
            };
        }
        catch {
            return null;
        }
    }
    /** A record that is present and not past its expiry. */
    async readValid(now = Date.now()) {
        const record = await this.read();
        if (!record)
            return null;
        return record.expiresAt > now ? record : null;
    }
    async save(record) {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(this.file, JSON.stringify(record, null, 2), { mode: 0o600 });
        // `mode` on write only applies when the file is created; an existing
        // file keeps its old mode. Set it explicitly so a file created by an
        // older version (or by hand) cannot be world-readable.
        try {
            await chmod(this.file, 0o600);
        }
        catch {
            // Windows and FAT filesystems may not support chmod; the write
            // above already used 0600 where it was honoured.
        }
    }
    async clear() {
        try {
            await unlink(this.file);
        }
        catch (err) {
            if (err.code !== "ENOENT")
                throw err;
        }
    }
    /** For the status surface: enough to display, never enough to use. */
    async describe(now = Date.now()) {
        const record = await this.read();
        if (!record) {
            return {
                signedIn: false,
                login: "",
                brokerUrl: "",
                expiresAt: 0,
                secondsRemaining: 0,
                sessionTokenMasked: "",
            };
        }
        const remaining = Math.max(0, Math.floor((record.expiresAt - now) / 1000));
        return {
            signedIn: record.expiresAt > now,
            login: record.login,
            brokerUrl: record.brokerUrl,
            expiresAt: record.expiresAt,
            secondsRemaining: remaining,
            sessionTokenMasked: maskToken(record.sessionToken),
        };
    }
}
/** Show the first and last four characters, nothing else. */
export function maskToken(token) {
    if (typeof token !== "string" || token.length === 0)
        return "";
    if (token.length <= 12)
        return "*".repeat(token.length);
    return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
