import { FeishuAuthError } from "../auth/feishu-auth.js";
import { newRunId, runWithRunId } from "../util/run-context.js";
import { TOOL_MAP, isMmwTool } from "./tool-map.js";
function deny(code, message) {
    return { ok: false, reason: `[${code}] ${message}` };
}
function authErrorCode(err) {
    if (err.code === "auth-required" || err.code === "mmw_auth_required")
        return "mmw_auth_required";
    if (err.code === "mmw_session_expired")
        return "mmw_session_expired";
    // Network failures, 5xx, malformed responses, and a missing/expired table:
    // the policy layer has no answer, so the operation is denied as unavailable.
    return "mmw_policy_unavailable";
}
function sessionIdOf(exec) {
    const id = exec.agent?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}
/**
 * Call-time enforcement. Model A authorizes the parent tool; the operation
 * id is still checked against allowedOperations first so an operation-level
 * roles override (model B) can land without changing this class.
 *
 * Scope: this gate governs the MMW Tools contract only. It is installed as a
 * global `tools/pre-execute` listener, so it also observes the host's own
 * standard tools. Those are outside the contract and must never be denied
 * here — that would make the plugin disable the whole session.
 */
export class PolicyGate {
    auth;
    enabled;
    wide;
    repos;
    constructor(opts) {
        this.auth = opts.auth;
        this.enabled = opts.enabled;
        this.wide = opts.sessionWide === true;
        this.repos = opts.repos;
    }
    get isEnabled() {
        return this.enabled;
    }
    /** True when the gate is an exclusive allowlist for the whole session. */
    get sessionWide() {
        return this.wide;
    }
    async check(publicName, sessionId) {
        const ref = TOOL_MAP[publicName];
        if (!ref) {
            // Not in the contract. If it is not even ours, it belongs to the host
            // or to another plugin — the MMW Tools contract has no authority over
            // it, so let it through.
            if (!this.wide && !isMmwTool(publicName))
                return { ok: true };
            return this.enabled
                ? deny("mmw_contract_mismatch", `工具 ${publicName} 不在 MMW Tools 契约中，已拒绝`)
                : { ok: true };
        }
        if (!this.enabled || ref.always)
            return { ok: true };
        // `select_repo` is local session state, not a repository operation: it
        // must be callable before a repository is bound and even when the auth
        // service's operation table has not learned about it yet (the table is
        // generated from a deployed contract, which can lag the plugin). Every
        // real business operation below still needs an entry in allowedOperations.
        if (ref.operationId === "race-ops.select_repo") {
            return this.repoDecision(ref, sessionId);
        }
        const repoKey = sessionId && this.repos ? this.repos.selectedBy(sessionId) : undefined;
        if (this.repos && !repoKey) {
            return deny("mmw_route_denied", '本会话尚未选择仓库；请先调用 mcp__mmw-tools__select_repo，参数 repo 为 "owner/name"');
        }
        let routes;
        try {
            // Write operations must not ride on a cached table older than 15s:
            // a revoked role should lose write access quickly, while a read may
            // use the normal 60s cache.
            routes = await this.auth.routes(false, ref.risk === "write" ? 15_000 : undefined, repoKey);
        }
        catch (err) {
            if (err instanceof FeishuAuthError) {
                return deny(authErrorCode(err), `飞书授权不可用：${err.message}`);
            }
            return deny("mmw_policy_unavailable", "飞书授权不可用，已拒绝调用");
        }
        if (repoKey && routes.repo && routes.repo.toLowerCase() !== repoKey.toLowerCase()) {
            return deny("mmw_contract_mismatch", `授权表仓库 ${routes.repo} 与会话仓库 ${repoKey} 不一致，已拒绝`);
        }
        if (routes.allowedOperations.includes(ref.operationId)) {
            return this.repoDecision(ref, sessionId);
        }
        // Contract v1 had no operation-level table; keep the old tool-level
        // fallback for it. From v2 on, allowedOperations is authoritative, so a
        // future operation-level denial cannot be bypassed by the parent tool.
        if (routes.contractVersion < 2 && routes.allowed.includes(ref.toolId)) {
            return this.repoDecision(ref, sessionId);
        }
        const required = routes.denied.find((entry) => entry.toolId === ref.toolId)?.requiredRoles ?? [];
        return deny("mmw_route_denied", `当前账号的角色不能消费 ${ref.toolId}` +
            (required.length > 0 ? `；需要 ${required.join(" / ")} 角色` : ""));
    }
    /**
     * The operation-level check passed; now enforce the session's repository.
     *
     * `select_repo` itself must be callable before a repository exists. Every
     * other business tool needs one: an unselected session is refused instead
     * of silently falling back to the default repository.
     */
    repoDecision(ref, sessionId) {
        if (!this.enabled || !this.repos)
            return { ok: true };
        if (ref.operationId === "race-ops.select_repo")
            return { ok: true };
        if (!sessionId) {
            return deny("mmw_route_denied", "无法识别当前会话，不能确定要操作哪个仓库");
        }
        const key = this.repos.selectedBy(sessionId);
        if (!key) {
            return deny("mmw_route_denied", '本会话尚未选择仓库；请先调用 mcp__mmw-tools__select_repo，参数 repo 为 "owner/name"');
        }
        return { ok: true };
    }
    operation(publicName) {
        return TOOL_MAP[publicName];
    }
}
/**
 * One `tools/pre-execute` listener for both gates:
 *   1. Feishu policy (deny) when enabled;
 *   2. the existing human confirmation for pr_merge (ask).
 *
 * Keeping them in one waterfall listener is deliberate: two listeners would
 * make the order between "ask" and "deny" accidental.
 *
 * The listener sees EVERY tool call in the session. Tools outside the MMW
 * Tools namespace are returned to the host untouched — this plugin has no
 * authority over them.
 */
export function installToolGate(ctx, opts) {
    const on = ctx.on;
    if (typeof on !== "function") {
        opts.logger.warn("mmw-tools: tools/pre-execute unavailable; Feishu gate and pr_merge confirmation are NOT installed");
        return () => { };
    }
    try {
        const disposer = on.call(ctx, "tools/pre-execute", async (exec, next) => {
            const name = typeof exec?.name === "string" ? exec.name : "";
            if (name.length > 0 && (opts.gate.sessionWide || isMmwTool(name))) {
                // One run id per call. The rest of the call — including `next()` and
                // the MCP bridge inside it — sees the same id via AsyncLocalStorage.
                const runId = newRunId();
                return runWithRunId(runId, async () => {
                    const decision = await opts.gate.check(name, sessionIdOf(exec));
                    if (!decision.ok) {
                        opts.onEvent?.({
                            kind: "gate_decision",
                            runId,
                            tool: name,
                            decision: "deny",
                            reason: decision.reason,
                        });
                        return { kind: "deny", reason: decision.reason };
                    }
                    if (name.endsWith("pr_merge")) {
                        opts.onEvent?.({ kind: "gate_decision", runId, tool: name, decision: "ask" });
                        return {
                            kind: "ask",
                            reason: "即将合并一个 PR（会写入主分支）。是否确认？这一步必须由你本人同意，agent 不能自行决定。",
                        };
                    }
                    if (name.endsWith("pr_close")) {
                        opts.onEvent?.({ kind: "gate_decision", runId, tool: name, decision: "ask" });
                        return {
                            kind: "ask",
                            reason: "即将关闭一个 PR（不会合并）。是否确认？这一步必须由你本人同意，agent 不能自行决定。",
                        };
                    }
                    opts.onEvent?.({ kind: "gate_decision", runId, tool: name, decision: "allow" });
                    return next();
                }, name);
            }
            return next();
        });
        return typeof disposer === "function" ? disposer : () => { };
    }
    catch (err) {
        opts.logger.warn(`mmw-tools: tool gate not installed: ${err instanceof Error ? err.message : String(err)}`);
        return () => { };
    }
}
