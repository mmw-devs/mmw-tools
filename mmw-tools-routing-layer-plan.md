# 功能路由与授权层设计

> Status: **living design**（v5，2026-11-10）
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
gate 使用同一规则。当前契约尚未填 operation 级角色；这是待产品确认的下一步，不是
已交付能力。

### 2.3 身份在 auth core，执行在插件

auth core 拥有成员、角色、插件 token 和路由表；插件只消费路由表，不落盘角色，
不自行推导权限。这样：

- 角色变更只有一个写入口；
- 插件被篡改也不能凭空造出授权（它仍需要 auth core 签发的 token 和路由表）；
- 但插件 gate **不是安全边界**：它防误操作和误配置，真正的边界在 broker 签发、
  GitHub App 权限、branch protection 和 CI。任何“客户端授权”改动都必须同时说明
  服务端对应物。

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
5. `pr_merge` 这类高危写操作在放行前还有宿主确认。

“先拒绝、再询问”保证确认框不会成为绕过策略的入口。

## 3. 一次调用的路径

```
DSH agent
  → workspace guard（工作区边界，防误改）
  → Feishu gate（token、路由表、operation 级判定）
  → MCP transport（stdio，独立子进程）
  → race-ops tool
  → GitHub broker / git
  → 审计（auth core events + 插件本地记录）
```

workspace guard 与 gate 是两道独立的闸：前者限制“能碰哪个目录”，后者限制“能调用
哪个操作”。任何一道失败都拒绝，不互相替代。

## 4. 信任边界

| 层 | 能保证什么 | 不能保证什么 |
|---|---|---|
| 插件 gate | 正常路径下不发起未授权调用；误配置早失败 | 被篡改的插件、直接调用 broker 的进程 |
| auth core | 身份、角色、路由表、撤销 | 已签发 token 在过期前的滥用 |
| GitHub broker | 只使用被授予的 App 权限；签发短期凭证 | 权限本身是否过大 |
| branch protection | 目标分支的合并规则 | 其他分支、其他仓库 |
| CI | 契约/构建/测试通过才可合并 | 运行时行为 |

结论：授权改动必须成对出现——客户端限制 + 服务端可验证的对应物。只改 gate 的
PR 不算安全修复。

## 5. 失败语义

- **没有 token**：除状态工具外全部拒绝；不启动匿名降级。
- **auth core 不可达**：拒绝，不使用上次缓存“续命”；读也不放行。
- **角色被撤销**：下一次路由表刷新后，写操作在短 TTL 内被拒绝；在途调用不追杀。
- **策略版本变化**：以最新拉取到的表为准；插件目前不做 revision 单调比较。
- **MCP server 启动失败**：插件初始化失败，不注册半套工具。
- **broker 会话过期**：写工具返回可诊断错误，由用户在设置面板重新登录。

回滚当前是“停用插件/关闭 gate 后重启宿主”。`router.mode: legacy` 是目标设计里的
开关，尚未实现；不要把文档里的旧开关当成现成能力。

## 6. 已知缺口

按影响排序：

1. **角色阶梯尚未做真实账号冒烟**：契约、policy、gate、契约校验都已支持并在
   `tools.json` 落地 viewer/editor/operator/admin 阶梯；还缺一次用真实飞书账号
   走完“viewer 只读、editor 不能 merge、operator 可 merge”的手工验证。
2. **路由表刷新仍然简单**：有内存缓存、过期重拉、写操作 15s 上限、进程内
   policyRevision 单调；没有 STALE 宽限期、退避、single-flight。读失败也立即拒绝。
3. **runId 只贯穿插件侧**：gate、MCP、audit 已串起来；broker 与 auth core 尚未接收，
   所以跨服务仍无法 join。2GB 机器上优先 SQLite/JSONL，不引入 Jaeger/Elasticsearch。
4. **MCP server 在插件启动时就拉起**：与目标状态机的“未授权不启动 Transport”
   不一致；当前靠 gate 在调用时拒绝。
5. **无 rate limiting**：单仓库、单用户场景暂时可接受，多用户前必须补。
6. **无多仓库**：repo binding 仍是单仓库；第二 feature 要等单仓库闭环稳定。

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
- **v5（本文）**：把易漂移的事实移入生成文件；本文只保留设计与边界，历史细节
  交给 git 和旧版文档，不再在正文维护。

## 9. 相关文档

- 当前契约矩阵：[`contracts/REFERENCE.md`](contracts/REFERENCE.md)
- 契约说明：[`contracts/README.md`](contracts/README.md)
- 目标状态机：[`mmw-tools-routing-state-machine.md`](mmw-tools-routing-state-machine.md)（target design，不是现状）
- 部署：[`mmw-tools-auth/deploy/README.md`](mmw-tools-auth/deploy/README.md)
- 文档规则：[`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md)
