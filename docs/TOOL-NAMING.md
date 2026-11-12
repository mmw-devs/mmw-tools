# 工具命名规范

Status: living — 命名规则由 `scripts/check-contracts.mjs` 强制；`select_repo`、会话锁定与 `_meta` 传仓库已落地（2026-11-13）。按仓库授权表仍未实现，见第 6 节。

这份文档定义本插件暴露给模型的工具名、契约里的 operation 名，以及新增仓库/工具时必须遵守的规则。命名不是风格问题：注册表、授权、审计和模型看到的工具列表都以这些名字为键，改名等同于换身份。

## 1. 原则

1. **仓库不进工具名。** 工具名只回答“做什么”，仓库由会话状态决定。
2. **一个 operation 一个名字。** 同一操作不允许按仓库、角色或环境复制多份。
3. **服务器前缀由宿主决定。** 模型看到的 MCP 名字以 `mcp__<server>__` 开头，插件不自定义这段。
4. **只增不改。** 已有名字不重命名；废弃走兼容期，释放后的名字不复用。
5. **元工具单独命名。** 不绑定仓库的插件工具（状态、上下文）不进入 MCP 命名空间。

## 2. 格式

### MCP 业务工具

```text
mcp__<server>__<operation>
```

- `<server>`：一个 MCP 服务器一个固定值；本插件当前是 `mmw-tools`。
- `<operation>`：小写 snake_case，必须与契约里该 operation 的 `id` 完全一致。
- 不允许额外分段：仓库、角色、环境都不能插进名字。
- 现有例子：

```text
mcp__mmw-tools__repo_status
mcp__mmw-tools__repo_read
mcp__mmw-tools__repo_edit
mcp__mmw-tools__pr_create
mcp__mmw-tools__pr_merge
```

### 本地元工具

不经过 MCP、也不绑定仓库的插件工具使用：

```text
<plugin>_<noun>_<verb>
```

例如 `mmw_tools_status`、`mmw_tools_run`。`__` 只用于 MCP 的服务器分隔符，本地名字里不出现。

### 契约层

- 工具 ID：kebab-case，例如 `race-ops`、`mmw-tools-status`。
- operation ID：snake_case，例如 `repo_read`、`select_repo`。
- `operation.publicName` 就是模型看到的完整字符串，不再二次拼接。
- 授权与审计的稳定键是 `toolId.operationId`，不是公开名。

## 3. 仓库是会话状态

显式选择模型下，新增一个 operation：

```text
mcp__mmw-tools__select_repo
```

参数 `{ "repo": "owner/name" }`。选定后：

- 该会话的所有业务工具都作用于这个仓库；
- 同一会话再次选择同一仓库是幂等的；
- 选择另一个仓库返回 `[mmw_route_denied]`；
- 未选择就调用业务工具同样拒绝，不自动落到默认仓库。

因此仓库 slug **不得**出现在工具名、operation ID 或 `publicName` 中。也不要生成 `race-ops__xivstrat-relay__repo_read` 这类按仓库展开的别名——那会让名字数量随仓库数增长，并让契约与授权表产生 N 份副本。

启用飞书时，可用仓库由 auth core 的注册表决定：`select_repo` 先刷新
`GET /v1/agent/repos`，只接受注册表中已启用的 `owner/name`；刷新结果缓存到
`~/.dsh/mmw-tools-repos.json`，供下次启动同步注册工具。缓存不改变命名规则，
也不能绕过刷新：管理端停用的仓库即使还在旧缓存里，也会在选择时被拒绝。

## 4. 新增东西时

### 新增仓库

只改仓库注册表、授权记录和该仓库的规则文件。工具名、契约 operation、`TOOL_MAP` 都应为零 diff。仓库重命名或转移时，工具名仍然不变。

### 新增 operation

1. 在 `contracts/tools.json` 增加 operation，`publicName` 按上面的格式写。
2. 在插件 `TOOL_MAP` 增加 `publicName → { toolId, operationId }`。
3. 在 MCP server 注册同名工具，参数表只描述业务参数，不出现 `repo`。
4. 补测试与文档，跑契约检查。

### 新增功能或 MCP 服务器

使用新的 `mcp__<server>__` 前缀，例如 `mcp__relay-tools__repo_read`。不要复用别的服务器的名字，也不要把功能名塞进 operation 段。

### 重命名与废弃

- 只能新增名字，不能原地改已有 `publicName`。
- 旧名字至少保留一个发布周期，并在描述里指向新名字。
- 删除时同时删契约、`TOOL_MAP`、MCP 注册和文档；名字不复用。

## 5. 强制检查

`scripts/check-contracts.mjs` 在 CI 中检查：

- 每个 MCP `publicName` 必须以 `__<operation.id>` 结尾，禁止插入仓库或功能分段；
- 本地元工具名不得包含 `__`；
- `publicName` 全局唯一，operation ID 在工具内唯一；
- 工具 ID、operation ID 的字符集。

检查只证明格式；语义仍由 review 判断。新增或改名时，review 必须确认：

1. 名字里没有仓库 slug；
2. 没有为同一操作复制第二份名字；
3. 契约、`TOOL_MAP`、MCP 注册三处一致。

## 6. 已实现与剩余

已落地：

- `mcp__mmw-tools__select_repo` 与会话级仓库绑定（`src/gate/repo-registry.ts`）；
- 未选择时业务工具返回 `[mmw_route_denied]`；同会话改选另一个仓库同样拒绝；
- 插件通过 `_meta.mmwRepo` 把选择传给 MCP 子进程，子进程按 `MMW_REPOS` 解析该仓库的工作目录、分支基线和令牌文件；
- 每仓库独立的工作副本与只读令牌文件；写操作经 broker 按 `repo` 路由；
- `select_repo` 在授权表之前按本地会话状态放行（授权表可能滞后），业务工具仍受 `allowedOperations` 约束；这一豁免不改变命名规则，名字仍必须是 `mcp__mmw-tools__select_repo`。

仍未实现：

- 按仓库的授权表（`grants(member, repo, role)`）；当前授权仍按账号的 operation 集合判断，仓库范围由会话选择约束。

实现顺序与验收见 [`ADR-0001-MULTI-REPO.md`](ADR-0001-MULTI-REPO.md)。
