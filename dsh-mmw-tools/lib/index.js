/**
 * dsh-mmw-tools — bundle entry.
 *
 * Layered architecture:
 *   src/const.ts          → identifier constants (PLUGIN_ID etc.)
 *   src/agents-md-check.ts → AGENTS.md drift fingerprint
 *   src/auth/token-store.ts → ~/.dsh/dsh-mmw-tools.json (mode 0600)
 *   src/auth/device-flow.ts → Device Flow state machine + GitHub HTTP
 *   src/routes.ts          → loopback HTTP routes
 *   src/index.ts (this)   → cordis apply(): glues everything together
 *
 * Visible agent-facing surfaces:
 *   1. mmw_tools_status                       — high-level state report
 *   2. (removed) the four engineer_oauth_* tools — sign-in is a human
 *      action performed in the panel, never by the agent
 *                                          — drive OAuth lifecycle
 *   3. mcp__mmw-tools__*                — auto-discovered MCP tools
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
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { PLUGIN_ID, PLUGIN_DISPLAY_NAME, PLUGIN_NAMESPACE, CORDIS_INJECT, SYSTEM_PROMPT_SECTION_ORDER, mcpServerEntryPath, } from "./const.js";
import { checkAgentsMd, fetchAgentsMd } from "./agents-md-check.js";
import { BrokerAuth, installationTokenPath, writeAuthPath } from "./auth/broker-auth.js";
import { FeishuAuth } from "./auth/feishu-auth.js";
import { PolicyGate, installToolGate } from "./gate/gate.js";
import { RepoRegistry, repoKey } from "./gate/repo-registry.js";
import { readRepoRegistryCache, writeRepoRegistryCache, } from "./gate/repo-cache.js";
import { installWorkspaceGuard, readSessionWorkingDirectory, } from "./gate/workspace-guard.js";
import { resolveWorkspaceMode, } from "./gate/workspace-mode.js";
import { makeRoutes, API } from "./routes.js";
import { createAuditLogger, createRedactingLogger, auditPath, MAX_BYTES as MAX_AUDIT_BYTES } from "./util/audit.js";
import { currentRunId, newRunId } from "./util/run-context.js";
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
        logger.warn("mmw-tools: skills registry unavailable; skill not published");
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
    const providerName = "mmw-tools";
    // The registry validates two different shapes: `list()` returns candidates
    // (name, description, source, rank, provider), and `get(candidate)` returns
    // the definition that carries the body. Both need `source` as a string and
    // `provider` equal to this provider's name.
    // `invocation` must be resolved here. `isModelInvocable()` reads
    // `skill.invocation.modelInvocable` with no fallback, and only the bundled
    // runtime path fills the default in - a provider definition that omits it
    // crashes the session on load.
    const invocation = { modelInvocable: true, userInvocable: true };
    const definitions = loaded.map((entry) => ({
        name: entry.name,
        description: entry.description,
        source: "plugin",
        provider: providerName,
        invocation,
        content: entry.content,
    }));
    const candidates = definitions.map((definition, index) => ({
        name: definition.name,
        description: definition.description,
        source: definition.source,
        provider: providerName,
        rank: 100 + index,
        invocation,
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
        logger.warn(`mmw-tools: published ${definitions.length} skill(s): ${definitions
            .map((d) => d.name)
            .join(", ")}`);
        return typeof dispose === "function" ? [dispose] : [];
    }
    catch (err) {
        logger.warn(`mmw-tools: skill publishing failed: ${err instanceof Error ? err.message : String(err)}`);
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
export function mcpBindingEnv(binding, workingDir, brokerUrl = "", entries) {
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
        // The child reads this per call. It carries the identity credential for
        // broker-proxied writes, not a GitHub installation token.
        MMW_WRITE_AUTH_FILE: writeAuthPath(),
    };
    if (brokerUrl)
        env.MMW_BROKER_URL = brokerUrl;
    if (binding.bootstrap.cmd.length > 0) {
        env.GHOST_BOOTSTRAP_CMD = binding.bootstrap.cmd;
        env.GHOST_BOOTSTRAP_WHEN_MISSING = binding.bootstrap.whenMissing;
        env.GHOST_BOOTSTRAP_TIMEOUT = String(binding.bootstrap.timeoutSeconds);
    }
    // The MCP child has no session state; it resolves the repository the gate
    // already picked from this table, keyed by `owner/name`.
    if (entries && entries.length > 0) {
        env.MMW_REPOS = JSON.stringify(entries.map((entry) => ({
            key: entry.key,
            owner: entry.owner,
            name: entry.name,
            repoUrl: entry.repoUrl,
            workingDir: entry.workingDir,
            tokenFile: entry.tokenFile,
            baseBranch: entry.baseBranch,
            branchPrefix: entry.branchPrefix,
            allowlist: entry.allowlistPaths,
            denylist: entry.denylistPaths,
            preflight: entry.preflight,
            bootstrap: entry.bootstrap,
        })));
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
/**
 * Where `repo_clone` puts the checkout.
 *
 * Explicit config wins, then the deployment override (`GHOST_WORKING_DIR`),
 * then a per-user default under `~/.dsh/workspaces/<owner>/<name>`.
 *
 * The default is what makes the package portable: the previous shipped
 * `cordis.patch.yml` pinned this to one developer's Windows path, so anyone
 * else installing the plugin would have written into a directory that does
 * not exist on their machine. It is derived from the binding rather than
 * hard-coded so the same build works for every checkout.
 */
export function resolveWorkingDir(configWorkingDir, binding, env = process.env) {
    if (configWorkingDir && configWorkingDir.length > 0)
        return configWorkingDir;
    if (env.GHOST_WORKING_DIR && env.GHOST_WORKING_DIR.length > 0) {
        return env.GHOST_WORKING_DIR;
    }
    return path.join(homedir(), ".dsh", "workspaces", binding.owner, binding.name);
}
/** Per-repository token file; the default keeps the historical path. */
function repoTokensPath(key) {
    const slug = key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return path.join(path.dirname(installationTokenPath()), `dsh-mmw-tools-installation-${slug}.json`);
}
/**
 * The default binding plus every `repos` entry becomes the known set.
 *
 * Tool names do not carry repositories, so this set is the entire allow-list
 * `select_repo` can choose from. Unknown repositories are refused instead of
 * being silently routed to the default.
 */
export function buildRepoEntries(binding, workingDir, extras) {
    const entries = [
        {
            key: repoKey(binding.owner, binding.name),
            owner: binding.owner,
            name: binding.name,
            baseBranch: binding.baseBranch,
            branchPrefix: binding.branchPrefix,
            allowlistPaths: binding.allowlistPaths,
            denylistPaths: binding.denylistPaths,
            workingDir,
            tokenFile: installationTokenPath(),
            repoUrl: `https://github.com/${binding.owner}/${binding.name}.git`,
            preflight: binding.preflight,
            bootstrap: binding.bootstrap,
        },
    ];
    if (!Array.isArray(extras))
        return entries;
    for (const raw of extras) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            continue;
        const record = raw;
        const extra = normalizeBinding(record);
        if (!extra.owner || !extra.name)
            continue;
        const key = repoKey(extra.owner, extra.name);
        if (entries.some((entry) => entry.key === key))
            continue;
        const configuredDir = typeof record.workingDir === "string" ? record.workingDir.trim() : "";
        entries.push({
            key,
            owner: extra.owner,
            name: extra.name,
            baseBranch: extra.baseBranch,
            branchPrefix: extra.branchPrefix,
            allowlistPaths: extra.allowlistPaths,
            denylistPaths: extra.denylistPaths,
            workingDir: configuredDir.length > 0
                ? configuredDir
                : path.join(homedir(), ".dsh", "workspaces", extra.owner, extra.name),
            tokenFile: repoTokensPath(key),
            repoUrl: `https://github.com/${extra.owner}/${extra.name}.git`,
            preflight: extra.preflight,
            bootstrap: extra.bootstrap,
        });
    }
    return entries;
}
/**
 * Overlay auth-core registry values on the profile's local entries.
 *
 * The registry owns repository coordinates and write rules; the profile owns
 * machine-local details (working directory, token file, preflight). A repo
 * that is registered but absent from the profile gets neutral local defaults,
 * so a registry update does not require editing cordis first.
 */
export function mergeRepoCacheEntries(configured, cached) {
    const local = new Map(configured.map((entry) => [entry.key, entry]));
    return cached.map((repo) => {
        const base = local.get(repo.key);
        return {
            key: repo.key,
            owner: repo.owner,
            name: repo.name,
            baseBranch: repo.baseBranch,
            branchPrefix: repo.branchPrefix,
            allowlistPaths: [...repo.allowlistPaths],
            denylistPaths: [...repo.denylistPaths],
            workingDir: base?.workingDir ?? path.join(homedir(), ".dsh", "workspaces", repo.owner, repo.name),
            tokenFile: base?.tokenFile ?? repoTokensPath(repo.key),
            repoUrl: base?.repoUrl ?? `https://github.com/${repo.owner}/${repo.name}.git`,
            preflight: base?.preflight ?? { cmd: "", timeoutSeconds: 300 },
            bootstrap: base?.bootstrap ?? { cmd: "", whenMissing: "", timeoutSeconds: 600 },
        };
    });
}
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
        repoOwner: { type: "string" },
        repoName: { type: "string" },
        baseBranch: { type: "string" },
        mcpServerPath: { type: "string" },
        auth: {
            type: "object",
            additionalProperties: false,
            properties: {
                status: { type: "string", required: true },
                configured: { type: "boolean", required: true },
                mode: { type: "string" },
                login: { type: "string" },
                scope: { type: "string" },
                accessTokenMasked: { type: "string" },
                accessTokenExpiresAt: { type: "number" },
                tokenUpdatedAt: { type: "string" },
            },
            required: true,
        },
        workspace: {
            type: "object",
            additionalProperties: false,
            properties: {
                mode: { type: "string", required: true },
                root: { type: "string", required: true },
                repo: { type: "string", required: true },
                marker: { type: "boolean", required: true },
                reason: { type: "string", required: true },
            },
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
    if (hours < 24)
        return `约 ${hours} 小时 ${minutes - hours * 60} 分钟`;
    const days = Math.floor(hours / 24);
    return `约 ${days} 天 ${hours - days * 24} 小时`;
}
function makeStatusTool(deps) {
    return defineTool({
        name: "mmw_tools_status",
        description: "查看 dsh-mmw-tools 插件状态：broker 登录、token 状态、repo binding、AGENTS.md 漂移检查、当前授权阶段。不会泄露任何密钥。",
        parameters: STATUS_PARAMS,
        output: {
            schema: STATUS_OUTPUT_SCHEMA,
            render(_args, value) {
                return [{ type: "text", text: String(value.message ?? "") }];
            },
        },
        async execute(_args, exec) {
            const brokerLine = deps.brokerUrl;
            const workspace = deps.workspace?.(exec);
            const workspaceLine = workspace
                ? workspace.mode === "managed"
                    ? `工作区: managed（${workspace.repo ?? "?"}）— 本工作区纳入 mmw-tools，它声明的仓库操作走插件。`
                    : workspace.mode === "bootstrap"
                        ? `工作区: bootstrap（${workspace.repo ?? "?"}）— ${workspace.reason}`
                        : workspace.mode === "unmanaged"
                            ? "工作区: unmanaged — 本工作区不归 mmw-tools 管理。"
                            : workspace.mode === "mismatch"
                                ? `工作区: mismatch — ${workspace.reason}。请让用户确认仓库与规则文件。`
                                : `工作区: unknown — ${workspace.reason}。`
                : "工作区: 未检查";
            // Mint before reading the view: a Feishu login only becomes visible
            // through the issued token, so a view-first order would report an
            // empty identity next to "signed_in".
            await deps.flow.repoAccess();
            const view = await deps.flow.view();
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
                authLines.push("登录方式: 飞书（无需 GitHub 账号）");
                authLines.push(`登录身份: ${view.login || "(unknown)"}`);
                authLines.push(`仓库令牌剩余: ${formatExpiry(view.accessTokenExpiresAt)}`);
                authLines.push("飞书授权剩余: 见面板「飞书授权」一栏（默认 7 天）");
                authLines.push("仓库写入由 broker 按 operation 代理；客户端 token 只读");
            }
            else {
                authLines.push("未登录 — 请先在面板完成飞书登录");
            }
            const nextStep = status === "authorized"
                ? "可直接使用仓库工具；写操作会走 broker 代理。"
                : "请用户在面板完成飞书登录（agent 不参与登录）。";
            return {
                ok: true,
                message: `${PLUGIN_DISPLAY_NAME} 已挂载（plugin_id=${PLUGIN_ID}）。\n` +
                    `Broker: ${brokerLine}\n` +
                    `Repo binding: ${String(deps.repo.owner ?? "?")}/${String(deps.repo.name ?? "?")} (${String(deps.repo.baseBranch ?? "main")})\n` +
                    `Allowed paths: ${Array.isArray(deps.repo.allowlistPaths) ? deps.repo.allowlistPaths.join(", ") : "(空)"}\n` +
                    `MCP server entry: ${pathToConnect}\n` +
                    `\n--- Workspace ---\n${workspaceLine}\n` +
                    `\n--- Auth ---\n${authLines.join("\n")}\n` +
                    `\n--- AGENTS.md ---\n${driftLine}\n` +
                    `\n下一步：${nextStep}`,
                pluginId: PLUGIN_ID,
                repoOwner: String(deps.repo.owner ?? ""),
                repoName: String(deps.repo.name ?? ""),
                baseBranch: String(deps.repo.baseBranch ?? "main"),
                mcpServerPath: pathToConnect,
                auth: {
                    status,
                    configured: view.configured,
                    mode: view.mode,
                    login: view.login,
                    scope: view.scope,
                    accessTokenMasked: view.accessTokenMasked,
                    accessTokenExpiresAt: view.accessTokenExpiresAt,
                    tokenUpdatedAt: view.tokenUpdatedAt,
                },
                ...(workspace
                    ? {
                        workspace: {
                            mode: workspace.mode,
                            root: workspace.root,
                            repo: workspace.repo ?? "",
                            marker: workspace.marker !== null,
                            reason: workspace.reason,
                        },
                    }
                    : {}),
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
/* mmw_tools_run — v0.5.0 lightweight bootstrap wrapper. */
const MMW_TOOLS_RUN_OUTPUT = {
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
        name: "mmw_tools_run",
        description: "为 DSH agent 准备好 GitHub 仓库工程任务的工作环境：读 AGENTS.md 和 README.md、检查绑定仓库元信息、拼出 agent 必须遵守的硬约束（allowlist、denylist、分支前缀、preflight），并返回一份完整的工作指南。Agent 在收到结果后自行驱动 mcp__mmw-tools__* 工具完成实际修改。本工具不做任何 LLM 调用、不自动 push、不自动合并。",
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
            schema: MMW_TOOLS_RUN_OUTPUT,
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
                kind: "mmw_tools_run_start",
                repo: `${String(deps.repo.owner ?? "")}/${String(deps.repo.name ?? "")}`,
                branch_name: branch,
                user_request_bytes: userRequest.length,
                draft: input.draft ?? false,
            });
            try {
                // Lazy import to keep the bundle entry's import graph small.
                const mod = await import("./agent/mmw-tools-run.js");
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
                    kind: "mmw_tools_run_created",
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
                    tool: "mmw_tools_run",
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
    const feishuEnabled = config?.feishu?.enabled === true;
    const feishuAuthUrl = process.env.MMW_TOOLS_AUTH_URL ??
        config?.feishu?.authServiceUrl ??
        "https://mmw-tools.mmw-team.icu";
    // `logger` is optional in CORDIS_INJECT: a profile that does not
    // provide it must not leave this entry pending forever. Fall back to
    // the process streams, which DSH already captures.
    const consoleLogger = {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
    };
    const logger = safeAccess(() => ctx.logger) ?? consoleLogger;
    const workingDir = resolveWorkingDir(config?.workingDir, binding);
    // The default binding is always the first entry; `config.repos` only adds
    // selectable repositories. Unknown names never route to the default.
    const configuredEntries = buildRepoEntries(binding, workingDir, config?.repos);
    // The auth-core registry is authoritative for repository coordinates and
    // write rules. Startup cannot await a network call, so the last successful
    // fetch is cached on disk and overlaid here; `select_repo` refreshes it.
    const repoCache = readRepoRegistryCache();
    const repoEntries = repoCache && repoCache.repos.length > 0
        ? mergeRepoCacheEntries(configuredEntries, repoCache.repos)
        : configuredEntries;
    const defaultRepoKeyFromCache = repoCache?.defaultRepo && repoEntries.some((entry) => entry.key === repoCache.defaultRepo)
        ? repoCache.defaultRepo
        : undefined;
    const repos = new RepoRegistry(repoEntries, defaultRepoKeyFromCache ?? repoKey(binding.owner, binding.name));
    const defaultRepoKey = repos.defaultKey;
    /**
     * The session's workspace mode. The registry and the checkout's Git origin
     * are the authority; `.dsh-mmw-tools.yaml` only has to exist before writes
     * (the broker validates its contents from the base branch).
     */
    const workspaceOf = (exec) => {
        const sessionId = exec?.agent?.id;
        const selected = sessionId ? repos.selectedBy(sessionId) : undefined;
        const registry = repos
            .keys()
            .map((key) => ({ key, workingDir: repos.entry(key)?.workingDir ?? "" }))
            .filter((entry) => entry.workingDir.length > 0);
        return resolveWorkspaceMode({
            cwd: readSessionWorkingDirectory(ctx, exec),
            registry,
            selected,
        });
    };
    // Construct audit + redacting loggers once, share across tools.
    const audit = createAuditLogger({
        file: auditPath(),
        maxBytes: MAX_AUDIT_BYTES,
        warn: (m) => logger.warn(m),
    });
    const log = createRedactingLogger(logger);
    // Construct auth services.
    // One implementation: BrokerAuth replaces both the token store and the
    // Feishu is the only user-facing credential. The broker owns the GitHub
    // App identity, so a member never needs a GitHub account.
    const feishu = new FeishuAuth({ authServiceUrl: feishuAuthUrl });
    const defaultEntry = repos.entry(defaultRepoKey);
    const auth = new BrokerAuth({
        brokerUrl,
        installationTokenFile: defaultEntry?.tokenFile ?? installationTokenPath(),
        writeAuthFile: writeAuthPath(),
        // The broker decides which repository a token writes to; this plugin
        // decides which repository it edits. Passing the binding here lets the
        // two be compared instead of failing later as a bare 403.
        repository: defaultRepoKey,
        feishu,
    });
    // One credential source per repository: each mints its own read token into
    // its own file, so two sessions bound to different repositories cannot
    // overwrite each other's credential.
    const authByRepo = new Map([[defaultRepoKey, auth]]);
    const authFor = (key) => {
        const existing = authByRepo.get(key);
        if (existing)
            return existing;
        const entry = repos.entry(key);
        if (!entry)
            throw new Error(`未知仓库：${key}`);
        const created = new BrokerAuth({
            brokerUrl,
            installationTokenFile: entry.tokenFile,
            writeAuthFile: writeAuthPath(),
            repository: key,
            feishu,
        });
        authByRepo.set(key, created);
        return created;
    };
    const flow = auth;
    const gate = new PolicyGate({
        auth: feishu,
        enabled: feishuEnabled,
        // Default: the gate governs this plugin's own tools only. The
        // session-wide allowlist is opt-in, because a profile is shared by
        // every workspace it hosts and an exclusive allowlist would strip the
        // host's `read` / `pwsh` / … out of all of them.
        sessionWide: config?.feishu?.gateScope === "session",
        repos,
    });
    // Hydrate lastStatus before exposing it.
    ctx.effect(() => {
        void flow.hydrate();
        return () => { };
    }, "mmw-tools: hydrate auth");
    // Workspace guard. Installed BEFORE the policy gate on purpose: a call made
    // from a session that is not in the bound repository must be refused for that
    // reason, not with an auth round trip that reports "飞书授权不可用".
    //
    // `mmw_tools_status` is exempt (diagnostics), and `repo_clone` may bootstrap
    // the checkout while it has no `.git`. Everything else is fail-closed.
    //
    // Roots come from `workingDir`, i.e. from the same derivation everything else
    // uses — there is deliberately no second copy of the checkout path here.
    const guardConfig = config?.workspaceGuard;
    const extraRoots = Array.isArray(guardConfig?.allowPaths)
        ? guardConfig.allowPaths.filter((p) => typeof p === "string" && p.length > 0)
        : [];
    const workspaceRoots = [
        ...new Set([workingDir, ...repoEntries.map((entry) => entry.workingDir), ...extraRoots]),
    ];
    // Fail closed by default: a host that cannot report the session directory
    // must not silently become a way to use the repository tools everywhere.
    const unavailablePolicy = guardConfig?.onUnavailable === "allow" ? "allow" : "deny";
    ctx.effect(() => installWorkspaceGuard(ctx, {
        roots: workspaceRoots,
        enabled: guardConfig?.enabled !== false,
        onUnavailable: unavailablePolicy,
        modeOf: (exec) => workspaceOf(exec).mode,
        logger,
    }), "mmw-tools: workspace guard");
    // Feishu policy + pr_merge confirmation. This is installed at apply level
    // (not inside the webServer callback) so a profile without a web UI still
    // cannot bypass the gate.
    ctx.effect(() => installToolGate(ctx, {
        gate,
        logger,
        onEvent: (event) => {
            // Fire-and-forget: an unwritable audit file must not block a call.
            void audit.record({
                kind: event.kind,
                runId: event.runId,
                tool: event.tool,
                decision: event.decision,
                ...(event.reason === undefined ? {} : { reason: event.reason }),
            });
        },
    }), "mmw-tools: tool gate");
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
                    logger.warn(`mmw-tools: ${agentsMdDrift.summary}`);
                }
                else {
                    const check = checkAgentsMd(bindingLike, agentsMd);
                    agentsMdDrift = check;
                    if (check.ok)
                        logger.info(`mmw-tools: ${check.summary}`);
                    else
                        logger.warn(`mmw-tools: ${check.summary}`);
                }
            }
            catch (err) {
                logger.error(`mmw-tools: AGENTS.md drift check threw: ${err instanceof Error ? err.message : String(err)}`);
            }
        })();
        return () => { };
    }, "mmw-tools: agents-md drift");
    // 1. Register the status tool.
    ctx.effect(() => {
        return ctx.tools.register(makeStatusTool({ brokerUrl, repo, agentsMdDrift, flow, workspace: workspaceOf }));
    }, "mmw-tools: status tool");
    // 1b. Repository selection. The name lives in the MCP namespace because it
    // is part of the contract the model sees, but it is handled here: the MCP
    // child has no per-session state.
    ctx.effect(() => {
        return ctx.tools.register(defineTool({
            name: "mcp__mmw-tools__select_repo",
            description: "选择本会话要操作的仓库（owner/name）。必须先选择才能调用其他业务工具；同一会话不能改选另一个仓库。",
            parameters: {
                repo: {
                    type: "string",
                    description: "仓库全名，例如 mmw-devs/ffxiv-race-ops",
                    required: true,
                },
            },
            output: {
                schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        ok: { type: "boolean", required: true },
                        message: { type: "string", required: true },
                        repo: { type: "string", required: true },
                    },
                },
                render(_args, value) {
                    return [{ type: "text", text: String(value.message ?? "") }];
                },
            },
            async execute(args, exec) {
                const sessionId = exec.agent?.id;
                if (!sessionId) {
                    throw new Error("[mmw_route_denied] 无法识别当前会话，不能绑定仓库");
                }
                const requested = String(args.repo ?? "");
                // The registry is authoritative; refresh it before binding so a
                // repository removed or disabled in the admin UI cannot be selected
                // from the stale on-disk cache. Profiles without Feishu keep the
                // local list: there is no registry to refresh.
                let table = null;
                if (feishuEnabled) {
                    try {
                        table = await feishu.repos();
                    }
                    catch (err) {
                        throw new Error(`[mmw_policy_unavailable] 无法刷新仓库注册表：${err instanceof Error ? err.message : String(err)}`);
                    }
                }
                if (table) {
                    if (table.repos.length === 0) {
                        throw new Error("[mmw_policy_unavailable] 授权服务没有启用任何仓库，请联系管理员");
                    }
                    const known = repos.normalize(requested);
                    if (!known) {
                        throw new Error(`[mmw_route_denied] 未知仓库 ${JSON.stringify(requested)}；可用仓库：${repos.keys().join(", ")}`);
                    }
                    const registered = table.repos.find((repo) => repo.key === known);
                    if (!registered) {
                        throw new Error(`[mmw_route_denied] 仓库 ${known} 未在授权服务注册表中启用`);
                    }
                    let grantTable;
                    try {
                        grantTable = await feishu.routes(true, undefined, known);
                    }
                    catch (err) {
                        throw new Error(`[mmw_policy_unavailable] 无法读取仓库授权：${err instanceof Error ? err.message : String(err)}`);
                    }
                    if (!grantTable.allowedOperations.includes("race-ops.select_repo")) {
                        throw new Error(`[mmw_route_denied] 当前账号在仓库 ${known} 没有可用角色，请联系管理员授予 viewer 或更高角色`);
                    }
                    // The repository's own rule file is authoritative for paths and
                    // branches. Read it before binding so a missing/invalid file fails
                    // closed instead of falling back to the profile copy.
                    let repoPolicy;
                    try {
                        repoPolicy = await authFor(known).repoPolicy();
                    }
                    catch (err) {
                        throw new Error(`[mmw_policy_unavailable] 无法读取仓库规则：${err instanceof Error ? err.message : String(err)}`);
                    }
                    const current = repos.keys().map((key) => repos.entry(key)).filter(Boolean);
                    const merged = mergeRepoCacheEntries(current, table.repos).map((entry) => entry.key === known
                        ? {
                            ...entry,
                            branchPrefix: repoPolicy.rules.branchPrefix,
                            allowlistPaths: [...repoPolicy.rules.allowlistPaths],
                            denylistPaths: [...repoPolicy.rules.denylistPaths],
                            preflight: { ...repoPolicy.rules.preflight },
                            bootstrap: { ...repoPolicy.rules.bootstrap },
                            prDefaultDraft: repoPolicy.rules.prDefaultDraft,
                        }
                        : entry);
                    const nextDefault = table.defaultRepo && merged.some((entry) => entry.key === table.defaultRepo)
                        ? table.defaultRepo
                        : merged[0].key;
                    repos.replace(merged, nextDefault);
                    writeRepoRegistryCache({
                        fetchedAt: Date.now(),
                        policyRevision: table.policyRevision,
                        defaultRepo: table.defaultRepo,
                        repos: merged,
                    });
                }
                const requestedKey = repos.normalize(requested);
                const workspace = workspaceOf(exec);
                if (workspace.mode === "unmanaged") {
                    throw new Error("[mmw_route_denied] 本工作区不归 mmw-tools 管理，不能在这里选择仓库。");
                }
                if (workspace.mode === "mismatch") {
                    throw new Error(`[mmw_route_denied] 当前工作区与 mmw-tools 的仓库配置不一致：${workspace.reason}。请让用户确认，不要自行切换通道。`);
                }
                if (workspace.mode === "unknown") {
                    throw new Error("[mmw_route_denied] 无法确定当前会话的工作目录，不能选择仓库。");
                }
                if (requestedKey &&
                    workspace.repo &&
                    workspace.repo !== requestedKey &&
                    (workspace.mode === "managed" || workspace.mode === "bootstrap")) {
                    throw new Error(`[mmw_route_denied] 当前工作区属于 ${workspace.repo}，本会话不能选择 ${requestedKey}。`);
                }
                const selected = repos.select(sessionId, requested);
                if (!selected.ok) {
                    throw new Error(`[mmw_route_denied] ${selected.reason}`);
                }
                const entry = repos.entry(selected.key);
                let tokenNote = "";
                try {
                    const token = await authFor(selected.key).ensureInstallationToken();
                    tokenNote = token ? "仓库令牌已就绪。" : "尚未登录，工具调用会被拒绝。";
                }
                catch (err) {
                    tokenNote = `仓库令牌获取失败：${err instanceof Error ? err.message : String(err)}`;
                }
                return {
                    ok: true,
                    repo: selected.key,
                    message: `已选择仓库 ${selected.key}（工作目录 ${entry?.workingDir ?? "?"}）。${tokenNote}`,
                };
            },
        }));
    }, "mmw-tools: select_repo tool");
    // 2. Register the OAuth tools.
    // 2.5. Register mmw_tools_run (v0.5.0 bootstrap).
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
    }, "mmw-tools: mmw_tools_run tool");
    // 3. Register loopback HTTP routes.
    ctx.effect(() => {
        let disposers = [];
        const dispose = whenService(serviceGetter(ctx, "webServer"), () => {
            const ws = safeAccess(serviceGetter(ctx, "webServer"));
            disposers.push(...registerSkills(ctx, logger));
            disposers = makeRoutes({
                flow,
                feishu,
                brokerUrl,
                binding: {
                    owner: binding.owner,
                    name: binding.name,
                    baseBranch: binding.baseBranch,
                    allowlistPaths: binding.allowlistPaths,
                },
            }).map((r) => ws.register(r));
            return () => disposers.forEach((d) => d());
        }, () => logger.warn("mmw-tools: `webServer` never became available; the Settings panel routes were not registered"));
        return () => {
            dispose();
            disposers.forEach((d) => d());
        };
    }, "mmw-tools: routes");
    // 4. Announce to the agent via a system prompt section.
    ctx.effect(() => {
        const paths = Object.values(API).join(", ");
        return whenService(serviceGetter(ctx, "systemPrompt"), () => safeAccess(serviceGetter(ctx, "systemPrompt")).section({
            name: `plugin:${PLUGIN_ID}`,
            order: SYSTEM_PROMPT_SECTION_ORDER,
            text: `本机已安装 ${PLUGIN_DISPLAY_NAME} 插件（GitHub 仓库工程脚手架，plugin_id=${PLUGIN_ID}）。` +
                "Agent tools: mmw_tools_status（查看状态）、mmw_tools_run（读取上下文）。" +
                "飞书登录在 Settings → MMW Tools；agent 不参与登录流程。" +
                (feishuEnabled
                    ? "飞书门禁已启用：业务工具调用前必须完成飞书授权，mmw_tools_status 始终可用。"
                    : "飞书门禁未启用：当前仍由 broker 的 GitHub App 身份访问仓库。") +
                "工作区规则：插件只在纳入 mmw-tools 的仓库工作区生效，它声明支持的仓库/PR 操作才走插件；" +
                "未纳入的工作区不要调用插件工具，也不要假定用户必须改用某个具体工具。" +
                "不确定当前工作区是否纳入时，先看 mmw_tools_status 的 workspace 字段。" +
                `Loopback HTTP routes: ${paths}。`,
        }), () => logger.warn("mmw-tools: `systemPrompt` never became available; the agent announcement was not registered"));
    }, "mmw-tools: section");
    // 5. Refresh watchdog — every 60s, refresh access_token if it's
    //    expiring within 5 minutes.
    ctx.effect(() => {
        const handle = setInterval(() => {
            void (async () => {
                try {
                    const refreshed = await flow.ensureFresh();
                    if (refreshed) {
                        logger.info(`mmw-tools: access_token auto-refreshed`);
                    }
                }
                catch (err) {
                    logger.error(`mmw-tools: refresh watchdog threw: ${err instanceof Error ? err.message : String(err)}`);
                }
            })();
        }, 60_000);
        handle.unref();
        return () => clearInterval(handle);
    }, "mmw-tools: refresh watchdog");
    // 5b. Feishu token watchdog. The auth core rotates the plugin token on
    //     refresh, so this is checked every six hours, and only inside the last
    //     day of a seven-day token. A missing/expired token is a normal state
    //     (the panel should show it), not a crash.
    ctx.effect(() => {
        if (!feishuEnabled)
            return () => { };
        let lastWarningAt = 0;
        const check = async () => {
            try {
                if (await feishu.refreshIfNeeded()) {
                    logger.info("mmw-tools: 飞书授权 token 已自动续期");
                }
            }
            catch (err) {
                const now = Date.now();
                if (now - lastWarningAt < 6 * 60 * 60 * 1000)
                    return;
                lastWarningAt = now;
                logger.warn(`mmw-tools: 飞书 token 续期失败：${err instanceof Error ? err.message : String(err)}`);
            }
        };
        void check();
        const handle = setInterval(() => {
            void check();
        }, 6 * 60 * 60 * 1000);
        handle.unref();
        return () => clearInterval(handle);
    }, "mmw-tools: feishu token refresh");
    // 6. Spawn the MCP server and re-publish its tools.
    ctx.effect(() => {
        if (!existsSync(pathToConnect)) {
            logger.warn(`mmw-tools: mcp-server entry not found at ${pathToConnect}; skipping MCP spawn. Run \`pnpm build\` inside mcp-server/.`);
            return () => { };
        }
        const client = new Client({ name: PLUGIN_DISPLAY_NAME, version: "0.1.0" }, { capabilities: {} });
        (async () => {
            try {
                const transport = new StdioClientTransport({
                    command: process.execPath,
                    args: [pathToConnect],
                    env: { ...extendedEnv(), ...mcpBindingEnv(binding, workingDir, brokerUrl, repoEntries) },
                });
                await client.connect(transport);
                const { tools } = await client.request({ method: "tools/list" }, ListToolsResultSchema);
                logger.info(`mmw-tools: MCP server connected, ${tools.length} tool(s) discovered`);
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
                            // The gate seeds this context before policy evaluation. A call
                            // that did not pass through the gate (for example, feishu
                            // disabled in a local profile) still gets an id so MCP errors
                            // can be correlated with the host log.
                            const runId = currentRunId() ?? newRunId();
                            const sessionId = exec.agent?.id;
                            const selectedRepo = sessionId ? repos.selectedBy(sessionId) : undefined;
                            const result = (await client.request({
                                method: "tools/call",
                                params: {
                                    name: tool.name,
                                    arguments: forwardArgs,
                                    _meta: selectedRepo
                                        ? { mmwRunId: runId, mmwRepo: selectedRepo }
                                        : { mmwRunId: runId },
                                },
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
                logger.error(`mmw-tools: failed to start MCP server: ${err instanceof Error ? err.message : String(err)}`);
                return () => { };
            }
        })();
        return () => { };
    }, "mmw-tools: mcp bridge");
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
export { BrokerAuth, installationTokenPath, writeAuthPath } from "./auth/broker-auth.js";
export { makeRoutes, API } from "./routes.js";
