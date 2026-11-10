# 多仓库路由：SSOT 分层与方案对比

Status: target design

本文是比较方案，不是已交付行为。**当前实现仍然是单仓库绑定**：
[`dsh-mmw-tools/cordis.patch.yml`](../dsh-mmw-tools/cordis.patch.yml) 的
`repoBinding` 注释写明是唯一仓库，`dsh-mmw-tools/src/gate/workspace-guard.ts`
以单一 `workingDir` 为根，MCP 子进程从一份固定的绑定 env 启动。下面所有方案
都未实现。

## 1. 先把“单源”拆成四件事

“多仓库要符合 SSOT”这句话本身不够精确，因为这里其实有四类事实，各有各的
唯一源。把其中两类合成一份配置，就会得到“看似统一、实际互相覆盖”的假单源。

| 事实 | 今天的唯一源 | 多仓库时应放的位置 | 放错位置的后果 |
|---|---|---|---|
| 能力契约：有哪些 operation、风险级别、需要什么权限 | [`contracts/tools.json`](../contracts/tools.json) + [`contracts/roles.json`](../contracts/roles.json) | 不变，保持仓库无关 | 每加一个仓库就复制一份 operation 定义，语义开始漂移 |
| 仓库操作规则：允许改哪些路径、分支前缀、preflight | `ffxiv-race-ops/AGENTS.md`；`cordis.patch.yml` 只是**临时镜像**（[`OPERATIONS-SYNC.md`](../dsh-mmw-tools/docs/OPERATIONS-SYNC.md) 已承认这是 deliberate SSOT violation） | 每个仓库自己的 `.dsh-mmw-tools.yaml` | 仓库规则被抄进插件配置，仓库一改就要改插件 |
| 部署绑定：这个实例打哪个仓库、用哪个工作区、哪个 GitHub App installation | `cordis.patch.yml` 的 `repoBinding`（单仓库） | 每个仓库一个 profile / 实例 | 一个字段被迫承担 N 个仓库，实例之间互相污染工作区 |
| 授权授予：哪个成员能在哪个仓库做哪些 operation | auth core 的成员角色（全局，没有仓库维） | `(member, repo, role)` 的授予表 | 授权与仓库脱节，或者把仓库编进 capability 名 |

**SSOT 判据**：新增一个仓库，只应该改后三行（规则文件、绑定、授予），
不应该改第一行（能力契约）。反过来，如果加仓库必须新增 operation、复制
`allowedOperations` 条目、或改 `TOOL_MAP`，就说明能力契约吸收了部署数据。

## 2. 当前模型把“能力”和“授予”混在了一起

- `mmw-tools-auth/src/policy.mjs` 的 `routeTable(member)` 从成员角色派生一份
  **全局** `allowedOperations`，没有仓库维。
- `PolicyGate` 只知道 publicName。`dsh-mmw-tools/src/index.ts:913` 构造它时
  只传了 `auth` / `enabled` / `sessionWide`，**没有传 binding**；所以 gate 今天
  既不知道“这次调用打在哪个仓库”，也无法校验 route table 是不是给这个仓库的。
- 单仓库时，“成员能做什么”和“成员能在这个仓库做什么”恰好重合，所以看不出
  问题。多仓库把这个重合拆开，缺口才暴露。

因此多仓库的核心不是“给 operation id 加一个后缀”，而是决定：
**仓库是 capability 的身份，还是 grant 的作用域？**

## 3. 三个方案按 SSOT 判据比较

### A. 仓库进工具身份（每个仓库一组工具别名）

profile 每绑定一个仓库，就注册一组带仓库后缀的工具名；gate 从 publicName
直接得到仓库，在启动 MCP 之前完成判定。

- **手写契约**：`tools.json` 要为 N 个仓库写 N 份 operation，直接违反第 1 节
  第一行。改一个 operation 的语义要改 N 处，`REFERENCE.md`、golden 表、测试
  同步膨胀。
- **生成契约**：静态源仍是单份，但授予被编码进名字（`race-ops@owner/name`），
  `TOOL_MAP`、golden、status、broker 都要解析名字；每个消费者的运行时面随
  仓库数增长。
- **它真正解决的问题**：一个进程/实例同时服务多个仓库，且调用方在调用时选择
  仓库。没有这个需求时，代价大于收益。

### B. 仓库进 route table（授权作用域）

`routeTable(member, repo)` 返回该成员在**这个仓库**上的 `allowedOperations`，
响应里带 `repo`；gate 用绑定仓库校验它。

- **方向正确**：仓库是 grant 的一个维度，不是 capability 的一部分；授予表是
  唯一源，route table 是派生结果。
- **与“每仓库一个实例”配合时足够**：gate 从 binding 就知道仓库，不需要
  publicName 带仓库；MCP 子进程、workspace guard、工作区本来就该按实例隔离。
- **单独把 operation id 改成 `race-ops@owner/name.repo_read` 不够**：那只是把
  仓库又编进了名字，回到 A 的运行时膨胀，且没有回答“谁授予了这个仓库”。

### C. 仓库作为调用参数

每个 operation 增加 `repo` 参数，由 MCP server 解析并在执行层校验路径。

- 授权发生在调用之后，gate 无法在启动前判断仓库；客户端可以换参数。
- 只能作为过渡或内部工具，**不应作为多仓库授权的最终形态**。

## 4. 推荐：能力单源，仓库作授权作用域

选择 **B + 每仓库一个绑定实例 + 每仓库规则文件**。四层各自保持单源：

1. **能力契约**（`contracts/`）：形状不动。`race-ops.repo_read` 这类能力名
   与仓库无关；新增仓库不新增 operation，也不改 `TOOL_MAP`。
2. **授权**（auth core）：增加 `(member, repo, role)` 授予表；单仓库过渡期可以
   用 `*` 表示“当前唯一仓库”，避免一次性迁移所有成员。`routeTable` 按
   `(member, repo)` 派生，响应增加 `repo` 字段；管理 API 按仓库管授予。
3. **绑定与判定**（plugin）：每个仓库一个 profile/实例，`PolicyGate` 构造时
   接收 `boundRepo`（`index.ts:913` 本来就有 binding），`check()` 校验
   `routes.repo === boundRepo`；缺失 `repo` 时按单仓库兼容放行，但要在 status
   里标成未校验。公共工具名不变。
4. **仓库规则**（目标仓库）：按 [`OPERATIONS-SYNC.md`](../dsh-mmw-tools/docs/OPERATIONS-SYNC.md)
   的 v2 方案，从绑定仓库的 base commit 拉 `.dsh-mmw-tools.yaml` 作为运行时
   authority；`cordis.patch.yml` 只留路径、OAuth 与仓库坐标，删掉四个镜像字段。
   拉取记录 blob sha；写操作在文件缺失或指纹不一致时 fail closed
   （`[mmw_policy_unavailable]`），读操作可降级但 status 必须显示。

**为什么不是 A**：gate 已经能从 binding 知道仓库，把仓库编进工具名不会带来
新的安全性质，却让授予表、golden、status、broker 都按名字展开；手写版本更是
直接复制契约。它只在“单实例多仓库并发”成为真实需求时才值得。

**为什么不是 C**：它把授权判断推到执行层，和“gate 是防误操作、不是恶意本地
用户的隔离边界”的定位叠加后，无法解释“撤销仓库权限”到底在哪一层生效。

## 5. 改动面（B+ 方案）

- `mmw-tools-auth/src/store.mjs`：新增 grants 表与迁移（现有成员 → 当前角色 ×
  唯一仓库）；`policy.mjs` 的 `routeTable` 接受 `(member, repo)`。
- `mmw-tools-auth/src/server.mjs`：`/v1/agent/routes` 接受绑定仓库并回填
  `repo`；新增按仓库的授予管理端点；审计记录授予变更。
- `dsh-mmw-tools/src/gate/gate.ts`：`PolicyGate` 选项加 `repo`，校验响应中的
  `repo`；不匹配 fail closed。
- `dsh-mmw-tools/src/index.ts:913`：把 `binding.owner/binding.name` 传进 gate。
- `dsh-mmw-tools/src/gate/tool-map.ts`：**不变**（这是本方案相对 A 的主要收益）。
- `workspace-guard.ts`：逻辑不变；确认多实例不共享 `roots`，每个实例只看到
  自己的 `workingDir`。
- `mmw_tools_status`：报告 repo、catalog revision、policy revision、规则来源
  与是否已校验。
- broker：实测 installation token 的仓库范围能覆盖多仓库，不能只靠推断。

## 6. 实现后的验收

- **SSOT 判据**：新增仓库 B 只改授予、profile、B 的规则文件；`contracts/` 与
  `TOOL_MAP` 的 diff 为零。
- 同一成员对 A 可写、对 B 只读：对 B 的 `repo_edit` 在 MCP 启动前被拒，带
  `[mmw_route_denied]`；对 A 放行。
- 没有 B 授予的成员：拿不到 B 的 route table，插件 fail closed。
- gate 收到 `repo` 不匹配的 route table：拒绝并带码，不静默使用。
- B 的规则文件缺失或与 `AGENTS.md` 漂移：写操作拒绝，读操作降级，status 可见。
- 审计事件能区分仓库；拒绝原因不含绑定路径之外的敏感信息。

## 7. 未实现

全部。当前没有仓库维：契约、route table、`TOOL_MAP`、workspace guard、MCP
绑定都是单仓库。`mmw_tools_status` 也不汇总多仓库。
