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

export interface CachedRepo {
  key: string;
  owner: string;
  name: string;
  baseBranch: string;
  branchPrefix: string;
  allowlistPaths: string[];
  denylistPaths: string[];
  /** Present when the last select_repo also read `.dsh-mmw-tools.yaml`. */
  preflight?: { cmd: string; timeoutSeconds: number };
  bootstrap?: { cmd: string; whenMissing: string; timeoutSeconds: number };
  prDefaultDraft?: boolean;
}

export interface RepoRegistryCache {
  fetchedAt: number;
  policyRevision: number;
  defaultRepo: string | null;
  repos: CachedRepo[];
}

export function repoRegistryCachePath(): string {
  const override = process.env.DSH_MMW_TOOLS_REPOS_CACHE;
  return override && override.length > 0
    ? override
    : path.join(homedir(), ".dsh", "mmw-tools-repos.json");
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function readRepoRegistryCache(file = repoRegistryCachePath()): RepoRegistryCache | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RepoRegistryCache>;
    if (!Array.isArray(parsed.repos)) return null;
    const repos: CachedRepo[] = [];
    for (const raw of parsed.repos as any[]) {
      const key = String(raw?.key ?? "").toLowerCase();
      const owner = String(raw?.owner ?? "").toLowerCase();
      const name = String(raw?.name ?? "").toLowerCase();
      if (!key || !owner || !name) continue;
      const command = (value: unknown) => {
        const record = value && typeof value === "object" ? (value as any) : {};
        const timeout = Number(record.timeoutSeconds ?? 300);
        return {
          cmd: typeof record.cmd === "string" ? record.cmd : "",
          timeoutSeconds: Number.isInteger(timeout) && timeout > 0 ? timeout : 300,
        };
      };
      const bootstrapRecord = raw.bootstrap && typeof raw.bootstrap === "object" ? raw.bootstrap : {};
      repos.push({
        key,
        owner,
        name,
        baseBranch: String(raw.baseBranch ?? "main"),
        branchPrefix: String(raw.branchPrefix ?? "content/"),
        allowlistPaths: strings(raw.allowlistPaths),
        denylistPaths: strings(raw.denylistPaths),
        ...(raw.preflight ? { preflight: command(raw.preflight) } : {}),
        ...(raw.bootstrap
          ? { bootstrap: { ...command(raw.bootstrap), whenMissing: String(bootstrapRecord.whenMissing ?? "") } }
          : {}),
        ...(typeof raw.prDefaultDraft === "boolean" ? { prDefaultDraft: raw.prDefaultDraft } : {}),
      });
    }
    if (repos.length === 0) return null;
    return {
      fetchedAt: Number(parsed.fetchedAt ?? 0),
      policyRevision: Number(parsed.policyRevision ?? 0),
      defaultRepo: typeof parsed.defaultRepo === "string" ? parsed.defaultRepo : null,
      repos,
    };
  } catch {
    return null;
  }
}

export function writeRepoRegistryCache(cache: RepoRegistryCache, file = repoRegistryCachePath()): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows may not enforce POSIX modes.
  }
}
