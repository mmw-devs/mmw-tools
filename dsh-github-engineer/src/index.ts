/**
 * dsh-github-engineer — bundle entry (skeleton v0.1.0).
 *
 * Two visible agent-facing surfaces plus one runtime guard:
 *
 *   1. `engineer_status` — high-level tool reporting plugin state.
 *   2. `mcp__github_engineer__*` — auto-discovered from the MCP
 *      server child process.
 *   3. AGENTS.md drift check — fires once on bundle apply; warns if
 *      the cached `cordis.patch.yml` rules and the live AGENTS.md in
 *      the bound repo disagree. See docs/OPERATIONS-SYNC.md.
 *
 * NOT in this skeleton (subsequent increments per docs/NEXT-STEPS.md):
 *   - OAuth Device Flow state machine
 *   - Token store / keychain
 *   - Settings web panel
 *   - repo_clone / repo_edit / pr_create / etc.
 *   - engineer_run high-level wrapper
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

/* ============================================================== */
/*  engineer_status: high-level status tool                        */
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

function makeStatusTool(deps: {
  oauthClientId: string;
  repo: Record<string, unknown>;
  scopes: string[];
  agentsMdDrift: ReturnType<typeof checkAgentsMd> | null;
}) {
  return defineTool({
    name: "engineer_status",
    description:
      "查看 dsh-github-engineer 插件状态：是否已挂载、配置了哪个 repo binding 与 GitHub OAuth App ID、MCP server 路径、AGENTS.md 是否与 cordis.patch.yml 一致。不会泄露任何密钥。",
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
      const drift = deps.agentsMdDrift;
      const driftLine = drift
        ? drift.unavailable
          ? `AGENTS.md drift: 暂无法拉取（首次连接 GitHub 后会自动校准）`
          : drift.ok
          ? `AGENTS.md drift: OK`
          : `AGENTS.md drift: ⚠️ 不一致 — 详情见 dsh web 日志`
        : `AGENTS.md drift: 未检查（OAuth 未完成）`;
      return {
        ok: true,
        message:
          `${PLUGIN_DISPLAY_NAME} 已挂载（plugin_id=${PLUGIN_ID}）。\n` +
          `OAuth App: ${oauthMasked}\n` +
          `Repo binding: ${String(deps.repo.owner ?? "?")}/${String(deps.repo.name ?? "?")} (${String(deps.repo.baseBranch ?? "main")})\n` +
          `Allowed paths: ${Array.isArray(deps.repo.allowlistPaths) ? deps.repo.allowlistPaths.join(", ") : "(空)"}\n` +
          `Default scopes: ${deps.scopes.join(" ") || "(空)"}\n` +
          `MCP server entry: ${pathToConnect}\n` +
          `${driftLine}\n` +
          `\n下一步：实现 OAuth Device Flow（见 docs/NEXT-STEPS.md）。`,
        pluginId: PLUGIN_ID,
        oauthClientIdMasked: deps.oauthClientId
          ? `${deps.oauthClientId.slice(0, 6)}****`
          : "",
        repoOwner: String(deps.repo.owner ?? ""),
        repoName: String(deps.repo.name ?? ""),
        baseBranch: String(deps.repo.baseBranch ?? "main"),
        defaultScopes: deps.scopes,
        mcpServerPath: pathToConnect,
        agentsMdDrift: drift ?? {
          ok: false,
          unavailable: true,
          summary: "未检查（OAuth 未完成或首次启动）",
          details: [],
        },
      };
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
}

export function apply(
  ctx: {
    tools: { register: (d: unknown) => () => void };
    systemPrompt: {
      section: (s: { name: string; order: number; text: string }) => () => void;
    };
    effect: (fn: () => () => void, label: string) => () => void;
    logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  },
  config?: BundleConfig
): void {
  const oauthClientId = config?.githubOAuthClientId ?? "";
  const repo = config?.repoBinding ?? {};
  const scopes: string[] = Array.isArray(config?.defaultScopes) ? config.defaultScopes : [];

  // AGENTS.md drift detection — fire once on apply. We do not have a
  // token yet at this point (OAuth hasn't run), so we attempt an
  // anonymous read of the public repo. If it fails, we mark
  // `unavailable: true` and let `engineer_status` surface that.
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
          null // no token yet
        );
        if (agentsMd === null) {
          agentsMdDrift = {
            ok: false,
            unavailable: true,
            details: [],
            summary: `无法拉取 AGENTS.md：${bindingLike.owner}/${bindingLike.name}@${String(
              repo.baseBranch ?? "main"
            )}（OAuth 未完成或仓库不可匿名访问）`,
          };
          ctx.logger.warn(`github-engineer: ${agentsMdDrift.summary}`);
        } else {
          const check = checkAgentsMd(bindingLike, agentsMd);
          agentsMdDrift = check;
          if (check.ok) {
            ctx.logger.info(`github-engineer: ${check.summary}`);
          } else {
            ctx.logger.warn(`github-engineer: ${check.summary}`);
          }
        }
      } catch (err) {
        ctx.logger.error(
          `github-engineer: AGENTS.md drift check threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    })();
    return () => {};
  }, "github-engineer: agents-md drift");

  // 1. Register the high-level agent tool.
  ctx.effect(() => {
    return ctx.tools.register(makeStatusTool({ oauthClientId, repo, scopes, agentsMdDrift }));
  }, "github-engineer: status tool");

  // 2. Announce to the agent via a system prompt section.
  ctx.effect(() => {
    return ctx.systemPrompt.section({
      name: `plugin:${PLUGIN_ID}`,
      order: SYSTEM_PROMPT_SECTION_ORDER,
      text:
        `本机已安装 ${PLUGIN_DISPLAY_NAME} 插件（GitHub 仓库工程脚手架，plugin_id=${PLUGIN_ID}）。` +
        "骨架阶段：仅提供 engineer_status 工具与一个 mcp__github-engineer__echo 探针工具。" +
        "完整功能（OAuth Device Flow + 拉仓库 + 改 public/data.json + 推 content/* 分支 + 开 PR + 本地 npm run validate 强校验）" +
        "在后续增量中实现。",
    });
  }, "github-engineer: section");

  // 3. Spawn the MCP server and re-publish its tools.
  ctx.effect(() => {
    if (!existsSync(pathToConnect)) {
      ctx.logger.warn(
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
          env: extendedEnv(),
        });
        await client.connect(transport);
        const { tools } = await client.request(
          { method: "tools/list" },
          ListToolsResultSchema
        );
        ctx.logger.info(
          `github-engineer: MCP server connected, ${tools.length} tool(s) discovered`
        );
        const disposers: Array<() => void> = [];
        for (const tool of tools) {
          const publicName = publicToolName(tool.name);
          const dispose = ctx.tools.register(
            defineTool({
              name: publicName,
              description: tool.description ?? "",
              // The MCP server's inputSchema is raw JSON Schema. The dsh-tools
              // `defineTool` accepts author-facing spec (a typed map); we
              // mark this as `json` to forward whatever the model sends.
              parameters: {
                __mcp_raw: {
                  type: "json",
                  required: true,
                },
              } as never,
              output: {
                schema: { type: "json" },
                render(_args, value) {
                  const v = (value ?? {}) as Record<string, unknown>;
                  return [
                    {
                      type: "text" as const,
                      text: extractText(v.content, tool.name),
                    },
                  ];
                },
              },
              async execute(args, exec) {
                const forwardArgs = (args ?? {}) as Record<string, unknown>;
                const result = (await client.request(
                  {
                    method: "tools/call",
                    params: {
                      name: tool.name,
                      arguments: forwardArgs,
                    },
                  },
                  undefined as never,
                  { signal: exec.signal, timeout: 30_000 }
                )) as { content?: unknown; isError?: boolean };
                if (result.isError === true) {
                  throw new Error(extractText(result.content, tool.name));
                }
                return {
                  content: Array.isArray(result.content) ? result.content : [],
                };
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
        ctx.logger.error(
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

// Re-export the cordis service identifier so consumers (tests, scripts)
// can import it without re-typing the literal.
export const name = PLUGIN_ID;
export const inject = CORDIS_INJECT;