/**
 * dsh-github-engineer — bundle entry.
 *
 * Layered architecture:
 *   src/const.ts          → identifier constants (PLUGIN_ID etc.)
 *   src/agents-md-check.ts → AGENTS.md drift fingerprint
 *   src/auth/token-store.ts → ~/.dsh/dsh-github-engineer.json (mode 0600)
 *   src/auth/device-flow.ts → Device Flow state machine + GitHub HTTP
 *   src/routes.ts          → loopback HTTP routes
 *   src/index.ts (this)   → cordis apply(): glues everything together
 *
 * Visible agent-facing surfaces:
 *   1. engineer_status                       — high-level state report
 *   2. (removed) the four engineer_oauth_* tools — sign-in is a human
 *      action performed in the panel, never by the agent
 *                                          — drive OAuth lifecycle
 *   3. mcp__github-engineer__*                — auto-discovered MCP tools
 *
 * Runtime guards:
 *   - AGENTS.md drift detection on bundle apply
 *   - Watchdog timer that calls flow.ensureFresh() before access_token
 *     expires (every 60s check; refresh when within 5 min of expiry)
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, ListToolsResultSchema, } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { PLUGIN_ID, PLUGIN_DISPLAY_NAME, PLUGIN_NAMESPACE, CORDIS_INJECT, SYSTEM_PROMPT_SECTION_ORDER, mcpServerEntryPath, } from "./const.js";
import { checkAgentsMd, fetchAgentsMd } from "./agents-md-check.js";
import { BrokerAuth, installationTokenPath } from "./auth/broker-auth.js";
import { makeRoutes, API } from "./routes.js";
import { createAuditLogger, createRedactingLogger, auditPath, MAX_BYTES as MAX_AUDIT_BYTES } from "./util/audit.js";
/** Where MCP server lives — exposed for tests / docs. */
export const pathToConnect = mcpServerEntryPath(import.meta.url);
/** Sanitize a raw MCP tool name into a model-facing DSH agent name. */
/**
 * Convert an MCP tool's JSON Schema into DSH's flat ParameterSchemaSpec.
 *
 * DSH wants one entry per parameter with `required: true` inline, not a
 * JSON-Schema object root. Types are narrowed to the four it accepts;
 * `integer` becomes `number` and anything exotic becomes `object`, which
 * still lets the caller pass a structured value.
 */
function mcpParameters(inputSchema) {
    const schema = (inputSchema ?? {});
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const out = {};
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        const rawType = typeof prop?.type === "string" ? prop.type : "object";
        const type = rawType === "integer"
            ? "number"
            : ["string", "number", "boolean", "array", "object"].includes(rawType)
                ? rawType
                : "object";
        out[key] = {
            type,
            ...(typeof prop?.description === "string" && prop.description.length > 0
                ? { description: prop.description.slice(0, 300) }
                : {}),
            ...(required.has(key) ? { required: true } : {}),
        };
    }
    // A tool with no declared properties still needs a valid (empty) spec.
    return out;
}
/**
 * Expose the plugin's own skills through DSH's skill registry.
 *
 * `dsh-skill-filesystem` reads project/custom/user roots, none of which is
 * inside an installed plugin, so a plugin that ships a skill has to publish
 * it itself. The registry takes a provider with an async `list()`, and each
 * runtime skill needs only name / description / content - `invocation` and
 * `provider` default when omitted.
 *
 * Failures here are swallowed on purpose: a broken skill must never stop the
 * repository tools from working.
 */
export function registerSkills(ctx, logger) {
    const getSkills = serviceGetter(ctx, "skills");
    const skills = safeAccess(getSkills);
    if (!skills || typeof skills.registerProvider !== "function") {
        logger.warn("github-engineer: skills registry unavailable; skill not published");
        return [];
    }
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
    let entries = [];
    try {
        entries = readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
    }
    catch {
        return [];
    }
    const loaded = entries
        .map((name) => {
        try {
            const raw = readFileSync(path.join(dir, name, "SKILL.md"), "utf8");
            const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
            if (!match)
                return undefined;
            const description = /^description:\s*(.+)$/m.exec(match[1])?.[1]?.trim();
            const declared = /^name:\s*(.+)$/m.exec(match[1])?.[1]?.trim();
            if (!description)
                return undefined;
            return {
                name: declared ?? name,
                description,
                content: match[2].trim(),
            };
        }
        catch {
            return undefined;
        }
    })
        .filter((s) => s !== undefined);
    if (loaded.length === 0)
        return [];
    const providerName = "github-engineer";
    // The registry validates two different shapes: `list()` returns candidates
    // (name, description, source, rank, provider), and `get(candidate)` returns
    // the definition that carries the body. Both need `source` as a string and
    // `provider` equal to this provider's name.
    const definitions = loaded.map((entry) => ({
        name: entry.name,
        description: entry.description,
        source: "plugin",
        provider: providerName,
        content: entry.content,
    }));
    const candidates = definitions.map((definition, index) => ({
        name: definition.name,
        description: definition.description,
        source: definition.source,
        provider: providerName,
        rank: 100 + index,
        locator: definition,
    }));
    try {
        const dispose = skills.registerProvider(() => ({
            name: providerName,
            async list() {
                return candidates;
            },
            async get(candidate) {
                return candidate.locator ?? null;
            },
        }));
        logger.warn(`github-engineer: published ${definitions.length} skill(s): ${definitions
            .map((d) => d.name)
            .join(", ")}`);
        return typeof dispose === "function" ? [dispose] : [];
    }
    catch (err) {
        logger.warn(`github-engineer: skill publishing failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}
function publicToolName(rawName) {
    const sanitized = rawName.replace(/[^A-Za-z0-9_-]/g, "_");
    return PLUGIN_NAMESPACE + sanitized;
}
/** Extract text from an MCP `ContentBlock[]` for display. */
function extractText(mcpContent, toolName) {
    if (!Array.isArray(mcpContent))
        return `(${toolName} returned no content)`;
    const parts = [];
    for (const block of mcpContent) {
        if (typeof block !== "object" || block === null)
            continue;
        const b = block;
        if (b.type === "text" && typeof b.text === "string")
            parts.push(b.text);
    }
    return parts.join("\n") || `(${toolName} returned no text content)`;
}
/** Skeleton env: extended PATH so the child can find `node`. */
function extendedEnv() {
    const segments = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const seen = new Set(segments);
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    for (const d of [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/usr/bin",
        "/bin",
        path.join(home, ".local", "bin"),
    ]) {
        if (seen.has(d) || !existsSync(d))
            continue;
        seen.add(d);
        segments.push(d);
    }
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string")
            env[k] = v;
    }
    env.PATH = segments.join(path.delimiter);
    return env;
}
/**
 * Translate the plugin's `repoBinding` into the environment the MCP
 * child reads.
 *
 * Without this the child saw only the inherited environment, so
 * `GHOST_WORKING_DIR` and `GHOST_REPO_OWNER` were empty and every tool
 * failed on first real use. The token is passed as a *path*
 * (`GHOST_TOKEN_FILE`) rather than a value: access tokens expire in 8
 * hours while the child lives as long as DSH does, and the child reads
 * the store per call, so a host-side refresh is picked up without a
 * restart.
 */
// Exported for tests: this is the seam that was broken (the child received
// no binding at all), so it is asserted directly rather than only through a
// real spawn, which not every sandbox permits.
export function mcpBindingEnv(binding, workingDir) {
    const env = {
        GHOST_WORKING_DIR: workingDir,
        GHOST_REPO_URL: `https://github.com/${binding.owner}/${binding.name}.git`,
        GHOST_REPO_OWNER: binding.owner,
        GHOST_REPO_NAME: binding.name,
        GHOST_BASE_BRANCH: binding.baseBranch,
        GHOST_BRANCH_PREFIX: binding.branchPrefix,
        GHOST_ALLOWLIST: binding.allowlistPaths.join(","),
        GHOST_DENYLIST: binding.denylistPaths.join(","),
        GHOST_PREFLIGHT_CMD: binding.preflight.cmd,
        GHOST_PREFLIGHT_TIMEOUT: String(binding.preflight.timeoutSeconds),
        GHOST_TOKEN_FILE: installationTokenPath(),
    };
    if (binding.bootstrap.cmd.length > 0) {
        env.GHOST_BOOTSTRAP_CMD = binding.bootstrap.cmd;
        env.GHOST_BOOTSTRAP_WHEN_MISSING = binding.bootstrap.whenMissing;
        env.GHOST_BOOTSTRAP_TIMEOUT = String(binding.bootstrap.timeoutSeconds);
    }
    return env;
}
const DEFAULT_DENYLIST = [
    ".github/workflows/**",
    "schema/**",
    "scripts/**",
    "constants.js",
    "AGENTS.md",
    "README.md",
    ".pi/**",
    "dist/**",
];
export function normalizeBinding(raw) {
    const str = (v, fallback) => typeof v === "string" && v.length > 0 ? v : fallback;
    const list = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    const preflightRaw = (raw.preflight ?? {});
    const bootRaw = (raw.bootstrap ?? {});
    return {
        owner: str(raw.owner, ""),
        name: str(raw.name, ""),
        baseBranch: str(raw.baseBranch, "main"),
        branchPrefix: str(raw.branchPrefix, "content/"),
        allowlistPaths: list(raw.allowlistPaths),
        denylistPaths: list(raw.denylistPaths).length > 0 ? list(raw.denylistPaths) : DEFAULT_DENYLIST,
        preflight: {
            cmd: str(preflightRaw.cmd, "npm run validate"),
            timeoutSeconds: typeof preflightRaw.timeoutSeconds === "number" ? preflightRaw.timeoutSeconds : 60,
        },
        bootstrap: {
            cmd: str(bootRaw.cmd, ""),
            whenMissing: str(bootRaw.whenMissing, "node_modules"),
            timeoutSeconds: typeof bootRaw.timeoutSeconds === "number" ? bootRaw.timeoutSeconds : 300,
        },
    };
}
/* ============================================================== */
/*  Agent tools                                                    */
/* ============================================================== */
const STATUS_PARAMS = {};
const STATUS_OUTPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean", required: true },
        message: { type: "string", required: true },
        pluginId: { type: "string" },
        oauthClientIdMasked: { type: "string" },
        repoOwner: { type: "string" },
        repoName: { type: "string" },
        baseBranch: { type: "string" },
        defaultScopes: {
            type: "array",
            items: { type: "string" },
        },
        mcpServerPath: { type: "string" },
        auth: {
            type: "object",
            additionalProperties: false,
            properties: {
                status: { type: "string", required: true },
                configured: { type: "boolean", required: true },
                login: { type: "string" },
                scope: { type: "string" },
                accessTokenMasked: { type: "string" },
                accessTokenExpiresAt: { type: "number" },
                refreshTokenExpiresAt: { type: "number" },
                tokenUpdatedAt: { type: "string" },
            },
            required: true,
        },
        agentsMdDrift: {
            type: "object",
            additionalProperties: false,
            properties: {
                ok: { type: "boolean", required: true },
                unavailable: { type: "boolean", required: true },
                summary: { type: "string", required: true },
                details: {
                    type: "array",
                    items: {
                        type: "object",
                        additionalProperties: true,
                        properties: {
                            label: { type: "string" },
                            passed: { type: "boolean" },
                            observed: { type: "string" },
                        },
                    },
                    required: true,
                },
            },
            required: true,
        },
    },
};
function formatExpiry(timestampMs) {
    if (timestampMs <= 0)
        return "永不过期";
    const remaining = Math.max(0, timestampMs - Date.now());
    const minutes = Math.floor(remaining / 60000);
    if (minutes < 60)
        return `约 ${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    return `约 ${hours} 小时 ${minutes - hours * 60} 分钟`;
}
function makeStatusTool(deps) {
    return defineTool({
        name: "engineer_status",
        description: "查看 dsh-github-engineer 插件状态：OAuth 配置、token 状态、repo binding、AGENTS.md 漂移检查、当前授权阶段。不会泄露任何密钥。",
        parameters: STATUS_PARAMS,
        output: {
            schema: STATUS_OUTPUT_SCHEMA,
            render(_args, value) {
                return [{ type: "text", text: String(value.message ?? "") }];
            },
        },
        async execute() {
            const brokerLine = deps.brokerUrl;
            const view = await deps.store.view();
            const status = await deps.flow.resolvedStatus();
            const driftLine = deps.agentsMdDrift
                ? deps.agentsMdDrift.unavailable
                    ? "AGENTS.md drift: 暂无法拉取（OAuth 未完成或仓库不可匿名访问）"
                    : deps.agentsMdDrift.ok
                        ? "AGENTS.md drift: OK"
                        : "AGENTS.md drift: ⚠️ 不一致 — 详情见 dsh web 日志"
                : "AGENTS.md drift: 未检查";
            const authLines = [`Auth 状态: ${status}`];
            if (status === "authorized") {
                authLines.push(`登录身份: ${view.login || "(unknown)"}`);
                authLines.push(`会话剩余: ${formatExpiry(view.accessTokenExpiresAt)}`);
                authLines.push("仓库写入使用 broker 签发的 1 小时 App 令牌");
            }
            else if (status === "reauth_needed") {
                authLines.push("⚠️ 会话已过期 — 请在面板里点「登录 GitHub」重新登录");
            }
            else if (status === "device_pending") {
                authLines.push("等待浏览器完成授权 — 面板会自动继续，无需操作");
            }
            else {
                authLines.push("未登录 — 请在面板里点「登录 GitHub」");
            }
            return {
                ok: true,
                message: `${PLUGIN_DISPLAY_NAME} 已挂载（plugin_id=${PLUGIN_ID}）。\n` +
                    `Broker: ${brokerLine}\n` +
                    `Repo binding: ${String(deps.repo.owner ?? "?")}/${String(deps.repo.name ?? "?")} (${String(deps.repo.baseBranch ?? "main")})\n` +
                    `Allowed paths: ${Array.isArray(deps.repo.allowlistPaths) ? deps.repo.allowlistPaths.join(", ") : "(空)"}\n` +
                    `Default scopes: ${deps.scopes.join(" ") || "(空)"}\n` +
                    `MCP server entry: ${pathToConnect}\n` +
                    `\n--- Auth ---\n${authLines.join("\n")}\n` +
                    `\n--- AGENTS.md ---\n${driftLine}\n` +
                    `\n下一步：请用户在面板里完成 GitHub 登录（agent 不参与登录）。`,
                pluginId: PLUGIN_ID,
                oauthClientIdMasked: "",
                repoOwner: String(deps.repo.owner ?? ""),
                repoName: String(deps.repo.name ?? ""),
                baseBranch: String(deps.repo.baseBranch ?? "main"),
                defaultScopes: deps.scopes,
                mcpServerPath: pathToConnect,
                auth: {
                    status,
                    configured: view.configured,
                    login: view.login,
                    scope: view.scope,
                    accessTokenMasked: view.accessTokenMasked,
                    accessTokenExpiresAt: view.accessTokenExpiresAt,
                    refreshTokenExpiresAt: view.refreshTokenExpiresAt,
                    tokenUpdatedAt: view.tokenUpdatedAt,
                },
                agentsMdDrift: deps.agentsMdDrift ?? {
                    ok: false,
                    unavailable: true,
                    summary: "未检查",
                    details: [],
                },
            };
        },
    });
}
/* engineer_run — v0.5.0 lightweight bootstrap wrapper. */
const ENGINEER_RUN_OUTPUT = {
    type: "object",
    additionalProperties: false,
    properties: {
        branch_suggestion: { type: "string", required: true },
        working_dir: { type: "string", required: true },
        repo: {
            type: "object",
            additionalProperties: false,
            properties: {
                owner: { type: "string", required: true },
                name: { type: "string", required: true },
                base_branch: { type: "string", required: true },
            },
            required: true,
        },
        agents_md_excerpt: { type: "string", required: true },
        readme_excerpt: { type: "string", required: true },
        agents_md_present: { type: "boolean", required: true },
        readme_present: { type: "boolean", required: true },
        allowlist: {
            type: "array",
            items: { type: "string" },
            required: true,
        },
        denylist: {
            type: "array",
            items: { type: "string" },
            required: true,
        },
        branch_prefix: { type: "string", required: true },
        preflight_cmd: { type: "string", required: true },
        tool_inventory: {
            type: "array",
            items: { type: "string" },
            required: true,
        },
        instructions: { type: "string", required: true },
    },
};
function makeEngineerRunTool(deps) {
    return defineTool({
        name: "engineer_run",
        description: "为 DSH agent 准备好 GitHub 仓库工程任务的工作环境：读 AGENTS.md 和 README.md、检查绑定仓库元信息、拼出 agent 必须遵守的硬约束（allowlist、denylist、分支前缀、preflight），并返回一份完整的工作指南。Agent 在收到结果后自行驱动 mcp__github-engineer__* 工具完成实际修改。本工具不做任何 LLM 调用、不自动 push、不自动合并。",
        parameters: {
            user_request: {
                type: "string",
                description: "用户的自然语言诉求。1–8 KiB；不接受含 token 形字符串。",
            },
            branch_name: {
                type: "string",
                description: "可选分支名（默认 content/<date>-<slug>）。",
            },
            draft: {
                type: "boolean",
                description: "建议的 draft PR 标志（仅作为建议，最终由 agent 决定）。",
            },
        },
        output: {
            schema: ENGINEER_RUN_OUTPUT,
            render(_args, value) {
                const v = value;
                const lines = [
                    String(v.instructions ?? ""),
                    "",
                    "--- AGENTS.md excerpt ---",
                    String(v.agents_md_excerpt ?? ""),
                    "--- README.md excerpt ---",
                    String(v.readme_excerpt ?? ""),
                ];
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        async execute(args) {
            const input = (args ?? {});
            const userRequest = String(input.user_request ?? "");
            const branch = input.branch_name ?? "";
            // Audit: record the START before any work happens. We deliberately
            // log only the byte length of user_request — its full text is
            // potentially sensitive and we already redact it in the executor.
            void deps.audit.record({
                kind: "engineer_run_start",
                repo: `${String(deps.repo.owner ?? "")}/${String(deps.repo.name ?? "")}`,
                branch_name: branch,
                user_request_bytes: userRequest.length,
                draft: input.draft ?? false,
            });
            try {
                // Lazy import to keep the bundle entry's import graph small.
                const mod = await import("./agent/engineer-run.js");
                const result = await mod.engineerRun({
                    user_request: userRequest,
                    branch_name: branch || undefined,
                    draft: input.draft,
                }, {
                    workingDir: deps.workingDir,
                    repo: {
                        owner: String(deps.repo.owner ?? ""),
                        name: String(deps.repo.name ?? ""),
                        baseBranch: String(deps.repo.baseBranch ?? "main"),
                    },
                    allowlistPaths: deps.allowlistPaths,
                    denylistPaths: deps.denylistPaths,
                    branchPrefix: deps.branchPrefix,
                    preflightCmd: deps.preflightCmd,
                });
                void deps.audit.record({
                    kind: "engineer_run_created",
                    branch_suggestion: result.branch_suggestion,
                    agents_md_present: result.agents_md_present,
                    readme_present: result.readme_present,
                });
                return result;
            }
            catch (err) {
                // Surface the error code (e.g. "user-request-contains-token",
                // "user-request-too-long") so the agent can act on it. The
                // raw message is already token-redacted by validateInput +
                // assertNoTokens upstream, but we re-redact for safety.
                const code = err instanceof Error && "code" in err
                    ? String(err.code)
                    : "unknown";
                void deps.audit.record({
                    kind: "refused",
                    tool: "engineer_run",
                    code,
                });
                throw err;
            }
        },
    });
}
/* OAuth agent tools — minimal parameter + output specs. */
const OAUTH_START_OUTPUT = {
    type: "object",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean", required: true },
        message: { type: "string", required: true },
        userCode: { type: "string" },
        verificationUri: { type: "string" },
        expiresAt: { type: "number" },
        interval: { type: "number" },
    },
};
const OAUTH_SIMPLE_OUTPUT = {
    type: "object",
    additionalProperties: false,
    properties: {
        ok: { type: "boolean", required: true },
        message: { type: "string", required: true },
    },
};
/**
 * Read a service from the host context without assuming it exists.
 *
 * Cordis resolves `ctx.<service>` through a getter that may throw when
 * the service is declared but not ready. Since none of these services is
 * declared (see CORDIS_INJECT), a missing one should read as undefined
 * rather than take the whole plugin down at activation.
 */
function safeAccess(get) {
    try {
        return get();
    }
    catch {
        return undefined;
    }
}
/**
 * Run `register` once `<service>` becomes available, without making the
 * plugin's activation depend on it.
 *
 * Declaring these services in `inject` would make the whole entry wait —
 * and wait forever if a profile never provides them, which is how this
 * plugin previously ended up `pending` and completely inert. Not
 * declaring them means we activate early, before `webServer` exists, so
 * registration has to be retried. Bounded, so a missing service produces
 * one warning instead of a spinning timer.
 */
/**
 * Read a service by name.
 *
 * `ctx.get(name)` is the canonical accessor for a service the plugin did
 * not declare in `inject`. Property access (`ctx.webServer`) only works
 * for declared ones on some cordis versions, which silently returned
 * undefined here — the plugin activated, then registered nothing.
 * The property form is kept as a fallback so the test stubs, which have
 * no `get`, keep working.
 */
function serviceGetter(ctx, name) {
    return () => {
        const c = ctx;
        if (typeof c.get === "function") {
            try {
                return c.get(name);
            }
            catch {
                /* fall through to property access */
            }
        }
        return c[name];
    };
}
function whenService(get, register, onTimeout, timeoutMs = 15_000, intervalMs = 100) {
    let disposed = false;
    let timer;
    let disposer;
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
        if (disposed)
            return;
        if (safeAccess(get) !== undefined) {
            disposer = register();
            return;
        }
        if (Date.now() >= deadline) {
            onTimeout();
            return;
        }
        timer = setTimeout(attempt, intervalMs);
        timer.unref?.();
    };
    attempt();
    return () => {
        disposed = true;
        if (timer)
            clearTimeout(timer);
        disposer?.();
    };
}
export function apply(ctx, config) {
    // Environment wins over the profile file: the file ships with the
    // production URL, and an operator needs a way to point one machine
    // somewhere else (a tunnel, a staging broker) without editing a file
    // that is part of the package.
    const brokerUrl = process.env.GHOST_BROKER_URL ?? config?.brokerUrl ?? "https://race-ops-broker.mmw-team.icu";
    const repo = config?.repoBinding ?? {};
    const binding = normalizeBinding(repo);
    // `logger` is optional in CORDIS_INJECT: a profile that does not
    // provide it must not leave this entry pending forever. Fall back to
    // the process streams, which DSH already captures.
    const consoleLogger = {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
    };
    const logger = safeAccess(() => ctx.logger) ?? consoleLogger;
    const scopes = [];
    const workingDir = config?.workingDir && config.workingDir.length > 0
        ? config.workingDir
        : process.env.GHOST_WORKING_DIR ?? "";
    // Construct audit + redacting loggers once, share across tools.
    const audit = createAuditLogger({
        file: auditPath(),
        maxBytes: MAX_AUDIT_BYTES,
        warn: (m) => logger.warn(m),
    });
    const log = createRedactingLogger(logger);
    // Construct auth services.
    // One implementation: BrokerAuth replaces both the token store and the
    // Device Flow state machine. It is handed to the routes twice because
    // that surface still names the two halves `store` and `flow`.
    const auth = new BrokerAuth({
        brokerUrl,
        installationTokenFile: installationTokenPath(),
    });
    const store = auth;
    const flow = auth;
    // Hydrate lastStatus before exposing it.
    ctx.effect(() => {
        void flow.hydrate();
        return () => { };
    }, "github-engineer: hydrate auth");
    // AGENTS.md drift detection — fires once on apply.
    let agentsMdDrift = null;
    ctx.effect(() => {
        const bindingLike = {
            owner: String(repo.owner ?? ""),
            name: String(repo.name ?? ""),
            branchPrefix: String(repo.branchPrefix ?? ""),
            allowlistPaths: Array.isArray(repo.allowlistPaths)
                ? repo.allowlistPaths
                : [],
            preflight: repo.preflight,
        };
        void (async () => {
            try {
                const agentsMd = await fetchAgentsMd(bindingLike.owner, bindingLike.name, String(repo.baseBranch ?? "main"), null);
                if (agentsMd === null) {
                    agentsMdDrift = {
                        ok: false,
                        unavailable: true,
                        details: [],
                        summary: `无法拉取 AGENTS.md：${bindingLike.owner}/${bindingLike.name}@${String(repo.baseBranch ?? "main")}`,
                    };
                    logger.warn(`github-engineer: ${agentsMdDrift.summary}`);
                }
                else {
                    const check = checkAgentsMd(bindingLike, agentsMd);
                    agentsMdDrift = check;
                    if (check.ok)
                        logger.info(`github-engineer: ${check.summary}`);
                    else
                        logger.warn(`github-engineer: ${check.summary}`);
                }
            }
            catch (err) {
                logger.error(`github-engineer: AGENTS.md drift check threw: ${err instanceof Error ? err.message : String(err)}`);
            }
        })();
        return () => { };
    }, "github-engineer: agents-md drift");
    // 1. Register the status tool.
    ctx.effect(() => {
        return ctx.tools.register(makeStatusTool({ brokerUrl, repo, scopes, agentsMdDrift, store, flow }));
    }, "github-engineer: status tool");
    // 2. Register the OAuth tools.
    // 2.5. Register engineer_run (v0.5.0 bootstrap).
    ctx.effect(() => {
        const allowlist = Array.isArray(repo.allowlistPaths)
            ? repo.allowlistPaths
            : [];
        const denylist = Array.isArray(repo.denylistPaths)
            ? repo.denylistPaths
            : [];
        return ctx.tools.register(makeEngineerRunTool({
            workingDir,
            repo,
            allowlistPaths: allowlist,
            denylistPaths: denylist,
            branchPrefix: String(repo.branchPrefix ?? "content/"),
            preflightCmd: String(repo.preflight?.cmd ?? "npm run validate"),
            audit,
            log,
        }));
    }, "github-engineer: engineer_run tool");
    // 3. Register loopback HTTP routes.
    ctx.effect(() => {
        let disposers = [];
        const dispose = whenService(serviceGetter(ctx, "webServer"), () => {
            const ws = safeAccess(serviceGetter(ctx, "webServer"));
            disposers.push(...registerSkills(ctx, logger));
            disposers = makeRoutes({
                store,
                flow,
                brokerUrl,
                binding: {
                    owner: binding.owner,
                    name: binding.name,
                    baseBranch: binding.baseBranch,
                    allowlistPaths: binding.allowlistPaths,
                },
            }).map((r) => ws.register(r));
            return () => disposers.forEach((d) => d());
        }, () => logger.warn("github-engineer: `webServer` never became available; the Settings panel routes were not registered"));
        return () => {
            dispose();
            disposers.forEach((d) => d());
        };
    }, "github-engineer: routes");
    // 4. Announce to the agent via a system prompt section.
    ctx.effect(() => {
        const paths = Object.values(API).join(", ");
        return whenService(serviceGetter(ctx, "systemPrompt"), () => safeAccess(serviceGetter(ctx, "systemPrompt")).section({
            name: `plugin:${PLUGIN_ID}`,
            order: SYSTEM_PROMPT_SECTION_ORDER,
            text: `本机已安装 ${PLUGIN_DISPLAY_NAME} 插件（GitHub 仓库工程脚手架，plugin_id=${PLUGIN_ID}）。` +
                "Agent tools: engineer_status（查看状态）、engineer_run（读取上下文）。" +
                "GitHub 登录是用户动作，在 Settings 面板完成；agent 不参与登录流程。" +
                `Loopback HTTP routes: ${paths}。`,
        }), () => logger.warn("github-engineer: `systemPrompt` never became available; the agent announcement was not registered"));
    }, "github-engineer: section");
    // 5. Refresh watchdog — every 60s, refresh access_token if it's
    //    expiring within 5 minutes.
    ctx.effect(() => {
        const handle = setInterval(() => {
            void (async () => {
                try {
                    const refreshed = await flow.ensureFresh();
                    if (refreshed) {
                        logger.info(`github-engineer: access_token auto-refreshed`);
                    }
                }
                catch (err) {
                    logger.error(`github-engineer: refresh watchdog threw: ${err instanceof Error ? err.message : String(err)}`);
                }
            })();
        }, 60_000);
        handle.unref();
        return () => clearInterval(handle);
    }, "github-engineer: refresh watchdog");
    // 6. Spawn the MCP server and re-publish its tools.
    ctx.effect(() => {
        if (!existsSync(pathToConnect)) {
            logger.warn(`github-engineer: mcp-server entry not found at ${pathToConnect}; skipping MCP spawn. Run \`pnpm build\` inside mcp-server/.`);
            return () => { };
        }
        const client = new Client({ name: PLUGIN_DISPLAY_NAME, version: "0.1.0" }, { capabilities: {} });
        (async () => {
            try {
                const transport = new StdioClientTransport({
                    command: process.execPath,
                    args: [pathToConnect],
                    env: { ...extendedEnv(), ...mcpBindingEnv(binding, workingDir) },
                });
                await client.connect(transport);
                const { tools } = await client.request({ method: "tools/list" }, ListToolsResultSchema);
                logger.info(`github-engineer: MCP server connected, ${tools.length} tool(s) discovered`);
                const disposers = [];
                for (const tool of tools) {
                    const publicName = publicToolName(tool.name);
                    const dispose = ctx.tools.register(defineTool({
                        name: publicName,
                        description: tool.description ?? "",
                        // Real per-property specs, converted from the MCP tool's
                        // inputSchema. The previous `{ __mcp_raw: { type: "json" } }`
                        // was a placeholder with an invalid type, so the host built a
                        // validator from undefined and every call failed with
                        // "Cannot read properties of undefined (reading '_zod')".
                        parameters: mcpParameters(tool.inputSchema),
                        output: {
                            // An object spec, not `{ type: "json" }`.
                            //
                            // `json` is a legal authoring type but the host derives a
                            // validator from this to check the returned value, and for
                            // `json` that derivation yields undefined - every call died
                            // on `reading '_zod'` before the result could be rendered.
                            // The two tools that work (status, run) use object specs.
                            schema: { type: "object", properties: {}, additionalProperties: true },
                            render(_args, value) {
                                const v = (value ?? {});
                                return [{ type: "text", text: extractText(v.content, tool.name) }];
                            },
                        },
                        async execute(args, exec) {
                            const forwardArgs = (args ?? {});
                            const result = (await client.request({
                                method: "tools/call",
                                params: { name: tool.name, arguments: forwardArgs },
                            }, 
                            // The SDK requires a result schema and dereferences it
                            // (`schema._zod`) while validating the reply. Passing
                            // `undefined` here threw "Cannot read properties of
                            // undefined (reading '_zod')" on every call - the tool was
                            // registered fine, so only the invocation failed.
                            CallToolResultSchema, { signal: exec.signal, timeout: 30_000 }));
                            if (result.isError === true) {
                                throw new Error(extractText(result.content, tool.name));
                            }
                            return { content: Array.isArray(result.content) ? result.content : [] };
                        },
                    }));
                    disposers.push(dispose);
                }
                return () => {
                    for (const d of disposers)
                        d();
                    client.close().catch(() => { });
                };
            }
            catch (err) {
                logger.error(`github-engineer: failed to start MCP server: ${err instanceof Error ? err.message : String(err)}`);
                return () => { };
            }
        })();
        return () => { };
    }, "github-engineer: mcp bridge");
}
/** Helper used by tests / docs. */
export async function ensureWorkspace(_dir) {
    await mkdir(_dir, { recursive: true });
}
// Re-export the cordis service identifier so consumers can import it.
export const name = PLUGIN_ID;
export const inject = CORDIS_INJECT;
// Re-export auth internals for tests and the upcoming MCP bridge.
// (The MCP child process imports from this same bundle via the lib
//  entry — see NEXT-STEPS.md "Settings web panel".)
export { mcpServerEntryPath } from "./const.js";
export { BrokerAuth, installationTokenPath } from "./auth/broker-auth.js";
export { SessionStore } from "./auth/session-store.js";
export { makeRoutes, API } from "./routes.js";
