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
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
/**
 * Resolve a path to the spelling the filesystem actually uses, for
 * containment comparison only.
 *
 * A literal `path.resolve` comparison is wrong on real machines for two
 * reasons:
 *
 *   - symlinks — macOS puts `/tmp` -> `/private/tmp` and `/var` ->
 *     `/private/var`, and a checkout can sit behind a symlinked home,
 *     `~/Developer`, or a mounted volume. The same directory then has two
 *     spellings.
 *   - case — APFS and NTFS are case-insensitive by default, so a session
 *     directory and a configured root can differ in letter case while
 *     naming the same directory.
 *
 * The longest existing prefix is realpath'd; a suffix that does not exist yet
 * (the `repo_clone` bootstrap target) is kept lexically. Callers report the
 * path they were given — this value is only ever compared.
 */
export function canonicalPathForCompare(input) {
    let resolved;
    try {
        resolved = path.resolve(input);
    }
    catch {
        return input;
    }
    const suffix = [];
    let current = resolved;
    for (;;) {
        try {
            const real = realpathSync.native(current);
            resolved = suffix.length === 0 ? real : path.join(real, ...suffix.reverse());
            break;
        }
        catch {
            const parent = path.dirname(current);
            // Nothing on this path exists; the lexical form is the best comparison
            // available.
            if (parent === current)
                break;
            suffix.push(path.basename(current));
            current = parent;
        }
    }
    // Case folding is comparison-only and only on platforms whose default
    // filesystem is case-insensitive. A case-sensitive Linux checkout keeps
    // literal semantics.
    return process.platform === "win32" || process.platform === "darwin"
        ? resolved.toLowerCase()
        : resolved;
}
/**
 * True when `child` is `parent` itself or lives underneath it.
 *
 * `path.relative` alone is not enough even with canonical paths: it reports
 * `..\\repo-evil` (or `../repo-evil`) for a sibling whose name merely starts
 * with the parent's name, and `..` for the parent's own parent. Both are
 * handled explicitly. The comparison uses {@link canonicalPathForCompare}, so
 * symlinked and case-variant spellings of one directory count as equal.
 */
export function isInsidePath(child, parent) {
    let rel;
    try {
        rel = path.relative(canonicalPathForCompare(parent), canonicalPathForCompare(child));
    }
    catch {
        return false;
    }
    if (rel === "")
        return true;
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
/** Walk up from `cwd` and return the first existing `name`, or null. */
function findUp(cwd, name) {
    let dir;
    try {
        dir = path.resolve(cwd);
    }
    catch {
        return null;
    }
    for (;;) {
        const candidate = path.join(dir, name);
        if (existsSync(candidate))
            return candidate;
        const parent = path.dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
export function findPolicyFile(cwd) {
    return findUp(cwd, ".dsh-mmw-tools.yaml");
}
/** Parse `owner/name` out of a Git remote URL. */
export function repoFromRemote(url) {
    let value = url.trim();
    if (value.length === 0)
        return null;
    // scp-like: git@github.com:owner/repo.git
    const scp = /^[^@\s]+@[^:\s]+:(.+)$/.exec(value);
    if (scp) {
        value = scp[1];
    }
    else {
        try {
            const parsed = new URL(value);
            value = parsed.pathname;
        }
        catch {
            // Not a URL: treat it as a path.
        }
    }
    value = value.split(/[?#]/, 1)[0].replace(/\\/g, "/");
    value = value.replace(/^\/+|\/+$/g, "");
    if (value.endsWith(".git"))
        value = value.slice(0, -4);
    const parts = value.split("/").filter(Boolean);
    if (parts.length < 2)
        return null;
    const owner = parts[parts.length - 2];
    const name = parts[parts.length - 1];
    if (owner.length === 0 || name.length === 0)
        return null;
    return `${owner}/${name}`.toLowerCase();
}
function readOriginUrl(gitPath) {
    try {
        let gitDir = gitPath;
        if (!statSync(gitPath).isDirectory()) {
            const head = readFileSync(gitPath, "utf8");
            const match = /^gitdir:\s*(.+)$/m.exec(head);
            if (!match)
                return null;
            gitDir = path.resolve(path.dirname(gitPath), match[1].trim());
        }
        let configPath = path.join(gitDir, "config");
        if (!existsSync(configPath)) {
            const commonPath = path.join(gitDir, "commondir");
            if (!existsSync(commonPath))
                return null;
            const common = readFileSync(commonPath, "utf8").trim();
            configPath = path.resolve(gitDir, common, "config");
        }
        if (!existsSync(configPath))
            return null;
        const config = readFileSync(configPath, "utf8");
        const section = /\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/.exec(config);
        if (!section)
            return null;
        const url = /^\s*url\s*=\s*(.+)$/m.exec(section[1]);
        return url ? url[1].trim() : null;
    }
    catch {
        return null;
    }
}
export function readGitRepo(cwd) {
    const gitPath = findUp(cwd, ".git");
    if (!gitPath)
        return null;
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
export function resolveWorkspaceMode(opts) {
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
    const bootstrap = opts.registry.find((entry) => isInsidePath(cwd, entry.workingDir) && !existsSync(path.join(entry.workingDir, ".git")));
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
