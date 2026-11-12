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
    constructor(opts) {
        this.auth = opts.auth;
        this.enabled = opts.enabled;
        this.wide = opts.sessionWide === true;
    }
    get isEnabled() {
        return this.enabled;
    }
    /** True when the gate is an exclusive allowlist for the whole session. */
    get sessionWide() {
        return this.wide;
    }
    async check(publicName) {
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
        let routes;
        try {
            // Write operations must not ride on a cached table older than 15s:
            // a revoked role should lose write access quickly, while a read may
            // use the normal 60s cache.
            routes = await this.auth.routes(false, ref.risk === "write" ? 15_000 : undefined);
        }
        catch (err) {
            if (err instanceof FeishuAuthError) {
                return deny(authErrorCode(err), `飞书授权不可用：${err.message}`);
            }
            return deny("mmw_policy_unavailable", "飞书授权不可用，已拒绝调用");
        }
        if (routes.allowedOperations.includes(ref.operationId))
            return { ok: true };
        // Contract v1 had no operation-level table; keep the old tool-level
        // fallback for it. From v2 on, allowedOperations is authoritative, so a
        // future operation-level denial cannot be bypassed by the parent tool.
        if (routes.contractVersion < 2 && routes.allowed.includes(ref.toolId))
            return { ok: true };
        const required = routes.denied.find((entry) => entry.toolId === ref.toolId)?.requiredRoles ?? [];
        return deny("mmw_route_denied", `当前账号的角色不能消费 ${ref.toolId}` +
            (required.length > 0 ? `；需要 ${required.join(" / ")} 角色` : ""));
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
                    const decision = await opts.gate.check(name);
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
