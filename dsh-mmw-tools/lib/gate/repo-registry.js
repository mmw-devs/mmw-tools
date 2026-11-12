export function repoKey(owner, name) {
    return `${owner}/${name}`.toLowerCase();
}
export class RepoRegistry {
    byKey = new Map();
    selected = new Map();
    defaultKey;
    constructor(entries, defaultKey) {
        for (const entry of entries) {
            this.byKey.set(entry.key, entry);
        }
        this.defaultKey = defaultKey;
    }
    get size() {
        return this.byKey.size;
    }
    keys() {
        return [...this.byKey.keys()];
    }
    /** Case-insensitive lookup. Returns null for an unregistered repository. */
    normalize(input) {
        const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
        const parts = trimmed.split("/");
        if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0)
            return null;
        const key = repoKey(parts[0], parts[1]);
        return this.byKey.has(key) ? key : null;
    }
    entry(key) {
        return this.byKey.get(key);
    }
    selectedBy(sessionId) {
        return this.selected.get(sessionId);
    }
    /**
     * Bind a session to a repository. Idempotent for the same repository;
     * a different repository is refused.
     */
    select(sessionId, input) {
        const key = this.normalize(input);
        if (!key) {
            return {
                ok: false,
                reason: `未知仓库 ${JSON.stringify(input)}；可用仓库：${this.keys().join(", ")}`,
            };
        }
        const current = this.selected.get(sessionId);
        if (current && current !== key) {
            return {
                ok: false,
                reason: `本会话已选择 ${current}，不能再切换到 ${key}；新会话请重新选择`,
            };
        }
        this.selected.set(sessionId, key);
        return { ok: true, key };
    }
    /** Test seam: forget every binding. */
    clear() {
        this.selected.clear();
    }
}
