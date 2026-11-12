/**
 * Session-level repository selection.
 *
 * Tool names do not carry a repository (docs/TOOL-NAMING.md). A session calls
 * `select_repo` once; the gate then refuses business tools in that session
 * until a repository is chosen, and the MCP bridge forwards the choice in
 * `_meta`. The first selection wins: a session cannot silently switch
 * repositories halfway through a task.
 */
export interface RepoEntry {
  /** Canonical `owner/name`, lower-case. */
  key: string;
  owner: string;
  name: string;
  baseBranch: string;
  branchPrefix: string;
  allowlistPaths: string[];
  denylistPaths: string[];
  workingDir: string;
  /** File the MCP child reads the read-only installation token from. */
  tokenFile: string;
  repoUrl: string;
  preflight: { cmd: string; timeoutSeconds: number };
  bootstrap: { cmd: string; whenMissing: string; timeoutSeconds: number };
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

export class RepoRegistry {
  private readonly byKey = new Map<string, RepoEntry>();
  private readonly selected = new Map<string, string>();
  readonly defaultKey: string;

  constructor(entries: RepoEntry[], defaultKey: string) {
    for (const entry of entries) {
      this.byKey.set(entry.key, entry);
    }
    this.defaultKey = defaultKey;
  }

  get size(): number {
    return this.byKey.size;
  }

  keys(): string[] {
    return [...this.byKey.keys()];
  }

  /** Case-insensitive lookup. Returns null for an unregistered repository. */
  normalize(input: string): string | null {
    const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
    const parts = trimmed.split("/");
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) return null;
    const key = repoKey(parts[0], parts[1]);
    return this.byKey.has(key) ? key : null;
  }

  entry(key: string): RepoEntry | undefined {
    return this.byKey.get(key);
  }

  selectedBy(sessionId: string): string | undefined {
    return this.selected.get(sessionId);
  }

  /**
   * Bind a session to a repository. Idempotent for the same repository;
   * a different repository is refused.
   */
  select(
    sessionId: string,
    input: string
  ): { ok: true; key: string } | { ok: false; reason: string } {
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
  clear(): void {
    this.selected.clear();
  }
}
