/**
 * Workspace mode — is this session's directory a checkout of one of the
 * repositories the plugin is allowed to serve?
 *
 * The answer is deliberately NOT derived from `.dsh-mmw-tools.yaml` alone:
 * that file is the repository's machine-readable *rule* file, not a registry
 * entry. A copy of the file does not make a directory a served checkout, and a
 * registered checkout may not have been cloned yet. The authoritative inputs
 * are the repository registry (which repos exist) and the checkout's Git
 * origin (which repo this directory actually is); the rule file is a
 * precondition for writes, not an identity document.
 *
 * The module is pure apart from reading the working tree, so it can be tested
 * without a DSH host.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type WorkspaceMode = "managed" | "unmanaged" | "mismatch" | "bootstrap" | "unknown";

export interface WorkspaceSnapshot {
  mode: WorkspaceMode;
  /** Nearest policy root, else the Git root, else the session directory. */
  root: string;
  /** Absolute path to `.dsh-mmw-tools.yaml`, when one was found. */
  marker: string | null;
  /** `owner/name` parsed from the checkout's `origin` remote. */
  gitRepo: string | null;
  /** Repository the mode is about: selected, detected, or bootstrap target. */
  repo: string | null;
  reason: string;
}

export interface WorkspaceRegistryEntry {
  key: string;
  workingDir: string;
}

function isInsidePath(child: string, parent: string): boolean {
  let rel: string;
  try {
    rel = path.relative(path.resolve(parent), path.resolve(child));
  } catch {
    return false;
  }
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Walk up from `cwd` and return the first existing `name`, or null. */
function findUp(cwd: string, name: string): string | null {
  let dir: string;
  try {
    dir = path.resolve(cwd);
  } catch {
    return null;
  }
  for (;;) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function findPolicyFile(cwd: string): string | null {
  return findUp(cwd, ".dsh-mmw-tools.yaml");
}

/** Parse `owner/name` out of a Git remote URL. */
export function repoFromRemote(url: string): string | null {
  let value = url.trim();
  if (value.length === 0) return null;

  // scp-like: git@github.com:owner/repo.git
  const scp = /^[^@\s]+@[^:\s]+:(.+)$/.exec(value);
  if (scp) {
    value = scp[1];
  } else {
    try {
      const parsed = new URL(value);
      value = parsed.pathname;
    } catch {
      // Not a URL: treat it as a path.
    }
  }

  value = value.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  value = value.replace(/^\/+|\/+$/g, "");
  if (value.endsWith(".git")) value = value.slice(0, -4);
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[parts.length - 2];
  const name = parts[parts.length - 1];
  if (owner.length === 0 || name.length === 0) return null;
  return `${owner}/${name}`.toLowerCase();
}

function readOriginUrl(gitPath: string): string | null {
  try {
    let gitDir = gitPath;
    if (!statSync(gitPath).isDirectory()) {
      const head = readFileSync(gitPath, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(head);
      if (!match) return null;
      gitDir = path.resolve(path.dirname(gitPath), match[1].trim());
    }
    let configPath = path.join(gitDir, "config");
    if (!existsSync(configPath)) {
      const commonPath = path.join(gitDir, "commondir");
      if (!existsSync(commonPath)) return null;
      const common = readFileSync(commonPath, "utf8").trim();
      configPath = path.resolve(gitDir, common, "config");
    }
    if (!existsSync(configPath)) return null;
    const config = readFileSync(configPath, "utf8");
    const section = /\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/.exec(config);
    if (!section) return null;
    const url = /^\s*url\s*=\s*(.+)$/m.exec(section[1]);
    return url ? url[1].trim() : null;
  } catch {
    return null;
  }
}

export function readGitRepo(cwd: string): { root: string; repo: string | null } | null {
  const gitPath = findUp(cwd, ".git");
  if (!gitPath) return null;
  const root = path.dirname(gitPath);
  const url = readOriginUrl(gitPath);
  return { root, repo: url ? repoFromRemote(url) : null };
}

/**
 * Resolve the session's workspace mode.
 *
 * Inputs are all local: the registry comes from the plugin's cache, the repo
 * identity from `.git/config`, and the policy file from the working tree.
 */
export function resolveWorkspaceMode(opts: {
  cwd: string | undefined;
  registry: WorkspaceRegistryEntry[];
  selected?: string;
}): WorkspaceSnapshot {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : undefined;
  if (!cwd) {
    return {
      mode: "unknown",
      root: "",
      marker: null,
      gitRepo: null,
      repo: opts.selected ?? null,
      reason: "无法确定当前会话的工作目录",
    };
  }

  const marker = findPolicyFile(cwd);
  const git = readGitRepo(cwd);
  const gitRepo = git?.repo ?? null;
  const root = marker ? path.dirname(marker) : git?.root ?? cwd;
  const registered = new Set(opts.registry.map((entry) => entry.key.toLowerCase()));
  const selected = opts.selected?.toLowerCase();

  if (selected) {
    if (!registered.has(selected)) {
      return {
        mode: "mismatch",
        root,
        marker,
        gitRepo,
        repo: selected,
        reason: `会话已选择 ${selected}，但它不在仓库注册表中`,
      };
    }
    if (!gitRepo) {
      return {
        mode: "mismatch",
        root,
        marker,
        gitRepo,
        repo: selected,
        reason: "无法从当前工作区识别出 Git 仓库",
      };
    }
    if (gitRepo !== selected) {
      return {
        mode: "mismatch",
        root,
        marker,
        gitRepo,
        repo: selected,
        reason: `当前工作区属于 ${gitRepo}，与已选择的 ${selected} 不一致`,
      };
    }
    if (!marker) {
      return {
        mode: "mismatch",
        root,
        marker,
        gitRepo,
        repo: selected,
        reason: "当前工作区缺少 .dsh-mmw-tools.yaml，规则文件尚未就绪",
      };
    }
    return {
      mode: "managed",
      root,
      marker,
      gitRepo,
      repo: selected,
      reason: "工作区、注册表与规则文件一致",
    };
  }

  if (gitRepo) {
    if (!registered.has(gitRepo)) {
      return {
        mode: marker ? "mismatch" : "unmanaged",
        root,
        marker,
        gitRepo,
        repo: gitRepo,
        reason: marker
          ? `工作区有规则文件，但 ${gitRepo} 不在仓库注册表中`
          : `当前工作区属于 ${gitRepo}，它不在仓库注册表中`,
      };
    }
    if (!marker) {
      return {
        mode: "mismatch",
        root,
        marker,
        gitRepo,
        repo: gitRepo,
        reason: "已注册仓库的 checkout 缺少 .dsh-mmw-tools.yaml",
      };
    }
    return {
      mode: "managed",
      root,
      marker,
      gitRepo,
      repo: gitRepo,
      reason: "工作区属于已注册仓库，且规则文件存在",
    };
  }

  const bootstrap = opts.registry.find(
    (entry) => isInsidePath(cwd, entry.workingDir) && !existsSync(path.join(entry.workingDir, ".git"))
  );
  if (bootstrap) {
    return {
      mode: "bootstrap",
      root: bootstrap.workingDir,
      marker,
      gitRepo: null,
      repo: bootstrap.key.toLowerCase(),
      reason: `仓库 ${bootstrap.key} 尚未 clone`,
    };
  }

  if (marker) {
    return {
      mode: "mismatch",
      root,
      marker,
      gitRepo: null,
      repo: null,
      reason: "工作区有规则文件，但无法识别 Git 仓库归属",
    };
  }

  return {
    mode: "unmanaged",
    root,
    marker: null,
    gitRepo: null,
    repo: null,
    reason: "当前工作区不是任何已注册仓库的 checkout",
  };
}
