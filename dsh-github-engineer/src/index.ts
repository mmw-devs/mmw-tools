/**
 * dsh-github-engineer — bundle entry (skeleton v0.1.0).
 *
 * The skeleton only does two things:
 *
 *   1. Register one agent-side tool, `engineer_status`, that reports
 *      whether the plugin loaded and which OAuth App + repo binding it
 *      is wired to.
 *
 *   2. Spawn the MCP server (currently a one-tool echo server) as a
 *      stdio child and re-publish its `tools/list` as agent tools
 *      under the `mcp__github_engineer__` namespace.
 *
 * NOT in this skeleton (subsequent increments):
 *   - OAuth Device Flow state machine
 *   - token store / keychain
 *   - settings web panel
 *   - repo_clone / repo_edit / pr_create / etc.
 *   - engineer_run high-level wrapper
 *
 * See docs/dsh-github-engineer-design.md for the full plan.
 */
import { defineTool, type InferArgs, type InferValue } from "@deepseek-ai/dsh-tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/** Stable cordis plugin name. */
export const name = "github-engineer";

/** Cordis services this plugin depends on. */
export const inject = ["tools", "systemPrompt", "logger"];

/** Where the MCP server lives (relative to this bundle's dist). */
const MCP_SERVER_ENTRY = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "mcp-server",
  "dist",
  "index.js"
);

/** Sanitize a raw MCP tool name into a model-facing DSH agent name. */
function publicToolName(rawName: string): string {
  const prefix = "mcp__github_engineer__";
  const sanitized = rawName.replace(/[^A-Za-z0-9_-]/g, "_");
  return prefix + sanitized;
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
    oauthClientIdMasked: { type: "string" as const },
    repoOwner: { type: "string" as const },
    repoName: { type: "string" as const },
    baseBranch: { type: "string" as const },
    defaultScopes: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    mcpServerPath: { type: "string" as const },
  },
};

function makeStatusTool(deps: {
  oauthClientId: string;
  repo: Record<string, unknown>;
  scopes: string[];
}) {
  return defineTool({
    name: "engineer_status",
    description:
      "查看 dsh-github-engineer 插件状态：是否已挂载、配置了哪个 repo binding 与 GitHub OAuth App ID、MCP server 是否可达、已注册的 mcp__github_engineer__* 工具数量。不会泄露任何密钥。",
    parameters: STATUS_PARAMS,
    output: {
      schema: STATUS_OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: "text", text: String(value.message ?? "") }];
      },
    },
    async execute() {
      const oauthMasked = deps.oauthClientId
        ? deps.oauthClientId.slice(0, 6) + "****"
        : "";
      return {
        ok: true,
        message:
          `dsh-github-engineer 已挂载。\n` +
          `OAuth App: ${oauthMasked || "(未设置 — 把 cordis.patch.yml 里的 githubOAuthClientId 换成真实的)"}\n` +
          `Repo binding: ${String(deps.repo.owner ?? "?")}/${String(deps.repo.name ?? "?")} (${String(deps.repo.baseBranch ?? "main")})\n` +
          `Allowed paths: ${Array.isArray(deps.repo.allowlistPaths) ? deps.repo.allowlistPaths.join(", ") : "(空)"}\n` +
          `Default scopes: ${deps.scopes.join(" ") || "(空)"}\n` +
          `MCP server entry: ${pathToConnect}\n` +
          `\n下一步：注册 GitHub OAuth App + 填 client_id + 实现 OAuth Device Flow（见 docs/NEXT-STEPS.md）。`,
        oauthClientIdMasked: oauthMasked,
        repoOwner: String(deps.repo.owner ?? ""),
        repoName: String(deps.repo.name ?? ""),
        baseBranch: String(deps.repo.baseBranch ?? "main"),
        defaultScopes: deps.scopes,
        mcpServerPath: pathToConnect,
      };
    },
  });
}

/** Where MCP server lives — exposed for tests / docs. */
export const pathToConnect = MCP_SERVER_ENTRY;

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

  // 1. Register the high-level agent tool.
  ctx.effect(() => {
    return ctx.tools.register(makeStatusTool({ oauthClientId, repo, scopes }));
  }, "github-engineer: status tool");

  // 2. Announce to the agent via a system prompt section.
  ctx.effect(() => {
    return ctx.systemPrompt.section({
      name: "plugin:github-engineer",
      order: 210,
      text:
        "本机已安装 dsh-github-engineer 插件（GitHub 仓库工程脚手架）。" +
        "骨架阶段：仅提供 engineer_status 工具与一个 mcp__github_engineer__echo 探针工具。" +
        "完整功能（OAuth Device Flow + 拉仓库 + 改 public/data.json + 推 content/* 分支 + 开 PR + 本地 npm run validate 强校验）" +
        "在后续增量中实现。",
    });
  }, "github-engineer: section");

  // 3. Spawn the MCP server and re-publish its tools.
  ctx.effect(() => {
    if (!existsSync(MCP_SERVER_ENTRY)) {
      ctx.logger.warn(
        `github-engineer: mcp-server entry not found at ${MCP_SERVER_ENTRY}; skipping MCP spawn. Run \`pnpm build\` inside mcp-server/.`
      );
      return () => {};
    }
    const client = new Client(
      { name: "dsh-github-engineer", version: "0.1.0" },
      { capabilities: {} }
    );
    (async () => {
      try {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [MCP_SERVER_ENTRY],
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
              // Raw JSON Schema coming from MCP — feed through as-is via `json`
              // node, so the strict dsh-tools schema validator accepts it.
              parameters: {
                __mcp_raw: {
                  type: "json",
                  required: true,
                } as never,
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
                // The "args" here is whatever the model produced; we forward it
                // as a JSON object to the MCP tool.
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
                } as unknown as InferValue<typeof STATUS_OUTPUT_SCHEMA>;
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
    // Return a disposer that does nothing if the async block hasn't resolved yet;
    // the async block will install its own disposer on success.
    return () => {};
  }, "github-engineer: mcp bridge");
}

/** Helper used by tests / docs. */
export async function ensureWorkspace(_dir: string): Promise<void> {
  await mkdir(_dir, { recursive: true });
}