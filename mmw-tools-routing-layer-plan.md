# 功能路由与授权层设计

> Status: **living design**（v7，2026-11-12）
> 定位：解释授权层**为什么**长成现在这样、边界在哪里、哪些能力还没有做。
> 事实来源：工具/角色/操作以 [`contracts/tools.json`](contracts/tools.json) 与
> [`contracts/roles.json`](contracts/roles.json) 为准；人类可读的当前矩阵见
> [`contracts/REFERENCE.md`](contracts/REFERENCE.md)（生成文件，勿手改）。
> 实现入口：[`mmw-tools-auth/src/policy.mjs`](mmw-tools-auth/src/policy.mjs)、
> [`dsh-mmw-tools/src/gate/`](dsh-mmw-tools/src/gate/)。
> 文档规则见 [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md)。

本文不再复制工具数量、操作清单、端点表或 TTL 常量。那些信息变化频繁，复制即漂移。
需要精确值时看生成文件或代码；本文只保留稳定的设计判断。

---

## 1. 问题

一个 DSH agent 会同时面对三类“权限”：

1. **飞书身份**：谁在操作，属于哪些组织、哪些角色。
2. **工具授权**：这个身份能否消费某个工具/操作。
3. **执行能力**：broker 的 GitHub App 能写哪些仓库，branch protection 和 CI 是否放行。

早期设计把它们压成一张 role → permission 表，结果每个新工具都要同时改角色、
权限、路由和文档，四处漂移。现在拆成三个独立层，每层只回答一个问题。

## 2. 设计决定

### 2.1 工具是静态注册的

插件启动时把本地实现的全部工具注册进 DSH，登录、登出、角色变化都不增删工具。
理由：

- DSH 的工具列表是会话级的，动态增删会让模型看到的能力随登录状态跳变；
- “工具可见但无权调用”比“工具消失”更容易解释，也避免缓存未刷新时误判；
- 撤销授权只需让下一次调用被拒绝，不需要卸载工具或重启宿主。

代价是工具名对未授权用户可见。这是有意的：工具名不是秘密，执行边界在 gate 和
服务端，不在“看不见”。

### 2.2 契约是 tool-centric 的

契约描述“每个工具/操作需要什么”，而不是“每个角色拥有什么权限”：

- `tool.roles`：哪些角色可以消费这个工具；
- `operation.roles`（可选）：在工具内部进一步收窄某个操作；
- `tool.requiredPermissions`：工具自身执行时需要的能力，**不是**用户授权；
- `tool.always`：所有已认证成员都可用的工具（目前只有状态查询）。

没有 role → permission 映射。角色是消费资格，permission 是执行侧技术需求，两者
不应互相推导。这样新增工具时只改工具声明，不必重算角色权限表。

`operation.roles` 的解析规则是 `operation.roles ?? tool.roles`，auth core 和插件
gate 使用同一规则。当前契约已为 `race-ops` 的读、编辑、开 PR、合并等 operation
分别填了角色（见 `contracts/tools.json`）。

### 2.3 身份在 auth core，执行在插件

auth core 拥有成员、角色、插件 token 和路由表；插件只消费路由表，不落盘角色，
不自行推导权限。这样：

- 角色变更只有一个写入口；
- 插件被篡改也不能凭空造出授权（它仍需要 auth core 签发的 token 和路由表）；
- 插件 gate **不是安全边界**：它防误操作和误配置。真正的边界有两层：broker
  在接受飞书 plugin token 时会重新调用 auth core 的路由表；客户端 token 始终
  只读，`repo_edit`/`pr_create`/`pr_close`/`pr_merge` 每次调用都要在 broker 侧
  重新校验 operation，写 token 只留在 broker 内存。再往外是 GitHub App 权限、
  branch protection 和 CI。任何“客户端授权”改动都必须同时说明服务端对应物。
- 2026-11-11 之前 broker 只认 GitHub session，所以飞书 gate 的判断无法约束
  直接调用 broker 的进程；2026-11-12 起飞书 token 与 GitHub session 的写操作
  都在 broker 侧按 operation 授权。

### 2.4 读可以短暂陈旧，写必须 fail closed

路由表有 TTL，读操作允许在 TTL 内使用缓存，写操作使用更短的上限。原因：

- 每次调用都同步请求 auth core 会让 2GB 单机上的延迟和可用性都变差；
- 写操作影响仓库，宁可多一次刷新，也不能用过期授权放行。

当前实现是“缓存过期就重新拉；拉取失败就拒绝”，没有 stale-while-revalidate 的
宽限期，也没有退避状态机。目标设计里的 grace/backoff 尚未实现，见第 6 节。

### 2.5 gate 的顺序是 deny → ask → allow

一次工具调用依次经过：

1. 只处理本插件命名空间的工具；宿主标准工具与其他插件直接放行。
2. 未知的本插件工具一律拒绝（fail closed）。
3. 没有可用 token 时，`mmw_tools_status` 仍可用，其余拒绝并提示登录。
4. 不在路由表 `allowedOperations` 中的操作拒绝；父工具 allowed 不代表操作 allowed。
5. `pr_merge` 这类高危写操作在放行前还有宿主确认与 broker 的一次性 approval
   （绑定 PR、head SHA，5 分钟、单次使用）；`pr_close` 同样要宿主确认，但
   不需要 approval nonce（关闭不合并，且 broker 会拒绝非 `content/*` 或
   错误 base 的 PR）。
6. 业务工具还要求当前会话已经用 `mcp__mmw-tools__select_repo` 选定仓库；未选
   即拒绝，`select_repo` 本身豁免。选定后不能在同一会话改选其他仓库。
   `select_repo` 的放行发生在授权表之前：它只改本地会话状态，因此不查
   `allowedOperations`（授权表可能滞后于插件部署）；其余业务工具仍按
   Policy → Repo 顺序检查。

“先拒绝、再询问”保证确认框不会成为绕过策略的入口。

拒绝消息以稳定错误码开头（`[mmw_route_denied]`、`[mmw_policy_unavailable]`、
`[mmw_auth_required]`、`[mmw_session_expired]`、`[mmw_contract_mismatch]`），
中文说明在后；码表与“哪一层发哪个码”见 [`contracts/ERRORS.md`](contracts/ERRORS.md)。
`mmw_tool_unavailable` 仍在目标设计里：传输层尚未把启动失败或崩溃包装成这个码，
插件 README 与 `docs/CONFORMANCE.md` 都按“未发出”记录。

## 3. 一次调用的路径

```
DSH agent
  → workspace guard（管辖范围：注册表 + 工作区 Git remote + 规则标记，防误用）
  → Feishu gate（token、路由表、operation 级判定、会话仓库选择）
  → MCP transport（stdio，独立子进程；`_meta.mmwRepo` 选工作副本与仓库配置）
  → race-ops tool（读走本地 git；写请求转发到 broker）
  → GitHub broker（读 token 只读；写操作逐次校验 operation 与 base 分支契约；
     GitHub session 另过允许名单；按 operation 使用内存中的 write token；
     close 另查分支归属）
  → 审计（auth core events + 插件本地记录 + broker 写审计）
```

workspace guard 与 gate 是两道独立的闸：前者限制“当前工作区是否归 mmw-tools
管辖”，后者限制“能调用哪个操作”。任何一道失败都拒绝，不互相替代。guard 不是
安全边界：它不阻止直接调用 broker，也不替用户选择别的工具。

## 4. 信任边界

| 层 | 能保证什么 | 不能保证什么 |
|---|---|---|
| 插件 gate | 正常路径下不发起未授权调用；误配置早失败 | 被篡改的插件、直接调用 broker 的进程 |
| auth core | 身份、角色、路由表、撤销 | 已签发 token 在过期前的滥用 |
| GitHub broker | 客户端只拿只读 token；写操作逐次校验 operation；校验 GitHub 允许名单或飞书路由表；write token 不出 broker 内存；merge 需要一次性 approval，并从 base 分支校验契约；close 校验分支归属 | 权限本身是否过大；本地进程可自行调用 approval 接口；broker 内存或宿主机被攻破；归属账本丢失时只允许 operator/admin 关闭 |
| branch protection | 目标分支的合并规则 | 其他分支、其他仓库 |
| CI | 契约/构建/测试通过才可合并 | 运行时行为 |

结论：授权改动必须成对出现——客户端限制 + 服务端可验证的对应物。只改 gate 的
PR 不算安全修复。

## 5. 失败语义

- **没有 token**：除状态工具外全部拒绝；不启动匿名降级。
- **auth core 不可达**：拒绝，不使用上次缓存“续命”；读也不放行。
- **角色被撤销**：写操作每次调用都重查，下一次调用即拒绝；已发出的读 token
  仍可用到过期（最多 1 小时）。在途调用不追杀。
- **策略版本变化**：以最新拉取到的表为准；插件目前不做 revision 单调比较。
- **MCP server 启动失败**：插件初始化失败，不注册半套工具。
- **broker 会话过期**：写工具返回可诊断错误，由用户在设置面板重新登录。

回滚当前是“停用插件/关闭 gate 后重启宿主”。`router.mode: legacy` 是目标设计里的
开关，尚未实现；不要把文档里的旧开关当成现成能力。

## 6. 已知缺口

按影响排序：

1. **角色阶梯还缺完整账号冒烟**：viewer 的越权拒绝已由维护者于 2026-11-12
   在线验证（`mmw_route_denied`）；editor 不能 merge、operator 可 merge 仍缺
   一次真实账号手工验证。
2. **路由表刷新仍然简单**：有内存缓存、过期重拉、写操作 15s 上限、进程内
   policyRevision 单调；没有 STALE 宽限期、退避、single-flight。读失败也立即拒绝。
3. **runId 只贯穿插件侧**：gate、MCP、audit 已串起来；broker 与 auth core 尚未接收，
   所以跨服务仍无法 join。2GB 机器上优先 SQLite/JSONL，不引入 Jaeger/Elasticsearch。
4. **MCP server 在插件启动时就拉起**：与目标状态机的“未授权不启动 Transport”
   不一致；当前靠 gate 在调用时拒绝。
5. **无 rate limiting**：单仓库、单用户场景暂时可接受，多用户前必须补。
6. **多仓库已打通注册表读取与按仓库授权**：`select_repo`、会话锁定、`_meta.mmwRepo`、
   每仓库工作副本/令牌与 broker 路由已实现；auth core 的 `repos` 表、管理 UI 与
   `GET /v1/agent/repos` 已落地；插件启动读本地缓存
   `~/.dsh/mmw-tools-repos.json`，`select_repo` 时刷新注册表并以服务端为准。
   `grants(member, repo, role)` 与 `GET /v1/agent/routes?repo=` 已落地：无授予返回
   空 operation 表，不回退全局角色。`.dsh-mmw-tools.yaml` 运行时规则已落地：
   `select_repo` 经 broker 的 `GET /repo-policy?repo=` 读取仓库根文件，缺失或非法时
   失败关闭，不退回 profile 副本；规则随注册表一起写入本地缓存，供 MCP 每次调用
   覆盖。缓存意味着管理端新增仓库要到下一次插件加载才出现在本机可用集合中。
   部署 grants 前必须先给现有维护者账号按仓库授权，否则会被全拒。
7. **approval 不绑定“人真的点了确认”**：一次性的 approval 绑定 member、PR、
   head SHA，且 5 分钟过期；但能读 `0600` 写认证文件并直接发 HTTP 的本地进程
   可以自调用 approval + merge。宿主对 `pr_merge` 的确认只是 UI 门，关闭这个
   缺口需要 host-only 的 merge secret。
8. **读写撤销延迟不同**：写操作每次调用都重查路由表，撤销立即生效；已经发出的
   只读 installation token 仍可用到过期（最多 1 小时）。
9. **写代理状态只在内存**：幂等结果与 approval 重启即丢；审计是单文件 JSONL，
   不自动轮转。多实例前需要 SQLite 或外部存储。
10. **凭据刷新不是免检路径**：installation token 命中缓存时仍要重写
   `write-auth`；状态投影也必须先 mint 再读视图，否则重新登录后会显示或使用
   上一个身份的凭据。
11. **工作区管辖不是安全边界**：guard 用注册表 + 工作区 `origin` remote +
   `.dsh-mmw-tools.yaml` 标记判断相关性，只拒绝“不归它管”的调用，不阻止直接
   调用 broker，也不替用户指定替代工具。没有 remote 的目录（导出包、非 git
   副本）只能判为 `unmanaged`/`mismatch`，不能凭标记文件推断仓库身份。

## 7. 明确不做

- 不做 role → permission 映射；
- 不因授权变化动态卸载工具；
- 不在客户端做“隐藏工具”式安全；
- 不为平台化重写路由层；
- 不在 2GB 生产机上默认常驻 Postgres/Redis/Docker；
- 不在没有服务端对应物的情况下新增“授权”功能。

## 8. 演进记录

- **v2（permission-centric）**：角色直接映射权限，新增工具需要同时改角色与权限表，
  已废弃。早期文档里的旧权限名和旧目录格式不再维护。
- **v3**：静态注册 + 调用时检查，引入 auth core 下发的路由表。
- **v4**：契约改为 tool-centric，插件 gate 落地，auth core Phase 1 部署。
- **v5**：把易漂移的事实移入生成文件；本文只保留设计与边界，历史细节
  交给 git 和旧版文档，不再在正文维护。
- **v6（2026-11-11）**：broker 新增飞书 plugin token 入口，按 auth core 路由表
  决定 read/write 并收窄 installation token；GitHub 组织/白名单路径保留。
- **v7（2026-11-12）**：读写分离落地。客户端 installation token 一律只读；
  `repo_edit`/`pr_create`/`pr_close`/`pr_merge` 改为 broker `/v1/write/*` 代理，
  逐次校验 operation，write token 不出 broker；merge 增加一次性 approval，
  close 只要求宿主确认（不合并、不删分支）。
  残留是“本地进程可自调用 approval”，见 §6。
- **v8（2026-11-13）**：多仓库执行侧落地。新增 `select_repo` 与门禁的会话级
  仓库绑定；插件经 `_meta.mmwRepo` 把选择传给 MCP 子进程，按 `MMW_REPOS`
  解析每仓库工作副本/基线/令牌；broker 读令牌与写代理均按 `repo` 路由。
  `select_repo` 在授权表之前按本地会话状态判定，业务工具仍受
  `allowedOperations` 约束；仓库注册表、按仓库授权与运行时规则文件仍是
  目标设计，见 ADR-0001。
- **v9（2026-11-13）**：auth core 增加仓库注册表（`repos` 表、管理员
  `PUT /api/admin/repos`、管理 UI、插件只读的 `GET /v1/agent/repos`）。
  注册表是仓库事实的服务端源；插件尚未改为从它读取，`grants` 与运行时
  规则文件仍待实现。
- **v10（2026-11-13）**：插件接入注册表。启动时同步读
  `~/.dsh/mmw-tools-repos.json` 并覆盖 profile `repos`；`select_repo` 先调
  `GET /v1/agent/repos`，未启用/未知仓库拒绝，成功后写回缓存。未启用飞书的
  profile 仍只读本地 `repos`。剩余：`grants(member, repo, role)`、
  `.dsh-mmw-tools.yaml`、按仓库收窄账号级 operation 集合。
- **v11（2026-11-13）**：按仓库授权落地。auth core 新增
  `grants(member, repo, role)` 表与管理 UI 编辑；`GET /v1/agent/routes?repo=`
  只按该仓库 grants 派生 operation 集合，无授予返回空表、不回退全局角色。
  `select_repo` 在绑定前读取该仓库授权，没有 `select_repo` 角色即拒绝；
  业务调用也带同一 `repo` 取表，仓库不一致按 `[mmw_contract_mismatch]` 拒绝。
  剩余：`.dsh-mmw-tools.yaml`。
- **v12（2026-11-13）**：运行时规则文件落地。broker 从 base 分支读取并校验
  `.dsh-mmw-tools.yaml`（`GET /repo-policy?repo=`），写路径与 `pr_create` 默认
  draft 用它；文件缺失/非法/不可达一律 503 且不退回 profile。`select_repo`
  读取规则后覆盖内存 entry 与缓存，MCP 每次调用从缓存覆盖路径与 preflight。
  本次没有改变“本地进程可自调用 approval”的边界。
- **v13（2026-11-13）**：工作区管辖与写边界补强。guard 从“路径 roots”改为
  “注册表 + 工作区 `origin` remote + 规则标记”的 `managed`/`unmanaged`/
  `mismatch`/`bootstrap`/`unknown` 模式；`select_repo` 在绑定前拒绝未管辖或
  与工作区不一致的选择；`mmw_tools_status` 报告 `workspace`。broker 在
  approval 与 merge 前从 base 分支校验 `contract/operations.json`，PR 改契约
  直接拒绝；close 增加 `<repo>#<branch> → login` 归属账本，非作者且非
  operator/admin 返回 `pr-not-owned`。工作区模式是相关性判断，不是安全边界。

## 9. 相关文档

- 当前契约矩阵：[`contracts/REFERENCE.md`](contracts/REFERENCE.md)
- 契约说明：[`contracts/README.md`](contracts/README.md)
- 目标状态机：[`mmw-tools-routing-state-machine.md`](mmw-tools-routing-state-machine.md)（target design，不是现状）
- 部署：[`mmw-tools-auth/deploy/README.md`](mmw-tools-auth/deploy/README.md)
- 文档规则：[`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md)
