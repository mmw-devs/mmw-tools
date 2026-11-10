# 多仓库路由设计对比

Status: target design

本文是比较方案，不是已交付行为。**当前实现仍然是单仓库绑定**：
[`dsh-mmw-tools/cordis.patch.yml`](../dsh-mmw-tools/cordis.patch.yml) 的
`repoBinding` 注释写明是唯一仓库，`dsh-mmw-tools/src/gate/workspace-guard.ts`
以单一 `workingDir` 为根，MCP 子进程从一份固定的绑定 env 启动。下面 A/B/C
三个方案都未实现。

## 问题不在“加一个字段”

授权判定发生在 `dsh-mmw-tools/src/gate/gate.ts`，它的输入只有 publicName
（`mcp__mmw-tools__repo_read` 之类），拿不到“这次调用打在哪个仓库”。因此多仓库
要回答的是：**在启动 MCP 子进程之前，gate 怎么知道仓库？** 只改 route table
而不改调用面，这个问题仍然存在。

需要同时动的四层：

1. `contracts/tools.json`：tool/operation 标识是否带仓库作用域，以及仓库绑定
   是否属于契约。
2. `mmw-tools-auth/src/policy.mjs`：`allowedOperations` 的键是否带仓库。
3. `dsh-mmw-tools/src/gate/tool-map.ts` 与 `gate.ts`：publicName → 仓库的映射
   和拒绝时机。
4. MCP 传输与 workspace guard：每个仓库的 `workingDir`、允许路径、子进程生命周期。

## A. 仓库进工具面（每个仓库一组工具别名）

profile 里每绑定一个仓库，就注册一组带仓库后缀的工具名；gate 从 publicName
直接得到仓库，在启动 MCP 之前完成判定。

- **授权**：最强。客户端无法通过参数换仓库，`mmw_route_denied` 可以在传输启动
  前返回，符合 [`contracts/ERRORS.md`](../contracts/ERRORS.md) 的“拒绝不得启动
  MCP 子进程”。
- **代价**：工具名随仓库数增长；需要 N 个 MCP 子进程或按仓库切换绑定；contract
  要表达“仓库是 profile 绑定还是契约条目”；`mmw_tools_status` 要按仓库汇总。
- **契约问题**：静态 `contracts/tools.json` 不应该为每个仓库手写一条；更可能
  是契约定义“能力 + 仓库作用域规则”，profile 提供仓库清单，`TOOL_MAP` 在启动时
  由两者生成，并由一致性测试守住。

## B. 仓库进 route table 维度

`allowedOperations` 的键变成仓库作用域，例如
`race-ops@owner/name.repo_read`；`policy.mjs` 的 `routeTable` 按仓库展开。

- **单独做不够**：gate 仍只知道 publicName。除非 publicName 同时带仓库（那就
  回到 A），或者 gate 读取调用参数里的仓库（那就退化成 C）。
- **价值**：它是 A 的授权表达方式。A 提供“调用面带仓库”，B 提供“授权表按仓库
  记账”，两者可以组合。
- **代价**：schema、`REFERENCE.md`、golden route tables、`TOOL_MAP`、`policy.mjs`
  全要改；旧 key 需要兼容或迁移。

## C. 仓库作为调用参数

每个 operation 增加 `repo` 参数，由 MCP server 解析并在执行层校验路径。

- **代价最小**：契约与 route table 形状基本不动。
- **弱点**：授权发生在调用之后，gate 无法在启动前判断仓库；撤销某个仓库的权限
  只能靠执行层拒绝，不能称为隔离边界。
- **定位**：只能作为过渡或内部工具，不应作为多仓库授权的最终形态。

## 推荐

选 **A**，并把 B 作为它的 route table 表达方式（仓库作用域的操作 id）。理由：

1. 错误契约要求“拒绝不启动传输”，只有调用面携带仓库才能做到。
2. `race-ops` 是能力名，仓库是部署绑定；把仓库放进 profile 驱动的工具面，
   比把仓库写死进静态契约更符合 SSOT 的分层。
3. C 把安全判断推到执行层，和现有“gate 是防误操作、不是隔离边界”的定位叠在
   一起会变得难以解释。

不推荐 C 作为唯一机制。

## 若选 A，改动面

- `contracts/`：定义仓库作用域的命名规则；确认 `REFERENCE.md` 生成器能表达
  “能力 × 仓库”；golden 表按角色 + 仓库生成。
- `mmw-tools-auth/src/policy.mjs`：`routeTable` 接受仓库作用域，角色判定仍按
  tool/operation。
- `dsh-mmw-tools/src/gate/`：`TOOL_MAP` 从 profile 生成；`gate.ts` 解析仓库；
  未知仓库 fail closed。
- `dsh-mmw-tools/src/index.ts`：按仓库启动/复用 MCP 子进程，绑定各自的
  `GHOST_WORKING_DIR` 与仓库 URL。
- `dsh-mmw-tools/src/gate/workspace-guard.ts`：从单根改为按仓库的根集合。
- broker/GitHub App：确认 installation token 的仓库范围能覆盖多仓库（O5 实测，
  不能只靠推断）。

## 未实现

全部。当前没有仓库维：契约、route table、`TOOL_MAP`、workspace guard、MCP
绑定都是单仓库。`mmw_tools_status` 也不汇总多仓库。

## 实现后的验收

- 两个仓库、两个角色交叉：对仓库 A 可写、对仓库 B 只读；对 B 的写调用在 MCP
  启动前被拒，并带 `[mmw_route_denied]`。
- 审计事件能区分仓库；拒绝原因不含路径外的敏感信息。
- 契约生成物、`TOOL_MAP`、golden 表一致；CI 能拦住漏改。
- 至少一个真实 GitHub 仓库走完整 clone → edit → PR 流程。
