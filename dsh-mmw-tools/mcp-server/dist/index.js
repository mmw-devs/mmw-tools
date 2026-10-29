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
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { PLUGIN_DISPLAY_NAME, PLUGIN_VERSION } from "./const.js";
import { repoStatus } from "./tools/repo-status.js";
import { repoClone } from "./tools/repo-clone.js";
import { repoPull } from "./tools/repo-pull.js";
import { repoRead } from "./tools/repo-read.js";
import { repoSearch } from "./tools/repo-search.js";
import { repoEdit } from "./tools/repo-edit.js";
import { prCreate } from "./tools/pr-create.js";
import { prList } from "./tools/pr-list.js";
import { prMerge } from "./tools/pr-merge.js";
import { GithubRefusedError, redactTokens, } from "./guard.js";
const server = new Server({ name: PLUGIN_DISPLAY_NAME, version: PLUGIN_VERSION }, { capabilities: { tools: {} } });
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
function readTokenFromStore() {
    const file = process.env.GHOST_TOKEN_FILE;
    if (!file)
        return null;
    try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        return typeof raw.accessToken === "string" && raw.accessToken.length > 0
            ? raw.accessToken
            : null;
    }
    catch {
        return null;
    }
}
function config() {
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
    };
}
const TOOLS = [
    {
        name: "repo_status",
        description: "报告已克隆工作副本的当前状态：分支、是否有未提交变更、HEAD SHA、未提交文件列表。",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        call: () => repoStatus({}),
    },
    {
        name: "repo_clone",
        description: "把绑定的仓库克隆到 working_dir，使用 --depth 1 + base branch。需要 force=true 才能在已存在 .git 的目录上重做。",
        inputSchema: {
            type: "object",
            properties: { force: { type: "boolean" } },
            required: [],
            additionalProperties: false,
        },
        call: (input) => repoClone({ force: input.force }, config()),
    },
    {
        name: "repo_pull",
        description: "在指定分支上从 origin 拉取最新变更（用 --rebase）。如果 working tree 有未提交变更则拒绝。",
        inputSchema: {
            type: "object",
            properties: {
                branch: { type: "string" },
                rebase: { type: "boolean" },
            },
            required: [],
            additionalProperties: false,
        },
        call: (input) => repoPull({
            branch: input.branch,
            rebase: input.rebase,
        }, config()),
    },
    {
        name: "repo_read",
        description: "读取工作副本中的单个文件。max_bytes 默认 100 KiB，硬上限 500 KiB。检测到二进制（NUL 字节）则拒绝。",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对 working_dir 的路径" },
                max_bytes: { type: "number", description: "可选截断" },
            },
            required: ["path"],
            additionalProperties: false,
        },
        call: (input) => repoRead({
            path: input.path,
            max_bytes: input.max_bytes,
        }, config()),
    },
    {
        name: "repo_search",
        description: "在 working copy 里用 git grep 搜索。返回 (path, line, snippet) 三元组列表。max_results 默认 50。",
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
        call: (input) => repoSearch({
            query: input.query,
            glob: input.glob,
            max_results: input.max_results,
        }, config()),
    },
    {
        name: "repo_edit",
        description: "在 content/* 分支上批量编辑文件，跑 preflight 命令，commit。不 push — push 在 pr_create 里。",
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
        call: (input) => repoEdit({
            branch: input.branch,
            edits: input.edits,
            commit_message: input.commit_message,
        }, config()),
    },
    {
        name: "pr_create",
        description: "推送当前 content/* 分支并创建一个 draft PR（CI + 人工 review 是合并入口；本插件不自动合）。",
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
        call: (input) => prCreate({
            head_branch: input.head_branch,
            title: input.title,
            body: input.body,
            draft: input.draft,
            base: input.base,
        }, config()),
    },
    {
        name: "pr_list",
        description: "列出仓库里现有的 PR（默认 state=open）。返回 number/title/state/head/base/url。",
        inputSchema: {
            type: "object",
            properties: {
                state: { type: "string", enum: ["open", "closed", "all"] },
                base: { type: "string" },
            },
            required: [],
            additionalProperties: false,
        },
        call: (input) => prList({
            state: input.state,
            base: input.base,
        }, config()),
    },
    {
        name: "pr_merge",
        description: "合并一个 PR。必须由用户明确要求后才调用 —— 宿主会在执行前弹出确认，未确认则不会合并。" +
            "仅合并 content/* 分支的 PR；是否可合并以 GitHub 的分支保护结论（mergeStateStatus）为准。",
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
        call: (input) => prMerge({
            pr_number: input.pr_number,
            merge_method: input.merge_method,
            commit_title: input.commit_title,
        }, config()),
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
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
    }
    try {
        const result = await tool.call((args ?? {}));
        return {
            content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
            ],
        };
    }
    catch (err) {
        if (err instanceof GithubRefusedError) {
            // Refusal: send back the code + message via MCP isError=true so
            // the host bundle's extractText surfaces the reason to the agent.
            const message = `[${err.code}] ${err.message}`;
            return {
                isError: true,
                content: [{ type: "text", text: redactTokens(message) }],
            };
        }
        // Unexpected error: log to stderr (visible to the operator, not
        // to the LLM), then return a generic message.
        console.error(`tool ${name} crashed:`, err);
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: `internal error in ${name}: ${err.message ?? String(err)}`,
                },
            ],
        };
    }
});
const transport = new StdioServerTransport();
await server.connect(transport);
