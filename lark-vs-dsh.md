# 调研报告：DeepSeek Harness (DSH) 飞书相关插件 vs. 飞书官方 `lark-cli`

> 数据来源：DSH 官方仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)、社区插件目录 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)、飞书官方仓库 [larksuite/cli](https://github.com/larksuite/cli) 与 [larksuite/lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp)。所有仓库的 README 均在 2025–2026 抓取。
>
> 时间：2026 年（你的本地资料截止）。

---

## 1. 一句话定位

| 维度 | `lark-cli`（飞书官方） | DSH 飞书相关插件（社区） |
|---|---|---|
| 提供方 | larksuite（飞书）官方维护 | DSH 社区开发者各自维护 |
| 形态 | 单个 Go 编写的 CLI，可作 MCP 服务 | DSH bundle（cordis 补丁 + 包），通过 `dsh plugin add` 安装 |
| 主要目的 | 让人类/AI Agent 直接操作飞书 OpenAPI | 让 DSH 这个 Agent 运行环境能够"在飞书里被调用"或"调用飞书" |
| 协议 | 自有命令 + MCP / Agent Skill | 系统约定为 DSH bundle，走 cordis patch 注入 profile |
| 覆盖面 | 18 个业务域、200+ 命令、26 个 AI Skill | 每个插件只解决一两个具体的桥接场景 |

---

## 2. `lark-cli` 是什么

仓库：`larksuite/cli`（[github.com/larksuite/cli](https://github.com/larksuite/cli)），npm 包：`@larksuite/cli`。

关键事实：

- **官方维护**：由 larksuite 团队直接开发，README 中写明 "the official Lark/Feishu CLI tool, maintained by the larksuite team — built for humans and AI Agents"。
- **双形态**：既是给人用的 CLI，也是给 Agent 用的 Skill/MCP 服务。
- **三层命令体系**：
  1. **Shortcuts** — `+agenda`、`+messages-send`、`+create`，带智能默认值、表格化输出、dry-run 预览，AI 调用友好。
  2. **API Commands** — 100+ 命令，与飞书 OAPI 端点 1:1 对应（如 `lark-cli calendar events instance_view`）。
  3. **Raw API** — 直接转发到 2500+ OpenAPI，参数完全自由。
- **26 个 AI Agent Skill**（`./skills/` 目录），每个对应一个业务域：`lark-shared`、`lark-calendar`、`lark-im`、`lark-doc`、`lark-drive`、`lark-markdown`、`lark-sheets`、`lark-slides`、`lark-base`、`lark-task`、`lark-mail`、`lark-contact`、`lark-wiki`、`lark-event`（WebSocket）、`lark-meeting`、`lark-whiteboard`、`lark-openapi-explorer`、`lark-skill-maker`、`lark-attendance`、`lark-approval`、`lark-workflow-meeting-summary` 等。
- **覆盖业务域**（README 列表）：Calendar、Messenger、Docs、Drive、Markdown、Base、Sheets、Slides、Tasks、Wiki、Contact、Mail、Meetings、Attendance、Approval、OKR、Project（Meegle 单独 CLI）、Apps。
- **安装**：`npx @larksuite/cli@latest install` 或 `git clone + make install`；AI Agent 还需要 `npx skills add larksuite/cli -y -g`。
- **认证**：`lark-cli config init` 创建自建应用 + `lark-cli auth login --recommend` OAuth；token 默认存进 OS 原生 keychain。
- **支持飞书国内版 / Lark 海外版**：通过 `--domain` 参数切换 `https://open.feishu.cn` 或 `https://open.larksuite.com`。
- **设计目标**："Agent-Native"——每个命令都用真实 Agent 跑过测试，参数简洁、默认值合理、结构化输出以最大化 Agent 调用成功率。
- **企业嵌入**：提供 `extension/` 包和官方文档《embed-feishu-cli-in-agent》，可通过 wrapper `main` 包一层而不修改 CLI 源码，支持集中凭据管理 + 审计 + 命令白名单。

### 2.1 `lark-openapi-mcp`（官方 MCP 兄弟项目）

仓库：`larksuite/lark-openapi-mcp`，npm 包：`@larksuiteoapi/lark-mcp`，目前为 Beta。

- **与 `lark-cli` 的关系**：是两件事，但生态上互补。`lark-cli` 是 CLI + Skill；`lark-mcp` 是 MCP server 形态，让 Cursor / Trae / Claude 等 Agent 框架通过 stdio 直接调用飞书 API。
- **典型配置**：
  ```json
  {
    "mcpServers": {
      "lark-mcp": {
        "command": "npx",
        "args": ["-y", "@larksuiteoapi/lark-mcp", "mcp",
                 "-a", "<app_id>", "-s", "<app_secret>"]
      }
    }
  }
  ```
- **OAuth 模式**：`--oauth --token-mode user_access_token`，读用户私有数据。
- **域切换**：同上，通过 `--domain`。
- **当前缺口**：文件上传/下载未支持；云文档只能导入和读取，不能直接编辑。

---

## 3. DSH 这边的飞书生态长什么样

DSH 本身是「一切皆插件」的 cordis 应用：`dsh plugin --profile web add <name>` 安装 bundle，bundle 通过 `cordis.patch.yml` 注入到 profile 的层级。

### 3.1 awesome-dsh-plugin 里 14 个飞书/Lark 相关插件（按场景归类）

> 来源：[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 分类下 Identity & Communication、Notifications & Integrations 的清单条目。

**A. 飞书 → DSH（IM 桥接，让 DSH 在飞书里跑）**

| 插件 | 仓库 | 关键特征 |
|---|---|---|
| `dsh-lark-link` | amlyczz/dsh-lark-link | 高可靠飞书-Lark 桥，QR 一键授权、卡片命令、意图确认、at-least-once 零丢失发件箱、媒体双向、`/doctor` 会话日志 |
| `dsh-feishu` (andyfan) | andyfan1094/dsh-feishu | 自建应用 WebSocket；每个 chat 路由到独立 DSH session；Card JSON 2.0 流式回复 |
| `dsh-feishu` (itr-del) | itr-del/dsh-feishu | `dsh plugin add` 一行；DM 一对一 session |
| `dsh-lark-bridge` | imetn/dsh-lark-bridge | 双向；项目/会话路由；交互卡片；审批；附件；任务控制 |
| `dsh-lark-bridge` | JMOKSZ/dsh-lark-bridge | 一键装；流式进度卡片；Ask/Approval 按钮卡片；附件；主动 `feishu_send` |
| `dsh-lark` | omdsh-dev/dsh-lark | 每个 chat 一个 agent；工具审批、模型提问、Plan 评审都回到飞书卡片；支持 `/cd`、`/model`、`/new` 切换 |
| `dsh-feishu` (PGZXB) | PGZXB/dsh-feishu | 面板驱动；所有 slash 命令 = 控制面板按钮 |
| `dsh-lark-bot` | PlutoKeating/dsh-lark-bot | 扫码绑定；流式卡片；git-worktree 项目工作区；多角色 agent；崩溃保护 |
| `dsh-feishu-chat` | Qing45/dsh-feishu-chat | 官方 WebSocket 长连接；按工作区路由；设置页配置 |
| `dsh-feishu-remote` | ShiXiangYu2/dsh-feishu-remote | 用 **lark-cli 的 WebSocket**，不需公网 webhook；常驻 launcher |
| `dsh-feishu-bridge` | wz-heng/dsh-feishu-bridge | "Fail-closed" 风格：每个 bash 调用前出 Allow/Deny 卡，超时拒执行；官方 Python SDK 精确钉版本；webhook 验签 + replay 防护 |
| `dsh-feishu` (xmanrui) | xmanrui/dsh-feishu | 扫码连接，最轻量 |
| `dsh-lark-meeting-notifier` | yeruizhi/dsh-lark-meeting-notifier | 副作用型：开会提醒 |

**B. DSH → 飞书（让 DSH 这个 Agent 调用飞书能力）**

| 插件 | 仓库 | 关键特征 |
|---|---|---|
| `dsh-feishu-mcp` | zhengjy01/dsh-feishu-mcp | 包装官方 `@larksuiteoapi/lark-mcp`，把它的工具以 `mcp__feishu__*` 注入 agent；提供 `feishu_status` / `feishu_config` / `feishu_test` / `feishu_tools` 自身工具 + Settings → 飞书 Web 面板 |
| `dsh-feishu-task-recorder` | CAI-MH/dsh-feishu-task-recorder | **通过 lark-cli** 轮询飞书群/单聊，抽取候选任务，两端同步到任务板，浮动浏览器面板 + 设备流授权 |
| `dsh-plugins/packages/dsh-feishu` | wangbodbs/dsh-plugins | 这个 monorepo 里的 `dsh-feishu` 同样把 DSH 暴露成飞书聊天对象（同一个项目里还放 `dsh-mcp-flapi`、`dsh-mcp-davinci-resolve`） |
| `dsh-streaming-mcp-bridge` | yabolee-kkk/dsh-streaming-mcp-bridge | 把 DSH 的 `session.event` 流桥给 cc-connect / 飞书客户端，让飞书看到思考/工具过程，而不仅仅是最终回答 |

### 3.2 生态层观察

- **没有任何一个 DSH 飞书插件重复造 OpenAPI 客户端的轮子**：凡是"调飞书 API"的需求，下层一律复用官方 `@larksuiteoapi/lark-mcp`（即官方 MCP server），或在长连接场景下复用 `lark-cli` 的 WebSocket 能力。
- **绝大多数插件是 IM 桥**（飞书 ↔ DSH）：它们的核心创新点不是 API 集成，而是 **路由策略**（DM→session、群→多 bot、会话隔离、工作区切换）、**富卡片交互**（审批/提问/进度）、**安全/容错**（webhook 验签、Fail-closed、崩溃兜底、零丢失发件箱）。
- **覆盖面天然拆分**：每个插件只做 1–2 个场景，没有"全家桶"。`lark-cli` 的 18 个业务域在这里被打散到不同插件里，比如日历/任务有专门插件（CAI-MH），文档/多维表格靠 `dsh-feishu-mcp` 一站式解决。

---

## 4. 横向对比表

| 维度 | `lark-cli`（官方） | `lark-openapi-mcp`（官方） | DSH 飞书插件（社区） |
|---|---|---|---|
| 维护方 | larksuite 官方 | larksuite 官方 | 社区独立作者 |
| 发行形态 | Go 二进制 + npm `@larksuite/cli` | npm `@larksuiteoapi/lark-mcp` | 仓库 + 可选 npm |
| 与 DSH 集成 | **可选依赖**，DSH 没内置 | 通过 `dsh-feishu-mcp`（zhengjy01）作为子进程被 DSH 拉起 | 内置 bundle |
| 安装命令 | `npx @larksuite/cli@latest install` | `npx -y @larksuiteoapi/lark-mcp` | `dsh plugin --profile web add <name>` |
| 命令数量 | 200+ 精选 + 2500+ Raw API | 取决于 `-t` 预设 + App 权限 | 每个插件 0–N 个工具 |
| AI Skill 数 | 26 个官方 Skill | 仅 MCP 工具列表 | 由各 bundle 自身工具 + 可选 Skill 决定 |
| 业务覆盖 | 全量 18 个域 | 全量，按 App 权限裁剪 | 分散；多数集中在 IM/审批/任务/Markdown |
| 身份支持 | app + user（OAuth） | app + user（OAuth），`--token-mode user_access_token` | 由插件封装决定，多数仅 app |
| 域切换 | `--domain` 中国 / 海外 | `--domain` 中国 / 海外 | 通过底层 `lark-cli`/`lark-mcp` 参数传递 |
| 凭据存储 | OS 原生 keychain | 自管 token | 插件自身设置面板 / 配置文件 |
| 鉴权安全 | 输入注入保护 + 输出清洗 | 文档中未单列 | 各插件差异大：`dsh-feishu-bridge` 做到 webhook 验签 + replay + Fail-closed；多数插件只校验发送方是不是租户成员 |
| 双向 IM 桥 | ✗（不是设计目标） | ✗ | ✓ 几乎每个社区插件都做 |
| 富卡片交互（按钮/审批/提问） | ✗ | ✗ | ✓ DSH 端插件的差异化主战场 |
| Agent 流式回显 | 通过 `lark-event` Skill 接收 WebSocket 事件 | 无 | `dsh-streaming-mcp-bridge` 等专门解决 |
| 多账号 / Profile | `--profile`（App 配置级，非个人级，社区 `lark-switch` 补齐） | 命令参数 `-a/-s` | 多 bot 互不串 session（如 `dsh-lark`） |
| 嵌入到企业平台 | ✓ `extension/` + 官方文档 | ✓ OAuth + 集中凭据 | 视插件而异 |
| License | MIT | MIT（仓库） | 多为 MIT |
| 已知局限 | 文件/二进制编辑能力分散到 Skill | Beta：上传/下载未支持，云文档不可直接编辑 | 14 个插件不互相兼容/不组合安装 |

---

## 5. 关键差异背后的设计取舍

### 5.1 `lark-cli` 是"能力"，DSH 飞书插件是"产品"

- 飞书官方把 `lark-cli` 当成 **能力供应商**：1 个仓库，覆盖 18 个业务域，每个能力都按统一的三层命令格式暴露给人和 Agent。
- 社区把 DSH 飞书插件当成 **具体产品**：每一个插件解决一个垂直问题（"在飞书里开会话机器人"、"把 DSH 当成飞书消息的处理人"、"把飞书任务同步到 DSH 任务板"）。它们之间不保证 API 兼容、不保证可以同时装、也不保证作者会持续维护。

### 5.2 `lark-cli` 不做 IM 双向桥，DSH 插件的核心价值在这里

- `lark-cli` 主要解决"调用飞书"这一侧：发出命令、读回结果。它的 `lark-event` Skill 能接收 WebSocket 事件流，但官方并没有把它做成"飞书群聊里的 DSH bot"。
- DSH 飞书插件的核心价值是反向的：把 DSH 这个 Agent 放到飞书群里、DM、单聊里，让人类用飞书 UI 驱动 DSH，并让 DSH 在飞书 UI 里回富卡片、按钮、进度条、附件、审批流。这是 DSH 社区的**差异化护城河**。

### 5.3 复用优于重写

- 凡是"调飞书 API"的部分，社区插件都倾向于复用 `@larksuiteoapi/lark-mcp` 或 `lark-cli`。`dsh-feishu-mcp`（zhengjy01）是其中典型：它本质上是一个把官方 MCP server 包成 DSH bundle 的适配层。
- `dsh-feishu-task-recorder`（CAI-MH）则反向复用 lark-cli 来做轮询——它不是因为 lark-mcp 不好，而是因为 lark-cli 的命令行风格更适合在 DSH 后台用脚本方式批量跑。

### 5.4 安全模型差异

- `lark-cli` 主要靠 OS keychain + 输入清洗 + 输出清洗。
- `lark-mcp` 是 MCP 协议，没有自带 webhook 验签那一层。
- DSH 社区里最严格的 `dsh-feishu-bridge`（wz-heng）把飞书那侧做成"fail-closed"：所有 bash 调用前先在飞书卡片上要 Allow/Deny，超时即拒；webhook 验签 + 时间戳 + replay 三件套；官方 Python SDK 钉死版本。这显然超出了官方 CLI 的范畴，是社区在真实生产场景里补出来的工程实践。

### 5.5 覆盖面的"广"vs"深"

- `lark-cli` 是"广"：18 个业务域、200+ 命令、26 个 Skill。但每个能力是统一格式、统一文档、跨平台一致。
- DSH 飞书插件是"深"：14 个插件几乎都集中在"聊天"和"审批"两个域，但每个都做透了——路由、卡片、附件、人在环路、崩溃保护、多账号。

---

## 6. 选择建议

| 你的目标 | 推荐 |
|---|---|
| 给任意 Agent（Claude Code / Cursor / Codex…）一个能用飞书 18 域能力的工具 | **`lark-cli`**（CLI + Skill）或 **`lark-openapi-mcp`**（MCP） |
| 在 DSH 里加一组 `mcp__feishu__*` 工具，让 Agent 能读飞书文档/发 IM/管理日历 | **`dsh-feishu-mcp`**（zhengjy01），它直接拉起官方 MCP server |
| 在飞书群里跑一个 DSH bot，每个对话对应一个 DSH 会话 | **`dsh-lark-bridge`**（JMOKSZ）或 **`dsh-feishu-remote`**（ShiXiangYu2，复用 lark-cli WebSocket） |
| 把飞书 IM 当成 DSH 远程控制台，要求强安全模型 | **`dsh-feishu-bridge`**（wz-heng）—— fail-closed + 钉版本 + 验签 |
| 同步飞书任务到 DSH 任务板 | **`dsh-feishu-task-recorder`**（CAI-MH） |
| 想在飞书里看到 DSH 的思考/工具过程（不只是最终回答） | **`dsh-streaming-mcp-bridge`**（yabolee-kkk） |
| 大量定制、多账号、生产化部署 | 在 `lark-cli` 之上叠 `extension/` 包做 wrapper，不要 fork CLI |

---

## 7. 资料来源

- `larksuite/cli`：[github.com/larksuite/cli](https://github.com/larksuite/cli) — 三层命令体系 + 26 Skill + 企业 `extension/` 包
- `larksuite/lark-openapi-mcp`：[github.com/larksuite/lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp) — 官方 MCP server（Beta）
- `deepseek-ai/deepseek-harness`：[github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — DSH 主仓
- `awesome-dsh-plugin/awesome-dsh-plugin`：[github.com/awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) — 社区插件目录（Identity & Communication + Notifications & Integrations）
- `zhengjy01/dsh-feishu-mcp`：[github.com/zhengjy01/dsh-feishu-mcp](https://github.com/zhengjy01/dsh-feishu-mcp) — 把官方 MCP 包成 DSH bundle
- `wangbodbs/dsh-plugins`：[github.com/wangbodbs/dsh-plugins](https://github.com/wangbodbs/dsh-plugins) — monorepo 形式的多 DSH 插件（含 `dsh-feishu`）
- `yabolee-kkk/dsh-streaming-mcp-bridge`：[github.com/yabolee-kkk/dsh-streaming-mcp-bridge](https://github.com/yabolee-kkk/dsh-streaming-mcp-bridge) — 把 DSH session 流桥给飞书客户端
- `CAI-MH/dsh-feishu-task-recorder`（awesome-dsh-plugin 目录条目）— lark-cli 反向调用典型
- `wz-heng/dsh-feishu-bridge`（awesome-dsh-plugin 目录条目）— fail-closed 安全模型典型

---

## 8. 一句话总结

> `lark-cli` 是飞书官方给的"全业务域 + Agent 原生 + 三层命令 + 26 Skill" 的飞书能力集；DSH 的飞书插件是社区在 DSH 这个 Agent 框架上，把飞书**反向**接成产品（聊天机器人 / 远程控制台 / 任务同步 / 流式回显），下层一律复用 `lark-cli` 或 `lark-mcp`，上层靠路由、卡片、人在环路和安全模型做差异化。两者不是竞争，而是上下游的复用关系。