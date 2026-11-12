/**
 * dsh-mmw-tools MCP server — entry.
 *
 * Registers the seven tools defined in src/tools/. Each tool is a
 * standalone function that takes (input, config) and returns a typed
 * object. The dispatcher below is plain JSON-RPC over stdio; it
 * dispatches `tools/list` and `tools/call` to the tool functions,
 * converts errors to MCP `isError: true` responses, and shapes the
 * output per the host bundle's `extractText` reader.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PLUGIN_DISPLAY_NAME, PLUGIN_VERSION } from "./const.js";

import { repoStatus } from "./tools/repo-status.js";
import { repoClone } from "./tools/repo-clone.js";
import { repoPull } from "./tools/repo-pull.js";
import { repoRead } from "./tools/repo-read.js";
import { repoSearch } from "./tools/repo-search.js";
import { repoEdit } from "./tools/repo-edit.js";
import { prCreate } from "./tools/pr-create.js";
import { prClose } from "./tools/pr-close.js";
import { prList } from "./tools/pr-list.js";
import { prMerge } from "./tools/pr-merge.js";
import { prPreview } from "./tools/pr-preview.js";
import {
  GithubRefusedError,
  redactTokens,
} from "./guard.js";

const server = new Server(
  { name: PLUGIN_DISPLAY_NAME, version: PLUGIN_VERSION },
  { capabilities: { tools: {} } }
);

/* ============================================================== */
/*  Tool registry                                                  */
/* ============================================================== */

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (input: Record<string, unknown>, cfg: McpConfig) => Promise<unknown>;
}

/** Every repository the host made selectable, plus its resolved env. */
interface RepoEnv {
  key: string;
  owner: string;
  name: string;
  repoUrl: string;
  workingDir: string;
  tokenFile: string;
  baseBranch: string;
  branchPrefix: string;
  allowlistPaths: string[];
  denylistPaths: string[];
  preflight: { cmd: string; timeoutSeconds: number };
  bootstrap: { cmd: string; whenMissing: string; timeoutSeconds: number };
}

export interface McpConfig {
  repo?: string;
  workingDir: string;
  repoUrl: string;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  branchPrefix: string;
  allowlistPaths: string[];
  denylistPaths: string[];
  preflight: { cmd: string; timeoutSeconds: number };
  bootstrap: { cmd: string; whenMissing: string; timeoutSeconds: number };
  githubToken: string | null;
  brokerUrl: string;
  writeAuthFile: string;
}

/**
 * Read the current access token from the host's token store.
 *
 * The child is long-lived while access tokens last 8 hours, so a token
 * copied into the environment at spawn time goes stale mid-session. The
 * host therefore passes `GHOST_TOKEN_FILE` (the store path) and this
 * reads it per call, which means a host-side refresh is picked up
 * without restarting the child. `GHOST_TOKEN` remains supported as a
 * static fallback for tests.
 */
function readTokenFromStore(file = process.env.GHOST_TOKEN_FILE): string | null {
  if (!file) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { accessToken?: unknown };
    return typeof raw.accessToken === "string" && raw.accessToken.length > 0
      ? raw.accessToken
      : null;
  } catch {
    return null;
  }
}

function config(): McpConfig {
  return {
    workingDir: process.env.GHOST_WORKING_DIR ?? "",
    repoUrl: process.env.GHOST_REPO_URL ?? "",
    repoOwner: process.env.GHOST_REPO_OWNER ?? "",
    repoName: process.env.GHOST_REPO_NAME ?? "",
    baseBranch: process.env.GHOST_BASE_BRANCH ?? "main",
    branchPrefix: process.env.GHOST_BRANCH_PREFIX ?? "content/",
    allowlistPaths: (process.env.GHOST_ALLOWLIST ?? "public/data.json").split(","),
    denylistPaths: (process.env.GHOST_DENYLIST ?? ".github/workflows/**,schema/**,scripts/**,constants.js,AGENTS.md,README.md,.pi/**,dist/**").split(","),
    preflight: {
      cmd: process.env.GHOST_PREFLIGHT_CMD ?? "npm run validate",
      timeoutSeconds: Number(process.env.GHOST_PREFLIGHT_TIMEOUT ?? 60),
    },
    bootstrap: {
      // Runs once per working directory when `whenMissing` is absent.
      // `npm run validate` needs devDependencies, and a fresh clone has
      // none, so without this every commit is refused by its own
      // pre-flight with "tsx: not found".
      cmd: process.env.GHOST_BOOTSTRAP_CMD ?? "",
      whenMissing: process.env.GHOST_BOOTSTRAP_WHEN_MISSING ?? "node_modules",
      timeoutSeconds: Number(process.env.GHOST_BOOTSTRAP_TIMEOUT ?? 300),
    },
    githubToken: readTokenFromStore() ?? process.env.GHOST_TOKEN ?? null,
    brokerUrl: process.env.MMW_BROKER_URL ?? "",
    writeAuthFile: process.env.MMW_WRITE_AUTH_FILE ?? "",
  };
}

/**
 * Parse the host's `MMW_REPOS` table once per process.
 *
 * The child has no session state: the gate already decided, and forwards the
 * selected `owner/name` in `_meta`. An entry that does not resolve stays
 * absent, so `configFor` can refuse instead of falling back to the default.
 */
function parseRepoTable(): Map<string, RepoEnv> {
  const table = new Map<string, RepoEnv>();
  const raw = process.env.MMW_REPOS;
  if (!raw) return table;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return table;
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      if (typeof r.key !== "string" || typeof r.owner !== "string" || typeof r.name !== "string") continue;
      const preflight = (r.preflight ?? {}) as Record<string, unknown>;
      const bootstrap = (r.bootstrap ?? {}) as Record<string, unknown>;
      table.set(r.key.toLowerCase(), {
        key: r.key.toLowerCase(),
        owner: r.owner,
        name: r.name,
        repoUrl: typeof r.repoUrl === "string" ? r.repoUrl : "",
        workingDir: typeof r.workingDir === "string" ? r.workingDir : "",
        tokenFile: typeof r.tokenFile === "string" ? r.tokenFile : "",
        baseBranch: typeof r.baseBranch === "string" ? r.baseBranch : "main",
        branchPrefix: typeof r.branchPrefix === "string" ? r.branchPrefix : "content/",
        allowlistPaths: Array.isArray(r.allowlist) ? (r.allowlist as string[]) : [],
        denylistPaths: Array.isArray(r.denylist) ? (r.denylist as string[]) : [],
        preflight: {
          cmd: typeof preflight.cmd === "string" ? preflight.cmd : "npm run validate",
          timeoutSeconds:
            typeof preflight.timeoutSeconds === "number" ? preflight.timeoutSeconds : 60,
        },
        bootstrap: {
          cmd: typeof bootstrap.cmd === "string" ? bootstrap.cmd : "",
          whenMissing:
            typeof bootstrap.whenMissing === "string" ? bootstrap.whenMissing : "node_modules",
          timeoutSeconds:
            typeof bootstrap.timeoutSeconds === "number" ? bootstrap.timeoutSeconds : 300,
        },
      });
    }
  } catch {
    /* malformed table: every explicit repo is refused below */
  }
  return table;
}

const REPO_TABLE = parseRepoTable();

/**
 * The host's repo cache records the rules read from `.dsh-mmw-tools.yaml`
 * on the last `select_repo`. The MCP child is long-lived, so it re-reads
 * this file per call instead of relying on the environment captured at
 * spawn time.
 */
interface CachedRepoRules {
  branchPrefix?: string;
  allowlistPaths?: string[];
  denylistPaths?: string[];
  preflight?: { cmd?: unknown; timeoutSeconds?: unknown };
  bootstrap?: { cmd?: unknown; whenMissing?: unknown; timeoutSeconds?: unknown };
}

function cachedRepoRules(repoKey: string): CachedRepoRules | null {
  const file =
    process.env.DSH_MMW_TOOLS_REPOS_CACHE ??
    path.join(homedir(), ".dsh", "mmw-tools-repos.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { repos?: unknown };
    if (!Array.isArray(parsed.repos)) return null;
    const entry = (parsed.repos as CachedRepoRules[]).find(
      (item) => String((item as any).key ?? "").toLowerCase() === repoKey
    );
    return entry ?? null;
  } catch {
    return null;
  }
}

function cachedCommand(
  value: { cmd?: unknown; timeoutSeconds?: unknown } | undefined,
  fallback: { cmd: string; timeoutSeconds: number }
): { cmd: string; timeoutSeconds: number } {
  if (!value || typeof value.cmd !== "string") return fallback;
  return {
    cmd: value.cmd,
    timeoutSeconds:
      typeof value.timeoutSeconds === "number" && value.timeoutSeconds > 0
        ? value.timeoutSeconds
        : fallback.timeoutSeconds,
  };
}

/** Resolve the selected repository; unknown names are refused, not defaulted. */
function configFor(repoKey?: string): McpConfig {
  const base = config();
  if (!repoKey) return base;
  const entry = REPO_TABLE.get(repoKey);
  if (!entry) {
    throw new GithubRefusedError(
      "mmw_route_denied",
      `未知仓库 ${repoKey}；可用仓库：${[...REPO_TABLE.keys()].join(", ") || "（未配置）"}`
    );
  }
  const cached = cachedRepoRules(repoKey);
  return {
    ...base,
    repo: entry.key,
    workingDir: entry.workingDir,
    repoUrl: entry.repoUrl,
    repoOwner: entry.owner,
    repoName: entry.name,
    baseBranch: entry.baseBranch,
    branchPrefix: cached?.branchPrefix ?? entry.branchPrefix,
    allowlistPaths: cached?.allowlistPaths ?? entry.allowlistPaths,
    denylistPaths: cached?.denylistPaths ?? entry.denylistPaths,
    preflight: cachedCommand(cached?.preflight, entry.preflight),
    bootstrap: {
      ...cachedCommand(cached?.bootstrap, entry.bootstrap),
      whenMissing:
        typeof cached?.bootstrap?.whenMissing === "string"
          ? cached.bootstrap.whenMissing
          : entry.bootstrap.whenMissing,
    },
    githubToken: readTokenFromStore(entry.tokenFile) ?? base.githubToken,
  };
}

const TOOLS: ToolDef[] = [
  {
    name: "repo_status",
    description:
      "报告已克隆工作副本的当前状态：分支、是否有未提交变更、HEAD SHA、未提交文件列表。",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    call: (_input, cfg) => repoStatus({}, cfg),
  },
  {
    name: "repo_clone",
    description:
      "把绑定的仓库克隆到 working_dir，使用 --depth 1 + base branch。需要 force=true 才能在已存在 .git 的目录上重做。",
    inputSchema: {
      type: "object",
      properties: { force: { type: "boolean" } },
      required: [],
      additionalProperties: false,
    },
    call: (input, cfg) => repoClone({ force: input.force as boolean | undefined }, cfg),
  },
  {
    name: "repo_pull",
    description:
      "在指定分支上从 origin 拉取最新变更（用 --rebase）。如果 working tree 有未提交变更则拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string" },
        rebase: { type: "boolean" },
      },
      required: [],
      additionalProperties: false,
    },
    call: (input, cfg) =>
      repoPull(
        {
          branch: input.branch as string | undefined,
          rebase: input.rebase as boolean | undefined,
        },
        cfg
      ),
  },
  {
    name: "repo_read",
    description:
      "读取工作副本中的单个文件。max_bytes 默认 100 KiB，硬上限 500 KiB。检测到二进制（NUL 字节）则拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 working_dir 的路径" },
        max_bytes: { type: "number", description: "可选截断" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    call: (input, cfg) =>
      repoRead(
        {
          path: input.path as string,
          max_bytes: input.max_bytes as number | undefined,
        },
        cfg
      ),
  },
  {
    name: "repo_search",
    description:
      "在 working copy 里用 git grep 搜索。返回 (path, line, snippet) 三元组列表。max_results 默认 50。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "正则表达式" },
        glob: { type: "string", description: "可选路径 glob" },
        max_results: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    call: (input, cfg) =>
      repoSearch(
        {
          query: input.query as string,
          glob: input.glob as string | undefined,
          max_results: input.max_results as number | undefined,
        },
        cfg
      ),
  },
  {
    name: "repo_edit",
    description:
      "在 content/* 分支上批量编辑文件，跑 preflight 命令，commit。不 push — push 在 pr_create 里。",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "目标分支名（必须以 content/ 开头）" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              mode: { type: "string", enum: ["replace", "insert", "patch"] },
              find: { type: "string" },
              replace: { type: "string" },
              content: { type: "string" },
              patch: { type: "string" },
            },
            required: ["path", "mode"],
            additionalProperties: false,
          },
        },
        commit_message: { type: "string" },
      },
      required: ["branch", "edits", "commit_message"],
      additionalProperties: false,
    },
    call: (input, cfg) =>
      repoEdit(
        {
          branch: input.branch as string,
          edits: input.edits as Parameters<typeof repoEdit>[0]["edits"],
          commit_message: input.commit_message as string,
        },
        cfg
      ),
  },
  {
    name: "pr_create",
    description:
      "推送当前 content/* 分支并创建一个 draft PR（CI + 人工 review 是合并入口；本插件不自动合）。",
    inputSchema: {
      type: "object",
      properties: {
        head_branch: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        draft: { type: "boolean" },
        base: { type: "string" },
      },
      required: ["head_branch", "title", "body"],
      additionalProperties: false,
    },
    call: (input, cfg) =>
      prCreate(
        {
          head_branch: input.head_branch as string,
          title: input.title as string,
          body: input.body as string,
          draft: input.draft as boolean | undefined,
          base: input.base as string | undefined,
        },
        cfg
      ),
  },
  {
    name: "pr_close",
    description:
      "关闭一个 content/* 分支的 PR，不合并。宿主会在执行前弹出确认。用于放弃不再需要的 PR，" +
      "让 open 队列保持可运营；已经关闭或已合并的 PR 返回 already=true。",
    inputSchema: {
      type: "object",
      properties: {
        pr_number: { type: "number" },
      },
      required: ["pr_number"],
      additionalProperties: false,
    },
    call: (input, cfg) =>
      prClose(
        {
          pr_number: input.pr_number as number,
        },
        cfg
      ),
  },
  {
    name: "pr_list",
    description:
      "列出仓库里现有的 PR（默认 state=open）。返回 number/title/state/head/base/url。",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed", "all"] },
        base: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
    call: (input, cfg) =>
      prList(
        {
          state: input.state as "open" | "closed" | "all" | undefined,
          base: input.base as string | undefined,
        },
        cfg
      ),
  },
  {
    name: "pr_preview",
    description:
      "读取一个 PR 的预览地址和检查状态：从 Cloudflare Pages 的 check 里取 Preview URL（对应提交）与" +
      " Branch Preview URL（对应分支，给用户看这个），并返回 checks/is_draft/merge_state。" +
      "只读，不改动任何东西。刚创建 PR 时 CI 还没跑完，传 wait_seconds（例如 60）等它出现。",
    inputSchema: {
      type: "object",
      properties: {
        pr_number: { type: "number" },
        wait_seconds: { type: "number" },
      },
      required: ["pr_number"],
      additionalProperties: false,
    },
    call: (input, cfg) =>
      prPreview(
        {
          pr_number: input.pr_number as number,
          wait_seconds: input.wait_seconds as number | undefined,
        },
        cfg
      ),
  },
  {
    name: "pr_merge",
    description:
      "合并一个 PR。必须由用户明确要求后才调用 —— 宿主会在执行前弹出确认，未确认则不会合并。" +
      "仅合并 content/* 分支的 PR；是否可合并以 GitHub 的分支保护结论（mergeStateStatus）为准。" +
      "若仓库有 contract/operations.json，PR 提交的 op-log command 属于 agentMerge=false 的级别（如 L3）时会拒绝合并。",
    inputSchema: {
      type: "object",
      properties: {
        pr_number: { type: "number" },
        merge_method: { type: "string", enum: ["merge", "squash", "rebase"] },
        commit_title: { type: "string" },
      },
      required: ["pr_number"],
      additionalProperties: false,
    },
    call: (input, cfg) =>
      prMerge(
        {
          pr_number: input.pr_number as number,
          merge_method: input.merge_method as undefined,
          commit_title: input.commit_title as string | undefined,
        },
        cfg
      ),
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  // The host passes the gate's run id in `_meta`; keep it only if it looks
  // like one of ours so a malformed id cannot inject into logs or output.
  const meta = (request.params as { _meta?: { mmwRunId?: unknown; mmwRepo?: unknown } })._meta;
  const runId =
    typeof meta?.mmwRunId === "string" && /^run_[A-Za-z0-9-]{1,80}$/.test(meta.mmwRunId)
      ? meta.mmwRunId
      : undefined;
  const repoKey =
    typeof meta?.mmwRepo === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(meta.mmwRepo)
      ? meta.mmwRepo.toLowerCase()
      : undefined;
  const runSuffix = runId ? ` [${runId}]` : "";
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  try {
    const result = await tool.call((args ?? {}) as Record<string, unknown>, configFor(repoKey));
    return {
      content: [
        { type: "text", text: JSON.stringify(result, null, 2) },
      ],
    };
  } catch (err) {
    if (err instanceof GithubRefusedError) {
      // Refusal: send back the code + message via MCP isError=true so
      // the host bundle's extractText surfaces the reason to the agent.
      const message = `[${err.code}] ${err.message}${runSuffix}`;
      return {
        isError: true,
        content: [{ type: "text", text: redactTokens(message) }],
      };
    }
    // Unexpected error: log to stderr (visible to the operator, not
    // to the LLM), then return a generic message.
    console.error(`tool ${name}${runSuffix} crashed:`, err);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `internal error in ${name}${runSuffix}: ${(err as Error).message ?? String(err)}`,
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);