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
 *   2. engineer_oauth_start / _finish / _refresh / _revoke
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
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  PLUGIN_ID,
  PLUGIN_DISPLAY_NAME,
  PLUGIN_NAMESPACE,
  CORDIS_INJECT,
  SYSTEM_PROMPT_SECTION_ORDER,
  mcpServerEntryPath,
} from "./const.js";
import { checkAgentsMd, fetchAgentsMd, type RepoBindingLike } from "./agents-md-check.js";
import { TokenStore, configPath } from "./auth/token-store.js";
import { DeviceFlow } from "./auth/device-flow.js";
import { makeRoutes, API } from "./routes.js";
import { createAuditLogger, createRedactingLogger, auditPath, MAX_BYTES as MAX_AUDIT_BYTES } from "./util/audit.js";

/** Where MCP server lives — exposed for tests / docs. */
export const pathToConnect = mcpServerEntryPath(import.meta.url);

/** Sanitize a raw MCP tool name into a model-facing DSH agent name. */
function publicToolName(rawName: string): string {
  const sanitized = rawName.replace(/[^A-Za-z0-9_-]/g, "_");
  return PLUGIN_NAMESPACE + sanitized;
}

/** Extract text from an MCP `ContentBlock[]` for display. */
function extractText(mcpContent: unknown, toolName: string): string {
  if (!Array.isArray(mcpContent)) return `(${toolName} returned no content)`;
  const parts: string[] = [];
  for (const block of mcpContent) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n") || `(${toolName} returned no text content)`;
}

/** Skeleton env: extended PATH so the child can find `node`. */
function extendedEnv(): Record<string, string> {
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
    if (seen.has(d) || !existsSync(d)) continue;
    seen.add(d);
    segments.push(d);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
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
export function mcpBindingEnv(binding: NormalizedBinding, workingDir: string): Record<string, string> {
  const env: Record<string, string> = {
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
    GHOST_TOKEN_FILE: configPath(),
  };
  if (binding.bootstrap.cmd.length > 0) {
    env.GHOST_BOOTSTRAP_CMD = binding.bootstrap.cmd;
    env.GHOST_BOOTSTRAP_WHEN_MISSING = binding.bootstrap.whenMissing;
    env.GHOST_BOOTSTRAP_TIMEOUT = String(binding.bootstrap.timeoutSeconds);
  }
  return env;
}

/** The plugin's `repoBinding`, with every field defaulted once. */
export interface NormalizedBinding {
  owner: string;
  name: string;
  baseBranch: string;
  branchPrefix: string;
  allowlistPaths: string[];
  denylistPaths: string[];
  preflight: { cmd: string; timeoutSeconds: number };
  bootstrap: { cmd: string; whenMissing: string; timeoutSeconds: number };
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

export function normalizeBinding(raw: Record<string, unknown>): NormalizedBinding {
  const str = (v: unknown, fallback: string) =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const preflightRaw = (raw.preflight ?? {}) as Record<string, unknown>;
  const bootRaw = (raw.bootstrap ?? {}) as Record<string, unknown>;

  return {
    owner: str(raw.owner, ""),
    name: str(raw.name, ""),
    baseBranch: str(raw.baseBranch, "main"),
    branchPrefix: str(raw.branchPrefix, "content/"),
    allowlistPaths: list(raw.allowlistPaths),
    denylistPaths: list(raw.denylistPaths).length > 0 ? list(raw.denylistPaths) : DEFAULT_DENYLIST,
    preflight: {
      cmd: str(preflightRaw.cmd, "npm run validate"),
      timeoutSeconds:
        typeof preflightRaw.timeoutSeconds === "number" ? preflightRaw.timeoutSeconds : 60,
    },
    bootstrap: {
      cmd: str(bootRaw.cmd, ""),
      whenMissing: str(bootRaw.whenMissing, "node_modules"),
      timeoutSeconds:
        typeof bootRaw.timeoutSeconds === "number" ? bootRaw.timeoutSeconds : 300,
    },
  };
}

/* ============================================================== */
/*  Agent tools                                                    */
/* ============================================================== */
const STATUS_PARAMS = {} as const;

const STATUS_OUTPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false as const,
  properties: {
    ok: { type: "boolean" as const, required: true as const },
    message: { type: "string" as const, required: true as const },
    pluginId: { type: "string" as const },
    oauthClientIdMasked: { type: "string" as const },
    repoOwner: { type: "string" as const },
    repoName: { type: "string" as const },
    baseBranch: { type: "string" as const },
    defaultScopes: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    mcpServerPath: { type: "string" as const },
    auth: {
      type: "object" as const,
      additionalProperties: false as const,
      properties: {
        status: { type: "string" as const, required: true as const },
        configured: { type: "boolean" as const, required: true as const },
        login: { type: "string" as const },
        scope: { type: "string" as const },
        accessTokenMasked: { type: "string" as const },
        accessTokenExpiresAt: { type: "number" as const },
        refreshTokenExpiresAt: { type: "number" as const },
        tokenUpdatedAt: { type: "string" as const },
      },
      required: true as const,
    },
    agentsMdDrift: {
      type: "object" as const,
      additionalProperties: false as const,
      properties: {
        ok: { type: "boolean" as const, required: true as const },
        unavailable: { type: "boolean" as const, required: true as const },
        summary: { type: "string" as const, required: true as const },
        details: {
          type: "array" as const,
          items: {
            type: "object" as const,
            additionalProperties: true as const,
            properties: {
              label: { type: "string" as const },
              passed: { type: "boolean" as const },
              observed: { type: "string" as const },
            },
          },
          required: true as const,
        },
      },
      required: true as const,
    },
  },
};

function formatExpiry(timestampMs: number): string {
  if (timestampMs <= 0) return "永不过期";
  const remaining = Math.max(0, timestampMs - Date.now());
  const minutes = Math.floor(remaining / 60000);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `约 ${hours} 小时 ${minutes - hours * 60} 分钟`;
}

function makeStatusTool(deps: {
  oauthClientId: string;
  repo: Record<string, unknown>;
  scopes: string[];
  agentsMdDrift: ReturnType<typeof checkAgentsMd> | null;
  store: TokenStore;
  flow: DeviceFlow;
}) {
  return defineTool({
    name: "engineer_status",
    description:
      "查看 dsh-github-engineer 插件状态：OAuth 配置、token 状态、repo binding、AGENTS.md 漂移检查、当前授权阶段。不会泄露任何密钥。",
    parameters: STATUS_PARAMS,
    output: {
      schema: STATUS_OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: "text", text: String(value.message ?? "") }];
      },
    },
    async execute() {
      const oauthMasked = deps.oauthClientId
        ? `${deps.oauthClientId.slice(0, 6)}****`
        : "(未设置 — 把 cordis.patch.yml 里的 githubOAuthClientId 换成真实的)";
      const view = await deps.store.view();
      const status = deps.flow.status();

      const driftLine = deps.agentsMdDrift
        ? deps.agentsMdDrift.unavailable
          ? "AGENTS.md drift: 暂无法拉取（OAuth 未完成或仓库不可匿名访问）"
          : deps.agentsMdDrift.ok
          ? "AGENTS.md drift: OK"
          : "AGENTS.md drift: ⚠️ 不一致 — 详情见 dsh web 日志"
        : "AGENTS.md drift: 未检查";

      const authLines: string[] = [`Auth 状态: ${status}`];
      if (status === "authorized") {
        authLines.push(`登录身份: ${view.login || "(unknown)"}`);
        authLines.push(`Scopes: ${view.scope || "(none)"}`);
        authLines.push(`access_token 剩余: ${formatExpiry(view.accessTokenExpiresAt)}`);
        authLines.push(`refresh_token 剩余: ${formatExpiry(view.refreshTokenExpiresAt)}`);
      } else if (status === "reauth_needed") {
        authLines.push("⚠️ access_token 失效 — 调用 engineer_oauth_start 重新授权");
      } else if (status === "device_pending") {
        authLines.push("用户正在浏览器完成授权 — 调用 engineer_oauth_finish 轮询");
      } else {
        authLines.push("调用 engineer_oauth_start 发起 Device Flow");
      }

      return {
        ok: true,
        message:
          `${PLUGIN_DISPLAY_NAME} 已挂载（plugin_id=${PLUGIN_ID}）。\n` +
          `OAuth App: ${oauthMasked}\n` +
          `Repo binding: ${String(deps.repo.owner ?? "?")}/${String(deps.repo.name ?? "?")} (${String(deps.repo.baseBranch ?? "main")})\n` +
          `Allowed paths: ${Array.isArray(deps.repo.allowlistPaths) ? deps.repo.allowlistPaths.join(", ") : "(空)"}\n` +
          `Default scopes: ${deps.scopes.join(" ") || "(空)"}\n` +
          `MCP server entry: ${pathToConnect}\n` +
          `\n--- Auth ---\n${authLines.join("\n")}\n` +
          `\n--- AGENTS.md ---\n${driftLine}\n` +
          `\n下一步：实现 OAuth Device Flow 后调用 engineer_oauth_start。`,
        pluginId: PLUGIN_ID,
        oauthClientIdMasked: deps.oauthClientId
          ? `${deps.oauthClientId.slice(0, 6)}****`
          : "",
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
  type: "object" as const,
  additionalProperties: false as const,
  properties: {
    branch_suggestion: { type: "string" as const, required: true as const },
    working_dir: { type: "string" as const, required: true as const },
    repo: {
      type: "object" as const,
      additionalProperties: false as const,
      properties: {
        owner: { type: "string" as const, required: true as const },
        name: { type: "string" as const, required: true as const },
        base_branch: { type: "string" as const, required: true as const },
      },
      required: true as const,
    },
    agents_md_excerpt: { type: "string" as const, required: true as const },
    readme_excerpt: { type: "string" as const, required: true as const },
    agents_md_present: { type: "boolean" as const, required: true as const },
    readme_present: { type: "boolean" as const, required: true as const },
    allowlist: {
      type: "array" as const,
      items: { type: "string" as const },
      required: true as const,
    },
    denylist: {
      type: "array" as const,
      items: { type: "string" as const },
      required: true as const,
    },
    branch_prefix: { type: "string" as const, required: true as const },
    preflight_cmd: { type: "string" as const, required: true as const },
    tool_inventory: {
      type: "array" as const,
      items: { type: "string" as const },
      required: true as const,
    },
    instructions: { type: "string" as const, required: true as const },
  },
};

function makeEngineerRunTool(deps: {
  workingDir: string;
  repo: Record<string, unknown>;
  allowlistPaths: string[];
  denylistPaths: string[];
  branchPrefix: string;
  preflightCmd: string;
  /** Audit logger — every engineer_run writes one start event plus an
   *  outcome event. The writer never throws. */
  audit: import("./util/audit.js").AuditLogger;
  /** Token-redacting logger — for any incidental log line. */
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}) {
  return defineTool({
    name: "engineer_run",
    description:
      "为 DSH agent 准备好 GitHub 仓库工程任务的工作环境：读 AGENTS.md 和 README.md、检查绑定仓库元信息、拼出 agent 必须遵守的硬约束（allowlist、denylist、分支前缀、preflight），并返回一份完整的工作指南。Agent 在收到结果后自行驱动 mcp__github-engineer__* 工具完成实际修改。本工具不做任何 LLM 调用、不自动 push、不自动合并。",
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
        const v = value as Record<string, unknown>;
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
      const input = (args ?? {}) as {
        user_request?: string;
        branch_name?: string;
        draft?: boolean;
      };
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
        const result = await mod.engineerRun(
          {
            user_request: userRequest,
            branch_name: branch || undefined,
            draft: input.draft,
          },
          {
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
          }
        );
        void deps.audit.record({
          kind: "engineer_run_created",
          branch_suggestion: result.branch_suggestion,
          agents_md_present: result.agents_md_present,
          readme_present: result.readme_present,
        });
        return result;
      } catch (err) {
        // Surface the error code (e.g. "user-request-contains-token",
        // "user-request-too-long") so the agent can act on it. The
        // raw message is already token-redacted by validateInput +
        // assertNoTokens upstream, but we re-redact for safety.
        const code = err instanceof Error && "code" in err
          ? String((err as { code: unknown }).code)
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
  type: "object" as const,
  additionalProperties: false as const,
  properties: {
    ok: { type: "boolean" as const, required: true as const },
    message: { type: "string" as const, required: true as const },
    userCode: { type: "string" as const },
    verificationUri: { type: "string" as const },
    expiresAt: { type: "number" as const },
    interval: { type: "number" as const },
  },
};

const OAUTH_SIMPLE_OUTPUT = {
  type: "object" as const,
  additionalProperties: false as const,
  properties: {
    ok: { type: "boolean" as const, required: true as const },
    message: { type: "string" as const, required: true as const },
  },
};

function makeOauthStartTool(flow: DeviceFlow) {
  return defineTool({
    name: "engineer_oauth_start",
    description:
      "发起 GitHub OAuth Device Flow：向 GitHub 申请一个 user_code，让用户在浏览器打开 https://github.com/login/device 输码完成授权。返回 userCode + verificationUri。后续用 engineer_oauth_finish 轮询结果。",
    parameters: {},
    output: {
      schema: OAUTH_START_OUTPUT,
      render(_args, value) {
        const v = value as Record<string, unknown>;
        const lines = [String(v.message ?? "")];
        if (v.userCode && v.verificationUri) {
          lines.push("", `user_code: ${v.userCode}`, `verification_uri: ${v.verificationUri}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute() {
      try {
        const pending = await flow.begin();
        return {
          ok: true,
          message:
            "已在 GitHub 发起 Device Flow。请让用户在浏览器打开下方 verification_uri 并输 user_code 完成授权。完成后用 engineer_oauth_finish 轮询结果。",
          userCode: pending.userCode,
          verificationUri: pending.verificationUri,
          expiresAt: pending.expiresAt,
          interval: pending.interval,
        };
      } catch (err) {
        return {
          ok: false,
          message: "发起授权失败：" + (err instanceof Error ? err.message : String(err)),
        };
      }
    },
  });
}

function makeOauthFinishTool(flow: DeviceFlow) {
  return defineTool({
    name: "engineer_oauth_finish",
    description:
      "轮询 Device Flow 一次：检查用户是否已在浏览器完成授权；若已完成，保存 access_token/refresh_token；若用户还在授权中，返回 ok=false 并说明错误码（authorization_pending / slow_down / expired_token）。可重复调用直到 ok=true 或出错。",
    parameters: {},
    output: {
      schema: OAUTH_SIMPLE_OUTPUT,
      render(_args, value) {
        return [{ type: "text", text: String((value as Record<string, unknown>).message ?? "") }];
      },
    },
    async execute() {
      const result = await flow.poll();
      if (result.ok) {
        return {
          ok: true,
          message: `授权完成。access_token 已保存（登录身份: ${result.tokens.login || "(unknown)"}，scope: ${result.tokens.scope || "(none)"}）。`,
        };
      }
      return { ok: false, message: result.message };
    },
  });
}

function makeOauthRefreshTool(flow: DeviceFlow) {
  return defineTool({
    name: "engineer_oauth_refresh",
    description:
      "主动用 refresh_token 换一个新的 access_token。access_token 8 小时过期、refresh_token 6 个月过期；watchdog 会自动 refresh，本工具用于手动触发。",
    parameters: {},
    output: {
      schema: OAUTH_SIMPLE_OUTPUT,
      render(_args, value) {
        return [{ type: "text", text: String((value as Record<string, unknown>).message ?? "") }];
      },
    },
    async execute() {
      return flow.refresh();
    },
  });
}

function makeOauthRevokeTool(flow: DeviceFlow) {
  return defineTool({
    name: "engineer_oauth_revoke",
    description:
      "清空所有 GitHub 凭据（access_token + refresh_token）。撤销后下一次操作需要重新发起 Device Flow。注意：这只是清本地副本；要撤销 GitHub 端的授权，用户需要去 https://github.com/settings/applications 自己撤销。",
    parameters: {},
    output: {
      schema: OAUTH_SIMPLE_OUTPUT,
      render(_args, value) {
        return [{ type: "text", text: String((value as Record<string, unknown>).message ?? "") }];
      },
    },
    async execute() {
      await flow.clearAll();
      return { ok: true, message: "凭据已清空。下一次需要调用 engineer_oauth_start 重新授权。" };
    },
  });
}

/* ============================================================== */
/*  Bundle apply                                                   */
/* ============================================================== */

interface BundleConfig {
  githubOAuthClientId?: string;
  defaultScopes?: string[];
  repoBinding?: Record<string, unknown>;
  /**
   * Local working directory where the repo is (or will be) cloned.
   * Required for `engineer_run` to read AGENTS.md / README.md. The
   * MCP server reads the same value from `GHOST_WORKING_DIR`; we
   * fall back to that env var when `workingDir` is not provided.
   */
  workingDir?: string;
}

/**
 * Read a service from the host context without assuming it exists.
 *
 * Cordis resolves `ctx.<service>` through a getter that may throw when
 * the service is declared but not ready. Since none of these services is
 * declared (see CORDIS_INJECT), a missing one should read as undefined
 * rather than take the whole plugin down at activation.
 */
function safeAccess<T>(get: () => T | undefined): T | undefined {
  try {
    return get();
  } catch {
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
function serviceGetter(ctx: unknown, name: string): () => unknown {
  return () => {
    const c = ctx as { get?: (n: string) => unknown } & Record<string, unknown>;
    if (typeof c.get === "function") {
      try {
        return c.get(name);
      } catch {
        /* fall through to property access */
      }
    }
    return c[name];
  };
}

function whenService(
  get: () => unknown,
  register: () => () => void,
  onTimeout: () => void,
  timeoutMs = 15_000,
  intervalMs = 100
): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposer: (() => void) | undefined;
  const deadline = Date.now() + timeoutMs;

  const attempt = () => {
    if (disposed) return;
    if (safeAccess(get as () => unknown) !== undefined) {
      disposer = register();
      return;
    }
    if (Date.now() >= deadline) {
      onTimeout();
      return;
    }
    timer = setTimeout(attempt, intervalMs);
    (timer as { unref?: () => void }).unref?.();
  };
  attempt();

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    disposer?.();
  };
}

export function apply(
  ctx: {
    tools: { register: (d: unknown) => () => void };
    webServer?: {
      port: number;
      register: (route: { kind: "exact"; path: string; handler: (req: any, res: any) => Promise<void> }) => () => void;
    };
    systemPrompt?: {
      section: (s: { name: string; order: number; text: string }) => () => void;
    };
    effect: (fn: () => () => void, label: string) => () => void;
    logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  },
  config?: BundleConfig
): void {
  const oauthClientId = config?.githubOAuthClientId ?? "";
  const repo = config?.repoBinding ?? {};
  const binding = normalizeBinding(repo);

  // `logger` is optional in CORDIS_INJECT: a profile that does not
  // provide it must not leave this entry pending forever. Fall back to
  // the process streams, which DSH already captures.
  const consoleLogger = {
    info: (m: string) => console.log(m),
    warn: (m: string) => console.warn(m),
    error: (m: string) => console.error(m),
  };
  const logger = safeAccess(() => ctx.logger) ?? consoleLogger;
  const scopes: string[] = Array.isArray(config?.defaultScopes) ? config.defaultScopes : [];
  const workingDir =
    config?.workingDir && config.workingDir.length > 0
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
  const store = new TokenStore();
  const flow = new DeviceFlow({ store, clientId: oauthClientId, scopes });

  // Hydrate lastStatus before exposing it.
  ctx.effect(() => {
    void flow.hydrate();
    return () => {};
  }, "github-engineer: hydrate auth");

  // AGENTS.md drift detection — fires once on apply.
  let agentsMdDrift: ReturnType<typeof checkAgentsMd> | null = null;
  ctx.effect(() => {
    const bindingLike: RepoBindingLike = {
      owner: String(repo.owner ?? ""),
      name: String(repo.name ?? ""),
      branchPrefix: String(repo.branchPrefix ?? ""),
      allowlistPaths: Array.isArray(repo.allowlistPaths)
        ? (repo.allowlistPaths as string[])
        : [],
      preflight: repo.preflight as { cmd?: string } | undefined,
    };
    void (async () => {
      try {
        const agentsMd = await fetchAgentsMd(
          bindingLike.owner,
          bindingLike.name,
          String(repo.baseBranch ?? "main"),
          null
        );
        if (agentsMd === null) {
          agentsMdDrift = {
            ok: false,
            unavailable: true,
            details: [],
            summary: `无法拉取 AGENTS.md：${bindingLike.owner}/${bindingLike.name}@${String(repo.baseBranch ?? "main")}`,
          };
          logger.warn(`github-engineer: ${agentsMdDrift.summary}`);
        } else {
          const check = checkAgentsMd(bindingLike, agentsMd);
          agentsMdDrift = check;
          if (check.ok) logger.info(`github-engineer: ${check.summary}`);
          else logger.warn(`github-engineer: ${check.summary}`);
        }
      } catch (err) {
        logger.error(
          `github-engineer: AGENTS.md drift check threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    })();
    return () => {};
  }, "github-engineer: agents-md drift");

  // 1. Register the status tool.
  ctx.effect(() => {
    return ctx.tools.register(
      makeStatusTool({ oauthClientId, repo, scopes, agentsMdDrift, store, flow })
    );
  }, "github-engineer: status tool");

  // 2. Register the OAuth tools.
  ctx.effect(() => {
    return ctx.tools.register(makeOauthStartTool(flow));
  }, "github-engineer: oauth_start tool");

  ctx.effect(() => {
    return ctx.tools.register(makeOauthFinishTool(flow));
  }, "github-engineer: oauth_finish tool");

  ctx.effect(() => {
    return ctx.tools.register(makeOauthRefreshTool(flow));
  }, "github-engineer: oauth_refresh tool");

  ctx.effect(() => {
    return ctx.tools.register(makeOauthRevokeTool(flow));
  }, "github-engineer: oauth_revoke tool");

  // 2.5. Register engineer_run (v0.5.0 bootstrap).
  ctx.effect(() => {
    const allowlist = Array.isArray(repo.allowlistPaths)
      ? (repo.allowlistPaths as string[])
      : [];
    const denylist = Array.isArray(repo.denylistPaths)
      ? (repo.denylistPaths as string[])
      : [];
    return ctx.tools.register(
      makeEngineerRunTool({
        workingDir,
        repo,
        allowlistPaths: allowlist,
        denylistPaths: denylist,
        branchPrefix: String(repo.branchPrefix ?? "content/"),
        preflightCmd: String(
          (repo.preflight as { cmd?: string } | undefined)?.cmd ?? "npm run validate"
        ),
        audit,
        log,
      })
    );
  }, "github-engineer: engineer_run tool");

  // 3. Register loopback HTTP routes.
  ctx.effect(() => {
    let disposers: Array<() => void> = [];
    const dispose = whenService(
      serviceGetter(ctx, "webServer"),
      () => {
        const ws = safeAccess(serviceGetter(ctx, "webServer")) as {
          register: (route: unknown) => () => void;
        };
        disposers = makeRoutes({ store, flow }).map((r) => ws.register(r));
        return () => disposers.forEach((d) => d());
      },
      () =>
        logger.warn(
          "github-engineer: `webServer` never became available; the Settings panel routes were not registered"
        )
    );
    return () => {
      dispose();
      disposers.forEach((d) => d());
    };
  }, "github-engineer: routes");

  // 4. Announce to the agent via a system prompt section.
  ctx.effect(() => {
    const paths = Object.values(API).join(", ");
    return whenService(
      serviceGetter(ctx, "systemPrompt"),
      () => (safeAccess(serviceGetter(ctx, "systemPrompt")) as {
        section: (s: unknown) => () => void;
      }).section({
      name: `plugin:${PLUGIN_ID}`,
      order: SYSTEM_PROMPT_SECTION_ORDER,
      text:
        `本机已安装 ${PLUGIN_DISPLAY_NAME} 插件（GitHub 仓库工程脚手架，plugin_id=${PLUGIN_ID}）。` +
        "Agent tools: engineer_status（查看状态）、engineer_oauth_start（发起 Device Flow）、" +
        "engineer_oauth_finish（轮询 token）、engineer_oauth_refresh（主动刷新）、engineer_oauth_revoke（撤销）。" +
        `Loopback HTTP routes: ${paths}。`,
      }),
      () =>
        logger.warn(
          "github-engineer: `systemPrompt` never became available; the agent announcement was not registered"
        )
    );
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
        } catch (err) {
          logger.error(
            `github-engineer: refresh watchdog threw: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      })();
    }, 60_000);
    handle.unref();
    return () => clearInterval(handle);
  }, "github-engineer: refresh watchdog");

  // 6. Spawn the MCP server and re-publish its tools.
  ctx.effect(() => {
    if (!existsSync(pathToConnect)) {
      logger.warn(
        `github-engineer: mcp-server entry not found at ${pathToConnect}; skipping MCP spawn. Run \`pnpm build\` inside mcp-server/.`
      );
      return () => {};
    }
    const client = new Client(
      { name: PLUGIN_DISPLAY_NAME, version: "0.1.0" },
      { capabilities: {} }
    );
    (async () => {
      try {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [pathToConnect],
          env: { ...extendedEnv(), ...mcpBindingEnv(binding, workingDir) },
        });
        await client.connect(transport);
        const { tools } = await client.request(
          { method: "tools/list" },
          ListToolsResultSchema
        );
        logger.info(
          `github-engineer: MCP server connected, ${tools.length} tool(s) discovered`
        );
        const disposers: Array<() => void> = [];
        for (const tool of tools) {
          const publicName = publicToolName(tool.name);
          const dispose = ctx.tools.register(
            defineTool({
              name: publicName,
              description: tool.description ?? "",
              parameters: {
                __mcp_raw: { type: "json", required: true },
              } as never,
              output: {
                schema: { type: "json" },
                render(_args, value) {
                  const v = (value ?? {}) as Record<string, unknown>;
                  return [{ type: "text" as const, text: extractText(v.content, tool.name) }];
                },
              },
              async execute(args, exec) {
                const forwardArgs = (args ?? {}) as Record<string, unknown>;
                const result = (await client.request(
                  {
                    method: "tools/call",
                    params: { name: tool.name, arguments: forwardArgs },
                  },
                  undefined as never,
                  { signal: exec.signal, timeout: 30_000 }
                )) as { content?: unknown; isError?: boolean };
                if (result.isError === true) {
                  throw new Error(extractText(result.content, tool.name));
                }
                return { content: Array.isArray(result.content) ? result.content : [] };
              },
            })
          );
          disposers.push(dispose);
        }
        return () => {
          for (const d of disposers) d();
          client.close().catch(() => {});
        };
      } catch (err) {
        logger.error(
          `github-engineer: failed to start MCP server: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return () => {};
      }
    })();
    return () => {};
  }, "github-engineer: mcp bridge");
}

/** Helper used by tests / docs. */
export async function ensureWorkspace(_dir: string): Promise<void> {
  await mkdir(_dir, { recursive: true });
}

// Re-export the cordis service identifier so consumers can import it.
export const name = PLUGIN_ID;
export const inject = CORDIS_INJECT;

// Re-export auth internals for tests and the upcoming MCP bridge.
// (The MCP child process imports from this same bundle via the lib
//  entry — see NEXT-STEPS.md "Settings web panel".)
export { TokenStore } from "./auth/token-store.js";
export { DeviceFlow } from "./auth/device-flow.js";
export { makeRoutes, API } from "./routes.js";