# ADR-0001：多仓库的注册表、工具身份与会话绑定

Status: target design

本文是决策提案，不是已交付行为。方案对比与 SSOT 判据见
[`MULTI-REPO-ROUTING.md`](MULTI-REPO-ROUTING.md)；本文取代该文第 4 节的
“B + 每仓库一个插件实例”推荐，保留其 A/B/C 比较作为背景。

## 决策摘要

- **能力契约保持仓库无关**：`contracts/tools.json` 不新增 operation，不复制
  `allowedOperations`，`TOOL_MAP` 的源码不因仓库数量变化。
- **仓库注册表是仓库实例的唯一源**：放在 auth core，管理 UI 维护；插件启动时
  读一份由 auth core 生成的只读缓存。
- **一个 DSH 插件注册多组工具别名**：每个注册仓库一组
  `race-ops__<slug>__<operation>`；单仓库安装保留现有名字。
- **一个会话只绑定一个仓库**：该会话第一次业务工具调用锁定仓库，之后调用其他
  仓库的工具一律拒绝。
- **授权按 `(member, repo, role)`**：route table 是授予的派生结果，不是能力
  定义。
- **仓库规则仍由仓库自己拥有**：`.dsh-mmw-tools.yaml` 是运行时 authority，
  插件配置只留路径与仓库坐标。

## 2026-11-13 修订（取代第 3、4 节）

用户决定采用**显式选择**，不再为每个仓库注册别名：

- 所有仓库共用一套工具名 `mcp__mmw-tools__<operation>`，仓库 slug 不出现在
  工具名、operation ID 或 `publicName` 中；规则见
  [`TOOL-NAMING.md`](TOOL-NAMING.md)。
- 新增 `mcp__mmw-tools__select_repo`（契约 `race-ops.select_repo`）。一个会话
  必须先选定仓库才能调用业务工具；未选择即拒绝，不自动落到默认仓库。
- 选定后不可切换；同一会话再选其他仓库返回 `[mmw_route_denied]`。
- 这样新增仓库不需要改工具清单、契约或 `TOOL_MAP`，只改注册表与授权。

修订理由：按仓库展开的别名会让名字数量随仓库数线性增长；用户明确要求“先显式
选”，并接受“每次会话多一步”的代价。

以下第 3、4 节是原提案，保留作决策记录。

## 实现进度（2026-11-13）

已实现（PR #18–#24 系列与 grants 改动）：

- `mcp__mmw-tools__select_repo` 与门禁的会话级仓库绑定；
- 未选择时业务工具返回 `[mmw_route_denied]`，选定后不可切换；
- 插件经 `_meta.mmwRepo` 把选择传给 MCP 子进程，子进程按 `MMW_REPOS` 解析该仓库的工作目录、基线、令牌文件与规则；
- broker 的只读令牌与写代理均已按 `repo` 路由；每仓库独立令牌文件；
- auth core 的 `repos` 表、管理 UI 与 `GET /v1/agent/repos`；
- 插件从 auth core 刷新注册表并生成本地缓存（`~/.dsh/mmw-tools-repos.json`，0600，不含凭据）；
- `grants(member, repo, role)` 表、管理 UI 按仓库授权；`GET /v1/agent/routes?repo=` 只按该仓库 grants 派生，无授予返回空表。

仍未实现：

- `.dsh-mmw-tools.yaml` 作为运行时规则 authority。

## 1. 约束与现状

用户约束（2026-11-12 确认）：

1. 重点应是“仓库注册表”，而不是给每个仓库复制一份契约。
2. 多仓库可以理解为“一个 DSH 插件下的多工具”。
3. 为保证可靠性，**单个会话只能操作一个工具（仓库）**。

当前实现是单仓库绑定：一个插件只启动一个 MCP 子进程
（[`dsh-mmw-tools/src/index.ts:1182-1193`](../dsh-mmw-tools/src/index.ts)），
子进程的 env 只有一份 `repoBinding`；`PolicyGate` 构造时没有接收 binding
（`index.ts:913`），所以 gate 既不知道调用打在哪个仓库，也无法校验 route table
的仓库维。授权表是全局 `allowedOperations`（`mmw-tools-auth/src/policy.mjs`）。

## 2. 四类事实，四个单源

| 事实 | 唯一源 | 本文中的位置 |
|---|---|---|
| 能力契约：有哪些 operation、风险级别、需要什么权限 | `contracts/tools.json` + `contracts/roles.json` | 不变，仓库无关 |
| 仓库实例：有哪些仓库、坐标、installation、启用状态 | auth core 的 `repos` 表（管理 UI 维护） | 新增 |
| 授权授予：谁能在哪个仓库做哪些 operation | auth core 的 `grants(member, repo, role)` | 新增 |
| 仓库规则：allowlist、denylist、分支前缀、preflight | 目标仓库的 `.dsh-mmw-tools.yaml` | 替代 `cordis.patch.yml` 的镜像字段 |

**注册表缓存的定位**：DSH 在插件加载时就要注册工具，而飞书登录发生在之后。
因此插件启动时读 `~/.dsh/mmw-tools-repos.json`——它由 auth core 在登录/同步时
生成，不是手写配置，也不是第二份事实源。缓存缺失时只注册
`mmw_tools_status`，业务工具不可用，status 里写明“注册表未同步”。

## 3. 工具身份与命名（原提案，已被 2026-11-13 修订取代）

每个启用的仓库注册一组别名：

```text
race-ops__ffxiv-race-ops__repo_read
race-ops__ffxiv-race-ops__repo_edit
race-ops__arena-ladder__repo_read
...
```

- `<slug>` 由 `owner-name` 清洗为 `[a-z0-9-]`；重命名仓库时旧 slug 保留一个
  过渡期，status 标为 deprecated。
- 单仓库安装（注册表只有一项且是默认仓库）继续注册旧名字
  `mcp__mmw-tools__repo_read`，避免破坏现有 skill 与会话。
- `TOOL_MAP` 从“publicName → operation”扩展为“alias → (operationId, repoId)”；
  `contracts/`、golden 表、`REFERENCE.md` 都不需要按仓库展开。
- 别名数量随仓库线性增长，但每个仓库仍是独立的 MCP 子进程、独立工作区、
  独立 installation token；不共享 `roots`。

## 4. 会话绑定（原提案，已被 2026-11-13 修订取代）

`tools/pre-execute` 的 `exec.agent.id` 是 `SessionId`
（`dsh-agent/lib/types/types.d.ts:11-13`），gate 今天只读 `exec.name`。绑定规则：

1. 业务工具第一次通过授权后，把 `sessionId → repoId` 写入 gate 的内存表；
   绑定发生在启动 MCP 之前。
2. 同一会话再调用其他仓库的别名：拒绝，reason 以 `[mmw_route_denied]` 开头，
   并说明“本会话已绑定 X，切换仓库请新开会话”。
3. `mmw_tools_status` 始终可用，报告当前绑定与可用仓库，不触发绑定。
4. 绑定不落盘；DSH 会话结束即释放。
5. 显式绑定工具 `mmw_tools_bind` 是备选：它让用户在第一次业务调用前选定仓库，
   代价是新增一个 control-plane operation。**建议在 spike 里先验证首调锁定是否
   足够；不够再加显式绑定，而不是两者同时上。**

首调锁定的已知代价：误点另一个仓库的工具会锁错会话，只能新开会话恢复。这个
代价被“单会话单仓库”的可靠性要求接受；status 必须把绑定显示出来。

## 5. 授权与判定顺序

- `grants` 表：`(member_id, repo_id, role)`；角色仍用现有四档
  `viewer/editor/operator/admin`，语义不变。
- `/v1/agent/routes?repo=<repoId>` 返回该成员在该仓库的
  `allowedOperations`，响应带 `repo`；无授予返回空表，而不是回退到全局角色。
- gate 顺序不变：Auth → Policy → Transport。Policy 阶段校验三件事：
  别名的 `repoId` 与 route table 的 `repo` 一致；operation 在
  `allowedOperations` 里；会话已绑定同一仓库。任一失败都在启动 MCP 前拒绝。
- 管理 UI 按仓库授予；成员页显示“在哪些仓库有什么角色”，不再只有全局角色。
- 边界不变：授权控制防误操作，不是防恶意本地用户的隔离边界；真正的边界仍是
  broker 凭据、GitHub App 权限、分支保护与 CI。

## 6. 仓库规则文件

- 每个仓库的 base commit 带 `.dsh-mmw-tools.yaml`（`version`、`allowlistPaths`、
  `denylistPaths`、`branchPrefix`、`preflight.cmd`、`prDefaultDraft`）。
- 插件启动/首次调用时按绑定的 base commit 拉取，记录 blob sha；写操作在文件
  缺失、schema 不符或与 `AGENTS.md` 指纹不一致时 fail closed，返回
  `[mmw_policy_unavailable]`；读操作可降级，但 status 必须显示来源与 sha。
- `cordis.patch.yml` 删除四个镜像字段，只留仓库坐标、OAuth 与工作区路径。

## 7. 失败模式

| 情况 | 行为 |
|---|---|
| 注册表缓存缺失/损坏 | 只注册 status；业务工具调用返回 `[mmw_policy_unavailable]` |
| 仓库被禁用 | 该仓库别名不注册；已绑定会话的调用被拒 |
| 成员无该仓库授予 | `[mmw_route_denied]`，附所需角色；不启动 MCP |
| route table 的 repo 与别名不符 | 拒绝，不静默降级 |
| 规则文件漂移/缺失 | 写拒绝并带码；读降级；status 可见 |
| installation token 不含该仓库 | 该仓库标记 `tool_unavailable`，其他仓库不受影响 |
| 会话跨仓库调用 | `[mmw_route_denied]`，提示新开会话 |

## 8. 两仓库 spike 的验收

用一个真实仓库 A 与一个测试仓库 B：

- 注册表里两个仓库，插件注册两组别名；旧名字只在单仓库模式下保留。
- 成员对 A 可写、对 B 只读：对 B 的 `repo_edit` 在 MCP 启动前被拒，带
  `[mmw_route_denied]`；对 A 放行。
- 同一会话先调 A 再调 B：第二次拒绝，会话绑定仍是 A；新会话可绑 B。
- B 的规则文件缺失：写拒绝，读降级，status 显示缺失与 sha。
- 两个 MCP 子进程的 `workingDir`、env、token 互不共享；审计事件能区分仓库。
- `contracts/`、`TOOL_MAP` 源码、`REFERENCE.md` 的 git diff 为零。
- 停用 A 后重载插件：A 的别名消失，B 不受影响。

## 9. 开放问题

- DSH 是否允许插件在加载后动态增删工具？如果不允许，注册表变更需要重载插件；
  status 必须提示。
- 仓库重命名/转移后别名 slug 的兼容期长度。
- N 个 MCP 子进程的内存与启动成本；先按 2–5 个仓库设计，不做池化。
- 显式 `mmw_tools_bind` 是否值得新增 control-plane operation。
- 审计文件是否需要 `repo` 字段的稳定 schema（现在只有 tool/decision）。

## 10. 明确不做

多租户、按仓库的独立部署、Kubernetes、消息队列、重型可观测性；也不把客户端
gate 当成仓库权限隔离。新增仓库只改注册表、授予、规则文件与本地缓存，不改
能力契约。
