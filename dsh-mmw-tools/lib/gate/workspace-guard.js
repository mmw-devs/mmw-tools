/**
 * Workspace guard — the plugin's tools belong to ONE repository, so they may
 * only run in a session whose working directory is inside that repository's
 * checkout.
 *
 * Why a session-level guard rather than a profile: a DSH plugin is loaded per
 * PROFILE, and the profile is decided when the process starts. The workspace,
 * by contrast, is chosen per Session and can change mid-session with `cd`. A
 * profile therefore cannot express "this workspace yes, that workspace no"
 * without a second process on a second port. The session's working directory
 * can: the host exposes it synchronously (no filesystem I/O) through the
 * `workingDirectory` service, and every `tools/pre-execute` execution carries
 * the calling `agent` — so `workingDirectory.get(exec.agent.session)` is the
 * exact answer to "where is the session that is calling this tool?".
 *
 * The check runs on EVERY call rather than once at agent creation, because the
 * agent can `cd` in and out of the repository directory during a session.
 *
 * Ordering note: this listener is installed BEFORE the Feishu policy gate. A
 * call from the wrong workspace is refused for the workspace reason, without
 * an auth round trip and without the misleading "飞书授权不可用" message.
 *
 * Two exceptions are deliberate: `mmw_tools_status` is a diagnostic that must
 * work anywhere, and `repo_clone` may create the checkout while its root has
 * no `.git`. Both are narrow; all other business tools obey the workspace rule.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { isMmwTool } from "./tool-map.js";
/**
 * Diagnostic tool that must work from any session, including one outside the
 * checkout. It reports auth/binding state; refusing it there would hide the
 * very reason the other tools are unavailable.
 */
const STATUS_TOOL = "mmw_tools_status";
/**
 * The only tool allowed to run before the checkout exists. `repo_clone` is the
 * bootstrap operation: the first session has to be able to create the checkout
 * it will later work in. The exception is narrow — outside the root and only
 * while the root has no `.git` — so a live checkout is never cloned over from
 * an unrelated workspace.
 */
const BOOTSTRAP_TOOL = "mcp__mmw-tools__repo_clone";
/**
 * True when `child` is `parent` itself or lives underneath it.
 *
 * `path.relative` is not enough on its own: it reports `..\\repo-evil` for a
 * sibling whose name merely starts with the parent's name, and it reports `..`
 * for the parent's own parent. Both are handled explicitly. On Windows the
 * comparison is case-insensitive, which `path.relative` already accounts for.
 */
export function isInsidePath(child, parent) {
    let rel;
    try {
        rel = path.relative(path.resolve(parent), path.resolve(child));
    }
    catch {
        return false;
    }
    if (rel === "")
        return true;
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
/**
 * True only for the bootstrap call: `repo_clone`, from outside the bound
 * checkout, while that checkout's primary root has no `.git`. Once a live
 * checkout exists, the normal workspace rule applies again.
 */
export function isBootstrapCall(name, cwd, roots) {
    if (name !== BOOTSTRAP_TOOL)
        return false;
    if (cwd === undefined || cwd.length === 0)
        return false;
    if (roots.length === 0)
        return false;
    const root = roots[0];
    if (isInsidePath(cwd, root))
        return false;
    return !existsSync(path.join(root, ".git"));
}
/** Pure decision, exported so the policy can be tested without a host. */
export function shouldAllowWorkspace(cwd, roots, onUnavailable = "deny") {
    if (cwd === undefined || cwd.length === 0) {
        return onUnavailable === "deny"
            ? {
                ok: false,
                reason: "mmw-tools: 无法确定当前会话的工作目录，已拒绝调用（workspaceGuard.onUnavailable = deny）",
            }
            : { ok: true };
    }
    if (roots.some((root) => isInsidePath(cwd, root)))
        return { ok: true };
    const allowed = roots.length > 0 ? roots.join(" 或 ") : "(未配置)";
    return {
        ok: false,
        reason: `mmw-tools 只在绑定仓库的工作区可用（当前会话目录：${cwd}；允许：${allowed}）`,
    };
}
/** Resolve a cordis service without assuming it is declared or ready. */
function lookupService(scope, name) {
    if (scope === undefined || scope === null)
        return undefined;
    const holder = scope;
    if (typeof holder.get === "function") {
        try {
            const viaGet = holder.get(name);
            if (viaGet !== undefined && viaGet !== null)
                return viaGet;
        }
        catch {
            // A declared-but-not-ready service throws on access; fall through.
        }
    }
    try {
        const direct = holder[name];
        if (direct !== undefined && direct !== null)
            return direct;
    }
    catch {
        // The getter threw for the same reason; there is nothing left to try.
    }
    return undefined;
}
/** Warn at most once per distinct message. */
function onceWarn(logger) {
    const seen = new Set();
    return (message) => {
        if (seen.has(message))
            return;
        seen.add(message);
        logger.warn(message);
    };
}
/**
 * Read the session's committed working directory for one execution.
 *
 * The agent-scoped context is preferred (services can be layered per agent);
 * the plugin's own context is the fallback. Returns undefined — never throws —
 * when the host has no `workingDirectory` service, because a profile that does
 * not mount it must not take the plugin down.
 */
function makeWorkingDirectoryReader(ctx, logger) {
    const warn = onceWarn(logger);
    return (exec) => {
        const agent = exec?.agent;
        const session = agent?.session;
        if (session === undefined || session === null)
            return undefined;
        const service = lookupService(agent?.ctx, "workingDirectory") ?? lookupService(ctx, "workingDirectory");
        if (service === undefined) {
            warn("mmw-tools: 宿主未提供 workingDirectory 服务，工作区闸门无法判定（按 onUnavailable 处理）");
            return undefined;
        }
        const reader = service;
        if (typeof reader.get !== "function") {
            warn("mmw-tools: workingDirectory 服务没有 get(session)，工作区闸门无法判定");
            return undefined;
        }
        try {
            const value = reader.get(session);
            return typeof value === "string" && value.length > 0 ? value : undefined;
        }
        catch (err) {
            warn(`mmw-tools: 读取会话工作目录失败：${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
    };
}
/**
 * Install the guard as a `tools/pre-execute` waterfall listener.
 *
 * Only the plugin's own tools are inspected; every other tool in the session
 * goes straight to the host's `next()`. This plugin has no authority over the
 * host's standard tools, and denying them is the very bug this release fixes.
 */
export function installWorkspaceGuard(ctx, opts) {
    if (opts.enabled === false)
        return () => { };
    const onUnavailable = opts.onUnavailable ?? "deny";
    const on = ctx.on;
    if (typeof on !== "function") {
        opts.logger.warn("mmw-tools: tools/pre-execute unavailable; the workspace guard is NOT installed");
        return () => { };
    }
    const cwdOf = opts.workingDirectoryOf ?? makeWorkingDirectoryReader(ctx, opts.logger);
    try {
        const disposer = on.call(ctx, "tools/pre-execute", async (exec, next) => {
            const name = exec?.name;
            if (typeof name !== "string" || !isMmwTool(name))
                return next();
            // Status is a diagnostic surface, not a repository operation. It must
            // remain callable from a wrong workspace so the agent can explain why
            // the repository tools are refused.
            if (name === STATUS_TOOL)
                return next();
            const cwd = cwdOf(exec);
            if (isBootstrapCall(name, cwd, opts.roots))
                return next();
            const verdict = shouldAllowWorkspace(cwd, opts.roots, onUnavailable);
            if (!verdict.ok)
                return { kind: "deny", reason: verdict.reason };
            return next();
        });
        return typeof disposer === "function" ? disposer : () => { };
    }
    catch (err) {
        opts.logger.warn(`mmw-tools: workspace guard not installed: ${err instanceof Error ? err.message : String(err)}`);
        return () => { };
    }
}
