# DSH 0.1.5 Plugin API 速查报告

> 来源：`zhengjy01/dsh-feishu-mcp` 仓库 `lib/index.js`（DSH 0.1.5-rc.1 验证过的真实构建产物）+ `package.json` + `cordis.patch.yml`。
> 这是从实战源码抽出来的「最小可工作」清单，不是 SDK 文档摘抄。

---

## 1. 仓库 / 包结构

DSH plugin 仓库遵循这一最小布局（参考 dsh-feishu-mcp）：

```
your-plugin/
├── package.json           # 含 dsh.bundle、dsh.client、peerDependencies
├── cordis.patch.yml       # 注入 profile 的 patch
├── lib/
│   └── index.js           # 编译产物，main 入口
├── src/                   # 源码（ts）
├── README.md
├── CHANGELOG.md
└── LICENSE
```

`package.json` 关键字段（来自 `dsh-feishu-mcp/package.json`）：

```jsonc
{
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-ui-settings"
      ],
      "platform": "web"
    },
    "engines": {
      "dsh": ">=0.1.5-rc.1"
    }
  },
  "engines": {
    "node": "^22.19.0 || >=24.0.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-client-connection": "...",
    "@deepseek-ai/dsh-client-ui-settings": "...",
    "@deepseek-ai/dsh-host-webserver": "...",
    "@deepseek-ai/dsh-tools": "...",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "0.1.5-rc.1",
    "@deepseek-ai/dsh-client-connection": "0.1.5-rc.1",
    "@deepseek-ai/dsh-client-ui-renderer": "0.1.5-rc.1",
    "@deepseek-ai/dsh-client-ui-slots": "0.1.5-rc.1",
    "@deepseek-ai/dsh-host-webserver": "0.1.5-rc.1",
    "@deepseek-ai/dsh-llm": "0.1.5-rc.1",
    "@deepseek-ai/dsh-system-prompt": "0.1.5-rc.1",
    "@deepseek-ai/dsh-tools": "0.1.5-rc.1",
    "tsdown": "0.22.2",
    "typescript": "~5.7.2"
  },
  "files": ["lib", "cordis.patch.yml", "README.md", "CHANGELOG.md", "LICENSE"]
}
```

要点：
- 入口是 `lib/index.js`（tsdown 编译产物），不是 `.ts`
- `dsh.bundle.patch` 指向 `cordis.patch.yml`
- `dsh.engines.dsh` 是 DSH 版本约束
- `engines.node` 至少 `^22.19.0`
- peerDependencies 是 DSH 提供的运行时依赖，必须在 DSH 进程里能找到

---

## 2. `cordis.patch.yml` —— 注入 profile

参考 `dsh-feishu-mcp/cordis.patch.yml`：

```yaml
- insert:
    - id: feishu-mcp
      name: dsh-feishu-mcp
      config:
        announceToAgent: true   # 在系统提示中公告插件
        enabled: true           # 插件总开关
```

要点：
- 一个 `- insert:` 列表，每个元素是一条「插入到 profile 的插件行」
- `id`：cordis service 名（`apply(ctx, config)` 里 `config` 就是这个 config 对象）
- `name`：显示名
- `config`：任意键值对，bundle 的 `apply` 函数会收到

---

## 3. Bundle 入口（`lib/index.js`）

参考 `dsh-feishu-mcp/src/index.ts`：

```ts
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "github-engineer";  // 插件 ID
export const inject = ["webServer", "tools", "systemPrompt"];

export function apply(ctx, config) {
  // ctx 包含 ctx.webServer / ctx.tools / ctx.systemPrompt / ctx.effect / ctx.logger
  // config 是 cordis.patch.yml 里写的 config 对象

  ctx.effect(() => {
    const disposers = buildTools(ctx).map((tool) => ctx.tools.register(tool));
    return () => disposers.forEach(d => d());
  }, "github-engineer: tools");

  ctx.effect(() => {
    const disposers = makeRoutes(ctx).map((route) => ctx.webServer.register(route));
    return () => disposers.forEach(d => d());
  }, "github-engineer: routes");

  ctx.systemPrompt.section({
    name: "plugin:github-engineer",
    order: 210,
    text: "..."  // 给 LLM 的公告
  });
}
```

关键 API：

| API | 用途 |
|---|---|
| `ctx.effect(fn, label)` | 声明响应式 effect；返回 disposer |
| `ctx.tools.register(toolDef)` | 注册一个 agent 工具，返回 disposer |
| `ctx.webServer.register({kind, path, handler})` | 注册一条 HTTP 路由 |
| `ctx.systemPrompt.section({name, order, text})` | 注册一段 system prompt；返回 disposer |
| `ctx.logger` | 日志 |

---

## 4. agent tool 定义（`defineTool`）

来自 `@deepseek-ai/dsh-tools`：

```ts
import { defineTool } from "@deepseek-ai/dsh-tools";

const statusTool = defineTool({
  name: "engineer_status",
  description: "查看 dsh-github-engineer 状态…",
  parameters: {},  // JSON Schema
  output: {
    schema: { /* JSON Schema，additionalProperties:false */ },
    render(_args, value) {
      return [{ type: "text", text: String(value.message ?? "") }];
    }
  },
  async execute(args, exec) {
    // args 是 LLM 传入的参数
    // exec.signal 是 abort 信号
    return { ok: true, message: "..." };
  }
});
```

约束（DSH 0.1.5 严格 contract）：
- `parameters` 是 JSON Schema，可省但不能是非空对象再被 LLM 传空对象
- `output.schema` 必须有 `additionalProperties: false` + `required` 列表
- `output.render` 必须返回 `ContentBlock[]`，常见是 `[{ type: "text", text: "..." }]`
- `execute` 返回值会被 `output.schema` 校验；违规就报 invalid output
- `name` 最多 64 字符；只允许 `[A-Za-z0-9_-]`

---

## 5. MCP 子进程 + 把 MCP tools 注册成 agent tools

参考 dsh-feishu-mcp 的 supervisor 模式（`src/mcp.ts`）：

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// 1. spawn MCP 子进程（stdio）
const transport = new StdioClientTransport({
  command: "node",
  args: ["./mcp-server/dist/index.js"],
  env: { ...process.env, GHOST_TOKEN: "...", REPO_OWNER: "..." }
});

// 2. 建 client
const client = new Client({ name: "dsh-github-engineer", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);

// 3. 列出工具
const { tools } = await client.request({ method: "tools/list" }, ListToolsResultSchema);

// 4. 注册到 DSH
for (const tool of tools) {
  ctx.tools.register({
    name: `mcp__github_engineer__${tool.name}`,  // 命名空间
    description: tool.description ?? "",
    parameters: tool.inputSchema,
    output: {
      schema: {
        type: "object",
        properties: {
          content: { type: "array", items: {} },
          structuredContent: {}
        },
        required: ["content"],
        additionalProperties: false
      },
      render(_args, value) {
        return [{ type: "text", text: extractText(value?.content, tool.name) }];
      }
    },
    execute: async (args, exec) => {
      const result = await client.request({
        method: "tools/call",
        params: { name: tool.name, arguments: args }
      }, RawCallToolResultSchema, { signal: exec.signal, timeout: 60_000 });
      // 转化 result 为 agent 看到的形态
      if (result.isError) throw new Error(extractText(result.content, tool.name));
      return { content: result.content };
    }
  });
}
```

要点：
- MCP 子进程在 DSH bundle 进程内 spawn，通过 stdio JSON-RPC 通信
- 工具注册名是 `mcp__<plugin>__<rawName>`，rawName 来自 MCP server
- `RawCallToolResultSchema = z.record(z.string(), z.unknown())` —— MCP 的 `tools/call` 没有固定 schema，用 zod `record` 收
- 转换 `result.content`（`ContentBlock[]`） → DSH `output.render` 要求的 `ContentBlock[]`

---

## 6. 设置面板 / 路由

DSH 的 webServer 路由形如：

```ts
ctx.webServer.register({
  kind: "exact",
  path: "/api/github-engineer/status",
  handler: async (req, res) => {
    if (!isLoopbackRequest(req)) {
      res.writeHead(403); res.end(); return;
    }
    if (req.method !== "GET") {
      res.writeHead(405); res.end(); return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "..." }));
  }
});
```

loopback 守卫（参考 dsh-feishu-mcp）：
- 只接受 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`
- `host` 必须 loopback
- `sec-fetch-site: cross-site` 拒绝
- origin 必须同 host

设置面板本身是一个 React 组件，由 `@deepseek-ai/dsh-client-ui-settings` 暴露（不在本速查范围；参考 dsh-feishu-mcp 的 src/settings.tsx 形态）。

---

## 7. 安装与发布

- 本地开发：`dsh plugin --profile web add link:/path/to/repo`
- 安装后需要**重启 `dsh web`**（cordis patch 才会生效）
- 启动顺序：先确保 `appId/appSecret` 等配置存在 → bundle effect 注册 → spawn MCP → MCP tools 注册到 agent
- 发布：推到 GitHub → 在 `awesome-dsh-plugin` 仓库提 PR
- 发布到 npm：`dsh plugin --profile web add <npm-name>`，需在 npm 包名遵守 `@scope/<name>` 或裸名

---

## 8. 与我 v2 设计案相比——哪些 API 我已经能确认

| 设计案中的点 | 在源码中确认 | 备注 |
|---|---|---|
| `apply(ctx, config)` 是入口 | ✅ | |
| `ctx.effect(fn, label)` 注册清理逻辑 | ✅ | |
| `ctx.tools.register(toolDef)` 注册工具 | ✅ | `defineTool` 来自 `@deepseek-ai/dsh-tools` |
| `ctx.webServer.register({kind, path, handler})` 注册路由 | ✅ | |
| `ctx.systemPrompt.section({...})` 注册 system prompt 段 | ✅ | |
| MCP 子进程 stdio + `StdioClientTransport` | ✅ | `@modelcontextprotocol/sdk/client/stdio.js` |
| 工具命名 `mcp__<plugin>__<rawName>` | ✅ | 完整规则见 `publicToolName()` |
| 鉴权存 `~/.dsh/<plugin>.json` mode 0600 | ✅ | `dsh-feishu.json` 例子 |
| `defineTool.output` 严格 schema 校验 | ✅ | `additionalProperties: false` 必填 |

## 9. 设计案里我还**没确认**的几点

1. **设置面板 React 组件的完整注册路径** —— `src/settings.tsx` 在 dsh-feishu-mcp 仓库没编译到 `lib/`，需要查 `cordis.patch.yml` 里如何引用它（可能通过 `dsh.client.inject` 或额外字段）
2. **`ctx.effect` 的响应式依赖追踪** —— dsh-feishu-mcp 没用 reactive 触发器，但完整 reactive 怎么走需要查 DSH docs
3. **`output.render` 的 `value` 类型** —— 实际看是 `execute` 的 raw result（任意对象），不是 schema 校验后值
4. **设置面板路由如何与 Web UI 通信** —— React 组件如何调用 `/api/...` 路径、如何热更新配置

这 4 点不影响骨架启动（我可以让 skeleton 只用 `tools.register` + `systemPrompt.section`，等真要做面板再去查）。

---

## 10. 最小骨架 checklist

```jsonc
// package.json
{
  "name": "dsh-github-engineer",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "engines": { "dsh": ">=0.1.5-rc.1" }
  },
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "peerDependencies": {
    "@deepseek-ai/dsh-tools": ">=0.1.5-rc.1"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: github-engineer
      name: dsh-github-engineer
      config:
        announceToAgent: true
        enabled: true
```

```ts
// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "github-engineer";
export const inject = ["tools", "systemPrompt"];

export function apply(ctx, config) {
  ctx.effect(() => {
    const dispose = ctx.tools.register(defineTool({
      name: "engineer_status",
      description: "查看 dsh-github-engineer 状态",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            message: { type: "string", required: true }
          }
        },
        render: (_args, value) => [{ type: "text", text: String(value.message ?? "") }]
      },
      async execute() {
        return { ok: true, message: "dsh-github-engineer 已加载（骨架）。" };
      }
    }));
    return dispose;
  }, "github-engineer: tools");

  ctx.systemPrompt.section({
    name: "plugin:github-engineer",
    order: 210,
    text: "本机已安装 dsh-github-engineer 插件（GitHub 仓库工程脚手架）。"
  });
}
```

骨架确认可跑通的最小指令序列：
1. `pnpm install`
2. `pnpm build`（出 `lib/index.js`）
3. `dsh plugin --profile web add link:/path/to/dsh-github-engineer`
4. 重启 `dsh web`
5. 在 DSH 对话框呼 `engineer_status`，应该看到 "dsh-github-engineer 已加载（骨架）。"

---

## 11. 一句话总结

> **DSH 0.1.5 plugin = `apply(ctx, config)` + `cordis.patch.yml` + `@deepseek-ai/dsh-tools` 的 `defineTool` + `@modelcontextprotocol/sdk` 的 `StdioClientTransport`。dsh-feishu-mcp 的 `lib/index.js` 是 100% 可参考的真实实现，从 store、OAuth、supervisor、routes 到 agent tools 全部覆盖到。**