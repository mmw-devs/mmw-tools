/**
 * Local cache of the auth-core repository registry.
 *
 * DSH registers tools synchronously at plugin load, while the registry is
 * fetched over the network after login. The last successful fetch is cached
 * here so the next load can register the same repositories without waiting.
 * A missing or invalid cache is not an error: callers fall back to the
 * profile `repos` list.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
export function repoRegistryCachePath() {
    const override = process.env.DSH_MMW_TOOLS_REPOS_CACHE;
    return override && override.length > 0
        ? override
        : path.join(homedir(), ".dsh", "mmw-tools-repos.json");
}
function strings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
export function readRepoRegistryCache(file = repoRegistryCachePath()) {
    if (!existsSync(file))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (!Array.isArray(parsed.repos))
            return null;
        const repos = [];
        for (const raw of parsed.repos) {
            const key = String(raw?.key ?? "").toLowerCase();
            const owner = String(raw?.owner ?? "").toLowerCase();
            const name = String(raw?.name ?? "").toLowerCase();
            if (!key || !owner || !name)
                continue;
            repos.push({
                key,
                owner,
                name,
                baseBranch: String(raw.baseBranch ?? "main"),
                branchPrefix: String(raw.branchPrefix ?? "content/"),
                allowlistPaths: strings(raw.allowlistPaths),
                denylistPaths: strings(raw.denylistPaths),
            });
        }
        if (repos.length === 0)
            return null;
        return {
            fetchedAt: Number(parsed.fetchedAt ?? 0),
            policyRevision: Number(parsed.policyRevision ?? 0),
            defaultRepo: typeof parsed.defaultRepo === "string" ? parsed.defaultRepo : null,
            repos,
        };
    }
    catch {
        return null;
    }
}
export function writeRepoRegistryCache(cache, file = repoRegistryCachePath()) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    try {
        chmodSync(file, 0o600);
    }
    catch {
        // Windows may not enforce POSIX modes.
    }
}
