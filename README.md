# mmw-tools

mmw-devs 运维仓库的工具集。两个交付物：

- **`dsh-mmw-tools/`** —— 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
  插件，让 DSH agent 在一个已注册的 GitHub 仓库里，按仓库自己发布的
  `AGENTS.md` 规则工作——读、只改 allowlist 中的路径、每次提交前跑
  pre-flight、开 PR，并且只有宿主确认后才合并或关闭。会话用 `select_repo`
  绑定一个仓库；用户用飞书登录，broker 用自己的 GitHub App 身份访问 GitHub。
- **`mmw-tools-auth/`** —— 飞书 H5 授权核心。它拥有成员、角色，以及插件在
  每次工具调用时检查的 operation 授权表。

```text
dsh-mmw-tools/           插件（bundle + stdio MCP server）
mmw-tools-auth/          飞书授权核心 + agent 路由表
contracts/               共享工具目录 / 角色 / golden 路由表
```

## 插件

**`dsh-mmw-tools`** —— broker 中介的 GitHub App 认证、MCP 工具、两个原生工具
（`mmw_tools_status`、`mmw_tools_run`）、唯一的飞书设置面板，以及加固过的工具
边界。版本和脚本见
[`dsh-mmw-tools/package.json`](dsh-mmw-tools/package.json)。完整说明、配置和
安全模型见 [`dsh-mmw-tools/README.md`](dsh-mmw-tools/README.md)。

```sh
# 推荐：从 monorepo 安装已提交的构建产物。
dsh plugin --profile <profile> add "git+https://github.com/mmw-devs/mmw-tools.git#path:/dsh-mmw-tools"
# 重启 DSH

# 从本地 checkout 开发安装：先构建，再用 file: 安装。
cd dsh-mmw-tools
pnpm install
pnpm build:all
dsh plugin --profile <profile> add "file:$PWD"
# 重启 `dsh web`
```

用 `file:`，不要用 `link:`；`link:` 可能让设置面板静默不加载。然后打开
**Settings → MMW Tools**，点击 **使用飞书登录**。不需要 GitHub 账号、OAuth
App 或 client secret：broker 持有 GitHub App 身份，在验证飞书成员后签发仓库
token。

第一次业务调用之前，管理员必须已经在 auth core 注册仓库、给成员授予
`select_repo` 和需要的 operations，并且仓库 base 分支上要有
`.dsh-mmw-tools.yaml`。工作区必须是已注册仓库的 clone；如果不是，
`mmw_tools_status` 会报告对应的 `workspace` 模式。

在受管工作区里，可以直接让 agent 绑定并工作，例如：“选择这个仓库，读规则，
把 `public/data.json` 里的某处改掉，跑 validation，然后开一个 PR。” agent 会
调用 `select_repo`、`mmw_tools_run`、`repo_read`、`repo_edit` 和 `pr_create`。
合并或关闭仍然需要宿主确认；`pr_merge` 还需要 broker approval。

## 授权核心

**`mmw-tools-auth` Phase 1 MVP** —— 飞书 OAuth（PKCE）、成员/角色、plugin
token，以及 `GET /v1/agent/routes`。插件不根据这些路由动态挂载或卸载工具；
它静态注册所有工具，并在每次调用时检查 `allowed` / `allowedOperations`。

```sh
cd mmw-tools-auth
cp .env.example .env
node --env-file=.env src/main.mjs   # http://127.0.0.1:4326
node tests/run.mjs                  # auth-core 测试套件
```

配置、bootstrap-admin 流程、端点和限制见
[`mmw-tools-auth/README.md`](mmw-tools-auth/README.md)。部署步骤见
[`mmw-tools-auth/deploy/README.md`](mmw-tools-auth/deploy/README.md)。

**部署：** 主机布局、TLS 和验证步骤见
[`mmw-tools-auth/deploy/README.md`](mmw-tools-auth/deploy/README.md)。auth core
只监听 loopback；由 nginx 终止 TLS。

## 第一个客户：[`mmw-devs/ffxiv-race-ops`](https://github.com/mmw-devs/ffxiv-race-ops)

插件是围绕这个仓库的 `AGENTS.md` 契约构建的：

- **只有** `public/data.json` 可以修改。
- 分支使用 `content/*` 前缀——直接向 `main` push 会被拒绝。
- 提交落地前必须通过 `npm run validate`。
- PR 默认以 draft 打开。`pr_merge` 和 `pr_close` 需要宿主确认；`pr_merge`
  还需要绑定 PR head SHA 的 broker approval，GitHub 的分支保护仍然决定是否
  允许合并。

binding 把这些规则镜像到 `dsh-mmw-tools/cordis.patch.yml`，从而不需要解析
Markdown 就能执行。这种重复是故意的，也有文档记录：见
[`docs/OPERATIONS-SYNC.md`](dsh-mmw-tools/docs/OPERATIONS-SYNC.md)。

## 目录布局

| 路径 | 内容 |
|---|---|
| `AGENTS.md` | Agent 硬规则和文档地图入口。 |
| `.dsh/skills/docs-ssot/SKILL.md` | 语义化文档更新流程和 `Doc-Impact` 记录格式。 |
| `scripts/doc-map.json` | 文档到源码的映射，以及影响检查使用的状态标签。 |
| `dsh-mmw-tools/` | 插件：DSH bundle、stdio MCP server、设置面板、测试。 |
| `mmw-tools-auth/` | 飞书 H5 授权核心：OAuth、成员、角色、plugin token、路由表。见 [`mmw-tools-auth/README.md`](mmw-tools-auth/README.md)。 |
| `mmw-tools-auth/deploy/` | systemd/nginx/TLS 安装、经验证的 SQLite 快照、健康检查 timer、回滚。见 [`deploy/README.md`](mmw-tools-auth/deploy/README.md)。 |
| `dsh-mmw-tools/README.md` | 插件 README——安装、配置、工具、安全模型。 |
| `dsh-mmw-tools/CHANGELOG.md` | 按 increment 的历史。 |
| `dsh-mmw-tools/docs/` | OAuth 走查、operations sync、按 increment 的设计记录、发布清单。 |
| `dsh-mmw-tools-design.md` | 架构和业务逻辑设计（v2，对齐 `ffxiv-race-ops` 的 `AGENTS.md`）。 |
| `contracts/` | 共享工具目录、角色、路由表 schema 和 golden 示例。见 [`contracts/README.md`](contracts/README.md)。当前角色/操作矩阵：[`contracts/REFERENCE.md`](contracts/REFERENCE.md)（生成的）。 |
| `scripts/check-contracts.mjs` | 校验目录，重新生成 golden 路由表和 `contracts/REFERENCE.md`。 |
| `scripts/check-docs.mjs` | 拒绝 living 文档里的过期标识符，以及长期文档缺失状态标签。见 [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md)。 |
| `scripts/doc-impact.mjs` | 把改动源码映射到定义它们的文档；文档未更新时失败。 |
| `docs/OBSERVABILITY.md` | run id、审计事件，以及为什么 trace 存储是有界 JSONL 而不是 collector。 |
| `docs/CONFORMANCE.md` | 2026-11-11 的“声明 vs 证据”快照；historical，不代表当前行为。 |
| `docs/MULTI-REPO-ROUTING.md` | 多仓库授权的目标设计；已实现的部分记录在 `docs/ADR-0001-MULTI-REPO.md`。 |
| `docs/ADR-0001-MULTI-REPO.md` | 仓库注册表和“一会话一仓库”绑定的决策记录，包括 2026-11-13 的 `select_repo` 修正。 |
| `docs/TOOL-NAMING.md` | 工具/operation 命名规则：仓库不进名字，CI 检查格式。 |
| `scripts/prune-merged-branches.mjs` | 只有所有依赖和保留检查都通过后，才删除远端分支。 |
| `mmw-tools-routing-layer-plan.md` | 以飞书 H5 授权为中心的功能路由计划：auth core 拥有目录和策略；DSH 插件静态注册工具并逐次授权。 |
| `mmw-tools-routing-state-machine.md` | 静态注册 + 调用时授权的 Auth、Policy、Transport、Tool Call 状态机。 |
| `dsh-plugin-api-cheatsheet.md` | DSH 0.1.5 插件 API 参考，摘自 `zhengjy01/dsh-feishu-mcp` 并对照 DSH 源码。 |
| `github-oauth-app-checklist.md` | 旧 GitHub 用户 OAuth 笔记；插件不再使用这条登录路径。 |
| `lark-vs-dsh.md` | 研究笔记：DSH 的飞书相关插件 vs 官方 `lark-cli`。 |

## 工具契约

`contracts/tools.json` 是飞书授权核心和 DSH 插件共享的工具目录。它定义每个
工具的 `roles`、`requiredPermissions`、operations 和 `risk`。目录由 core 拥有；
插件静态实现每个 operation，并在每次调用时检查 core 的 `allowed` /
`allowedOperations`。

没有 role → permission 表：角色决定谁可以使用工具；`requiredPermissions`
描述工具本身需要什么。

```sh
node scripts/check-contracts.mjs
node scripts/check-contracts.mjs --update   # 有意改动目录之后
node scripts/check-docs.mjs
```

golden 路由表在 `contracts/examples/`；人类可读的矩阵是
`contracts/REFERENCE.md`，两者都是生成的。不要手改。v2 模型见
[`contracts/README.md`](contracts/README.md)，稳定错误码见
[`ERRORS.md`](contracts/ERRORS.md)，权威文档见
[`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md)。

## 文档

[`AGENTS.md`](AGENTS.md) 持有硬规则并链接地图；
[`scripts/doc-map.json`](scripts/doc-map.json) 说明每个文档定义什么、哪些源码
改动需要触碰它；[`.dsh/skills/docs-ssot/SKILL.md`](.dsh/skills/docs-ssot/SKILL.md)
是语义更新流程。提交前：

```sh
node scripts/doc-impact.mjs --base origin/main --worktree
```

CI 对 PR base 跑同样的检查，所以改了源码却没更新文档会导致构建失败。生成文档
只把生成输入列为 sources；消费它们的运行时代码由定义行为的 living 文档覆盖，
而不是由生成快照覆盖。它还会拒绝漏掉 tracked markdown 的 map，或匹配不到任何
文件的 source glob。`--worktree` 会在进入 CI 前报告未登记的新 markdown。
`AGENTS.md` 链接地图而不是复制它，所以只有一张表要维护。

## 分支清理

`scripts/prune-merged-branches.mjs` 只有在以下条件全部满足时才删除远端分支：
PR 已合并；它没有 base 分支之外的提交；没有 open PR 把它当 head 或 base；它
没有受保护；没有 workflow/config 引用它；合并时间早于保留窗口（默认 7 天）。
脚本默认 dry run，除非传 `--apply`；未知或不可读的信号会保留分支。

```sh
GITHUB_TOKEN="$(gh auth token)" node scripts/prune-merged-branches.mjs
GITHUB_TOKEN="$(gh auth token)" node scripts/prune-merged-branches.mjs --apply
node --test scripts/prune-merged-branches.test.mjs
```

`.github/workflows/branch-cleanup.yml` 每周带 `--apply` 运行；手动运行默认
dry run。用 `--keep <pattern>` 添加长期例外。

## 验证

```sh
node scripts/check-contracts.mjs
node scripts/check-docs.mjs
node scripts/doc-impact.mjs --base origin/main
node --test scripts/doc-impact.test.mjs
node mmw-tools-auth/tests/run.mjs
node --test scripts/prune-merged-branches.test.mjs
cd dsh-mmw-tools
pnpm check                    # typecheck、namespace 和全量测试
cd mcp-server && pnpm test    # MCP guard 和 schema 套件
```

## 许可证

MIT © 2026 mmw-devs。见 [`dsh-mmw-tools/LICENSE`](dsh-mmw-tools/LICENSE)。
