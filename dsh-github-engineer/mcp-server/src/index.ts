/**
 * dsh-github-engineer MCP server — skeleton.
 *
 * Exposes a single `echo` tool over stdio JSON-RPC. This is the probe
 * that lets the parent DSH bundle verify the stdio transport, the
 * extended PATH, and the MCP tools/list → DSH tools.register pipeline.
 *
 * Real tools (repo_read / repo_edit / pr_create / etc.) are added in
 * subsequent increments per docs/dsh-github-engineer-design.md.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "dsh-github-engineer-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description:
        "探针工具：返回传入的参数。仅用于验证 MCP server 子进程可被 DSH bundle 启动并桥接，v1 完整功能（repo_read / repo_edit / pr_create）在后续增量中实现。",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "要原样返回的字符串" },
        },
        required: [],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "echo") {
    const message =
      typeof (args as Record<string, unknown>)?.message === "string"
        ? ((args as Record<string, unknown>).message as string)
        : "(no message)";
    return {
      content: [
        {
          type: "text",
          text: `echo: ${message}\n` +
            `env: REPO_OWNER=${process.env.REPO_OWNER ?? "(unset)"}, ` +
            `REPO_NAME=${process.env.REPO_NAME ?? "(unset)"}, ` +
            `GHOST_TOKEN=${process.env.GHOST_TOKEN ? "set" : "(unset)"}\n` +
            `cwd: ${process.cwd()}`,
        },
      ],
    };
  }
  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);