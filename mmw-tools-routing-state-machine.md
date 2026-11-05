# mmw-tools 路由层状态机（v2：静态注册 + 调用时授权）

> 状态：已实现并在桌面宿主重启后完成读路径端到端验证，取代 v1「动态挂载」版本
> 日期：2026-10-26（2026-11-04 tool-centric 更新）
> 配套文档：[`mmw-tools-routing-layer-plan.md`](mmw-tools-routing-layer-plan.md)
> 范围：DSH 插件侧的授权执行状态机；飞书鉴权核心只作为输入事件出现。
> 当前授权单位是 tool（`allowed` tool IDs）；`allowedOperations` 是 operation 级明细。角色只决定能否消费工具；`requiredPermissions` 是工具自身能力。

---

## 1. 状态机边界

v2 的核心变化：

> **工具在插件启动时全部注册，之后不因登录、登出、权限变化而增删。授权只发生在每次调用之前。**

因此状态机从四个子状态机简化为三个主状态机 + 一个辅助状态机：

| 子状态机 | 粒度 | 回答的问题 |
|---|---|---|
| **Auth** | 插件实例 | 当前有没有有效身份和 pluginToken？ |
| **Policy** | 插件实例 | 当前有没有一份可用的授权表？是否新鲜？ |
| **Tool Call** | 每次调用 | 这次调用应该放行、拒绝，还是先刷新授权表？ |
| **Transport**（辅助） | 每个 feature | MCP 子进程/传输层是否已启动、是否健康？ |

**不再有 Feature 挂载状态机。** 工具注册是静态的；权限变化只影响 `allowed` 集合，不影响 DSH 工具注册表。

顶层状态是 Auth + Policy 的投影：

```
工具列表：始终是「全部已实现工具」
授权状态：由 Auth + Policy 决定
调用结果：放行 / 拒绝
```

---

## 2. 顶层状态（给 UI / `mmw_status`）

| 顶层状态 | 条件 | 用户看到 |
|---|---|---|
| `OFFLINE` | Auth = `SIGNED_OUT` / `AUTH_FAILED` | 工具全在；调用提示先登录 |
| `CONNECTING` | Auth = `LOGIN_PENDING` | 工具全在；等待浏览器授权 |
| `SYNCING` | Auth 有效；Policy = `FETCHING` | 工具全在；正在同步授权表 |
| `ACTIVE` | Auth 有效；Policy = `READY` | 工具全在；allowed 可调用 |
| `STALE` | Auth 有效；Policy = `STALE` | 工具全在；读可用、写可能被拒 |
| `BLOCKED` | Auth 有效；Policy = `INVALID` | 工具全在；没有可用授权表 |
| `EXPIRED` | Auth = `EXPIRED` | 工具全在；所有调用被拒 |
| `SIGNING_OUT` | Auth = `SIGNING_OUT` | 工具全在；调用被拒 |

```
   OFFLINE ──LOGIN_START──▶ CONNECTING ──POLL_AUTHORIZED──▶ SYNCING
      ▲                                                       │
      │                                                       │ POLICY_OK
      │                                                       ▼
      │                                                    ACTIVE
      │                                                       │
      │                                      POLICY_TTL/网络错误
      │                                                       ▼
      │                                                    STALE
      │                                                       │
      │                                      GRACE_EXPIRED     │
      │                                                       ▼
      │                                                    BLOCKED
      │
      └── LOGOUT_DONE ◀── SIGNING_OUT ◀── LOGOUT ── ACTIVE/STALE/BLOCKED
                                       ◀── EXPIRED ◀── TOKEN_EXPIRED/API_401
```

注意：**`OFFLINE` / `EXPIRED` / `BLOCKED` 都不卸载工具。** 它们只改变调用是否放行。

---

## 3. 状态变量与不变量

### 3.1 变量

| 变量 | 类型 | 说明 |
|---|---|---|
| `auth` | enum | `SIGNED_OUT` / `LOGIN_PENDING` / `AUTHENTICATED` / `REFRESHING` / `EXPIRED` / `AUTH_FAILED` / `SIGNING_OUT` |
| `token` | string? | pluginToken；内存 + 0600 文件 |
| `tokenExpiresAt` | number? | 毫秒时间戳 |
| `loginTx` | object? | `loginId` / `pollSecret` / `expiresAt` |
| `policy` | enum | `NO_POLICY` / `FETCHING` / `READY` / `STALE` / `INVALID` |
| `allowed` | Set<string> | 核心下发的允许 toolId 集合 |
| `denied` | Map<string, string> | `toolId → missingPermission`，只用于展示 |
| `policyRevision` | number | 授权版本 |
| `catalogRevision` | string | 功能目录版本 |
| `policyFetchedAt` | number? | 最近一次成功拉取时间 |
| `policyFreshUntil` | number? | 读工具可用的 TTL 截止 |
| `writeFreshUntil` | number? | 写工具要求的新鲜度截止 |
| `graceDeadline` | number? | `STALE` 的读 grace 截止 |
| `nextPolicyFetchAt` | number? | 失败退避时间点 |
| `transports` | Map<featureId, TransportState> | 每个 feature 的传输层状态 |
| `inflight` | object | `loginPoll` / `policyFetch` / `tokenRefresh` / `transportStart` 的单飞标记 |

### 3.2 不变量

1. **静态注册**：每个本地实现都在插件启动时注册一次；Auth/Policy 变化永远不新增或删除 DSH 工具。
2. 工具注册不依赖登录态；未登录时工具也存在。
3. 一次调用要执行，必须同时满足：Auth ∈ {`AUTHENTICATED`, `REFRESHING`}、`toolId ∈ allowed`、传输层 `READY`。
4. 未授权调用不能启动 MCP 子进程；检查顺序必须是 Auth → Policy → Transport。
5. Policy 不落盘；插件重启后必须重新拉取。没有可用授权表时：
   - `read` 工具：没有旧表就拒绝（无 grace 可依）；
   - `write` 工具：一律拒绝。
6. `policyRevision` 单调；低于当前值的响应丢弃。
7. `policyFetch` / `tokenRefresh` / `loginPoll` / `transportStart` 都是单飞。
8. `mmw_status` 永远可用，不依赖 Auth/Policy/Transport。
9. 退出登录/过期不清空工具注册表；只让调用被拒。
10. 写工具在授权表不新鲜（超过 `writeFreshUntil`）时必须同步刷新；刷新失败直接拒绝。

---

## 4. Auth 子状态机

### 4.1 状态图

```
                    LOGIN_START
   SIGNED_OUT ─────────────────▶ LOGIN_PENDING
        ▲                            │
        │                            │ POLL_AUTHORIZED
        │                            ▼
        │                       AUTHENTICATED ◀─────────────┐
        │                         │      │                  │
        │                         │      │ TOKEN_NEAR_EXPIRY│
        │                         │      ▼                  │
        │                         │   REFRESHING ──OK───────┘
        │                         │      │
        │                         │      ├──401──▶ EXPIRED
        │                         │      └──NETWORK──▶ AUTHENTICATED（保留旧 token）
        │                         │
        │                         ├──API_401 / TOKEN_EXPIRED──▶ EXPIRED
        │                         │
        │                         └──LOGOUT──▶ SIGNING_OUT ──REVOKE_DONE──▶ SIGNED_OUT
        │
        │  DENIED / EXPIRED / TIMEOUT
        └──────────────────────── AUTH_FAILED ──LOGIN_START──▶ LOGIN_PENDING
```

### 4.2 迁移表

| From | 事件 | Guard | 动作 | To |
|---|---|---|---|---|
| `SIGNED_OUT` | `LOGIN_START` | 没有进行中的 login | 调核心 `POST /v1/login/start`；保存 loginTx；启动轮询 | `LOGIN_PENDING` |
| `LOGIN_PENDING` | `POLL_PENDING` | loginTx 未过期 | 2s 后再次轮询 | `LOGIN_PENDING` |
| `LOGIN_PENDING` | `POLL_AUTHORIZED` | 返回 token + 到期时间 | 存 token；停轮询；触发 Policy 同步 | `AUTHENTICATED` |
| `LOGIN_PENDING` | `POLL_DENIED` | — | 停轮询；记录 reason | `AUTH_FAILED` |
| `LOGIN_PENDING` | `POLL_EXPIRED` | — | 停轮询；记录 reason | `AUTH_FAILED` |
| `LOGIN_PENDING` | `LOGIN_TIMEOUT` | 超过 5 分钟 | 丢弃 loginTx；停轮询 | `AUTH_FAILED` |
| `LOGIN_PENDING` | `LOGIN_CANCEL` | — | 丢弃 loginTx；停轮询 | `SIGNED_OUT` |
| `AUTH_FAILED` | `LOGIN_START` | — | 新 loginTx | `LOGIN_PENDING` |
| `AUTHENTICATED` | `LOGIN_START` | 已有有效 token | 忽略；不改变工具 | `AUTHENTICATED` |
| `AUTHENTICATED` | `TOKEN_NEAR_EXPIRY` | 剩余 < 24h | 启动单飞刷新 | `REFRESHING` |
| `REFRESHING` | `REFRESH_OK` | 新 token 有效 | 替换 token；更新到期时间 | `AUTHENTICATED` |
| `REFRESHING` | `REFRESH_401` | — | 清 token；Policy → `INVALID`；调用拒绝 | `EXPIRED` |
| `REFRESHING` | `REFRESH_NETWORK` | 旧 token 未过期 | 保留旧 token；记录 warning | `AUTHENTICATED` |
| `REFRESHING` | `REFRESH_NETWORK` | 旧 token 已过期 | 清 token；Policy → `INVALID` | `EXPIRED` |
| `REFRESHING` | `TOKEN_EXPIRED` | 刷新未在到期前完成 | 清 token；丢弃 refresh 结果 | `EXPIRED` |
| `REFRESHING` | `LOGOUT` | — | 丢弃 refresh 结果；开始 revoke | `SIGNING_OUT` |
| `AUTHENTICATED` | `TOKEN_EXPIRED` | 定时器到点 | 清 token；Policy → `INVALID` | `EXPIRED` |
| `AUTHENTICATED` | `API_401` | — | 清 token；Policy → `INVALID` | `EXPIRED` |
| `REFRESHING` | `API_401` | — | 清 token；丢弃 refresh 结果；Policy → `INVALID` | `EXPIRED` |
| `AUTHENTICATED` | `LOGOUT` | — | 拒绝新调用；best-effort revoke | `SIGNING_OUT` |
| `SIGNING_OUT` | `REVOKE_DONE` | — | 清 token/policy；保留工具注册表 | `SIGNED_OUT` |
| `SIGNING_OUT` | `REVOKE_TIMEOUT` | 超过 2s | 记录日志；强制清本地状态 | `SIGNED_OUT` |
| `EXPIRED` | `LOGIN_START` | — | 新 loginTx | `LOGIN_PENDING` |
| `EXPIRED` | `LOGOUT` | — | 清 token | `SIGNED_OUT` |
| 任意 | `PLUGIN_DISPOSE` | — | 关闭传输层；进程退出 | `SIGNED_OUT` |

### 4.3 进入状态时的动作

| 状态 | 进入动作 |
|---|---|
| `SIGNED_OUT` | 清 token/loginTx/policy；工具注册表保持不变 |
| `LOGIN_PENDING` | 启动轮询；面板显示 loginUrl |
| `AUTHENTICATED` | 触发 Policy 同步（如果 `NO_POLICY`/`INVALID`）；安排刷新 |
| `REFRESHING` | 单飞刷新；旧 token 继续可用于调用 |
| `EXPIRED` | 清 token；Policy → `INVALID`；所有调用拒绝；工具不卸载 |
| `SIGNING_OUT` | 拒绝新调用；异步 revoke；工具不卸载 |

---

## 5. Policy 子状态机

### 5.1 状态定义

| 状态 | 含义 | 读工具 | 写工具 |
|---|---|---|---|
| `NO_POLICY` | 从未成功拉取 | 拒绝 | 拒绝 |
| `FETCHING` | 正在拉取 | 用旧表（如果有） | 用旧表（如果新鲜），否则等待/拒绝 |
| `READY` | 有表且在 TTL 内 | 允许按 allowed 判定 | 要求 `now < writeFreshUntil` |
| `STALE` | 有表但已过 TTL/刷新失败 | grace 内允许 | 拒绝（除非刚刷新成功） |
| `INVALID` | 无可用表 | 拒绝 | 拒绝 |

### 5.2 状态图

```
   NO_POLICY ──AUTH_READY──▶ FETCHING
                               │
             ┌─────────────────┼──────────────────┐
             │ OK              │ 401              │ 网络错误/5xx
             ▼                 ▼                  ▼
          READY             INVALID          有旧表？──是──▶ STALE
             │                 ▲                 │            │
             │ TTL_EXPIRED     │                 └──否──▶ INVALID
             ▼                 │                              │
          STALE ──OK──▶ READY  │                              │
             │                 │                              │
             ├──GRACE_EXPIRED──┴──────────────────────────────┘
             │
             └──AUTH_EXPIRED──▶ INVALID
```

### 5.3 迁移表

| From | 事件 | Guard | 动作 | To |
|---|---|---|---|---|
| `NO_POLICY` | `AUTH_READY` | Auth 有效 | 启动 fetch | `FETCHING` |
| `NO_POLICY` | `AUTH_SIGNED_OUT` | — | 清空 | `NO_POLICY` |
| `FETCHING` | `FETCH_OK` | — | 存 allowed/denied/revisions；设置 TTL、write 新鲜度；清 grace/退避 | `READY` |
| `FETCHING` | `FETCH_401` | — | Auth → `EXPIRED`；清表 | `INVALID` |
| `FETCHING` | `FETCH_403` | — | 记录原因；清表 | `INVALID` |
| `FETCHING` | `FETCH_NETWORK` / `5XX` | 有旧表且读 grace 未过 | 保留旧表；首次失败设 grace；退避 | `STALE` |
| `FETCHING` | `FETCH_NETWORK` / `5XX` | 无旧表 | 记录错误；退避 | `INVALID` |
| `READY` | `TTL_EXPIRED` | 超过 `policyFreshUntil` | 标记 stale；首次进入设置 `graceDeadline`；读仍可用，写需刷新 | `STALE` |
| `READY` | `FORCE_REFRESH` | 写工具调用 / 用户刷新 | 启动 fetch | `FETCHING` |
| `READY` | `AUTH_EXPIRED` | — | 清表 | `INVALID` |
| `STALE` | `FETCH_OK` | — | 存表；清 grace；重置退避 | `READY` |
| `STALE` | `FETCH_NETWORK` | `now < graceDeadline` | 保留旧表；不延长 grace | `STALE` |
| `STALE` | `FETCH_401` | — | Auth → `EXPIRED`；清表 | `INVALID` |
| `STALE` | `FETCH_403` | — | 记录；清表 | `INVALID` |
| `STALE` | `GRACE_EXPIRED` | `now >= graceDeadline` | 清表 | `INVALID` |
| `STALE` | `AUTH_EXPIRED` | — | 清表 | `INVALID` |
| `INVALID` | `RETRY` | `now >= nextPolicyFetchAt` 且 Auth 有效 | 启动 fetch | `FETCHING` |
| `INVALID` | `AUTH_SIGNED_OUT` | — | 清空 | `NO_POLICY` |

### 5.4 TTL 与 gate

| 工具 | 允许调用条件 |
|---|---|
| `read` | `policy ∈ {READY, STALE}`；`toolId ∈ allowed`；若 `STALE`，`now < graceDeadline` |
| `write` | `policy = READY`；`now < writeFreshUntil`；`toolId ∈ allowed`；否则先 `FORCE_REFRESH`，失败即拒绝 |

默认值：

- `policyTtlSeconds = 60`（读表 TTL）
- `writePolicyTtlSeconds = 15`（写表新鲜度）
- `readGraceSeconds = 86400`
- `writeGraceSeconds = 0`

### 5.5 退避与持久化

- Policy 不落盘；重启后 `NO_POLICY`，必须重新拉取。
- `INVALID` 后退避：5s → 15s → 60s → 300s；成功后重置。
- `STALE` 期间每 60s 尝试刷新，但不延长 `graceDeadline`。
- 工具调用触发的同步刷新最多等 2s；超时按当前表判定，写工具直接拒绝。

---

## 6. Transport 子状态机（辅助）

权限变化不启动/停止传输层；只有「真正需要执行」时才懒启动。

### 6.1 状态图

```
   STOPPED ──ENSURE──▶ STARTING ──OK──▶ READY
      ▲                   │               │
      │                   │ ERROR         │ CRASH
      │                   ▼               ▼
      │                DEGRADED ◀────────┘
      │                   │
      │                   │ RETRY
      │                   ▼
      │                STARTING ──ERROR(3 次)──▶ FAILED
      │                                            │
      └──────────── RESET（手动刷新/重启） ◀────────┘
```

### 6.2 迁移表

| From | 事件 | Guard | 动作 | To |
|---|---|---|---|---|
| `STOPPED` | `ENSURE` | Auth + Policy 已通过 | 启动 MCP 子进程 | `STARTING` |
| `STARTING` | `START_OK` | — | 记录工具映射；`retry=0` | `READY` |
| `STARTING` | `START_ERROR` | `retry < 3` | 退避（1s/5s/30s）；`retry++` | `DEGRADED` |
| `STARTING` | `START_ERROR` | `retry >= 3` | 记录错误 | `FAILED` |
| `READY` | `CALL_OK` | — | — | `READY` |
| `READY` | `CRASH` | — | 标记不可用；`retry=0` | `DEGRADED` |
| `DEGRADED` | `ENSURE` / `RETRY` | `now >= nextRetryAt` | 重新启动 | `STARTING` |
| `FAILED` | `RESET` | 用户手动刷新/插件重启 | 清 retry | `STOPPED` |
| 任意 | `DISPOSE` | — | 关闭子进程 | `STOPPED` |

关键：

- 传输层 `DEGRADED` / `FAILED` 不影响工具注册表；工具仍在，调用返回 `mmw_tool_unavailable`。
- 未登录/无权限时**不允许** `ENSURE`，因此不会为无权用户启动 MCP。
- 传输层可以在空闲时停止（可选），下次调用再懒启动；MVP 可以先常驻。

---

## 7. Tool Call 子状态机

### 7.1 状态图

```
   RECEIVED ──CALL──▶ CHECK_AUTH
                         │
          ┌──────────────┼──────────────┐
          │ VALID        │ INVALID      │
          ▼              ▼              │
      CHECK_POLICY      DENIED ◀────────┘
          │
     ┌────┼──────────────┬──────────────┐
     │ALLOWED              │NEED_REFRESH   │DENIED
     ▼                     ▼              ▼
  CHECK_TRANSPORT      FETCHING ──▶ CHECK_POLICY（最多 1 次）  DENIED
     │
     ├──READY──▶ EXECUTING ──OK──▶ SUCCEEDED
     │                │
     │                └──ERROR/CANCELLED──▶ FAILED
     └──UNAVAILABLE──▶ DENIED
```

### 7.2 迁移表

| From | 事件 | Guard | 动作 | To |
|---|---|---|---|---|
| `RECEIVED` | `CALL` | — | 记录 toolId；不启动 MCP | `CHECK_AUTH` |
| `CHECK_AUTH` | `VALID` | Auth ∈ {`AUTHENTICATED`, `REFRESHING`} | — | `CHECK_POLICY` |
| `CHECK_AUTH` | `INVALID` | — | 返回 `mmw_auth_required` / `mmw_session_expired` | `DENIED` |
| `CHECK_POLICY` | `ALLOWED` | `toolId ∈ allowed`；读工具在 `READY/STALE(grace)`；写工具在 `READY` 且新鲜 | 记录 `policyRevision` | `CHECK_TRANSPORT` |
| `CHECK_POLICY` | `NEED_REFRESH` | 写工具表不新鲜；或读表过 TTL 且可刷新 | 同步刷新（≤2s）；成功后重试 | `CHECK_POLICY`（最多 1 次） |
| `CHECK_POLICY` | `DENIED` | tool 不在 allowed / 无表 / grace 过期 | 返回 `mmw_route_denied` / `mmw_policy_unavailable` | `DENIED` |
| `CHECK_TRANSPORT` | `READY` | — | — | `EXECUTING` |
| `CHECK_TRANSPORT` | `STARTING` | — | 等待启动（有超时） | `CHECK_TRANSPORT` |
| `CHECK_TRANSPORT` | `UNAVAILABLE` | 启动失败/重试耗尽 | 返回 `mmw_tool_unavailable` | `DENIED` |
| `EXECUTING` | `OK` | — | 返回结果 | `SUCCEEDED` |
| `EXECUTING` | `ERROR` | — | 返回错误 | `FAILED` |
| `EXECUTING` | `CANCELLED` | 调用方取消 | 转发 abort signal | `FAILED` |
| `EXECUTING` | `AUTH_REVOKED` | 执行中收到撤销 | 不杀在途；记录；新调用拒绝 | `SUCCEEDED` / `FAILED` |

### 7.3 关键规则

- **检查顺序固定**：Auth → Policy → Transport。未登录/无权限不能启动 MCP。
- **最多刷新一次**：`NEED_REFRESH` 只允许一次；刷新后仍不允许就拒绝。
- **写工具 fail closed**：授权表不新鲜且刷新失败，直接拒绝；不允许用旧表写。
- **读工具 grace**：核心不可达时，读工具在 grace 内可用旧表；超过 grace 拒绝。
- **不杀在途**：撤销发生在调用中，让调用完成并记审计；新调用拒绝。
- **工具始终可见**：拒绝不会删除工具；`mmw_status` 解释原因。

---

## 8. 典型场景

### 场景 1：启动但未登录

```
插件启动：注册全部工具
agent 调用 repo_read：
  RECEIVED → CHECK_AUTH → INVALID → DENIED（mmw_auth_required）
传输层：STOPPED（未启动）
工具列表：仍是全部工具
```

### 场景 2：登录，只有 read 权限

```
SIGNED_OUT --LOGIN_START--> LOGIN_PENDING --POLL_AUTHORIZED--> AUTHENTICATED
Policy: NO_POLICY --AUTH_READY--> FETCHING --FETCH_OK--> READY
allowed = {repo_read, repo_status, ...}
调用 repo_read：CHECK_AUTH VALID → CHECK_POLICY ALLOWED → 懒启动 MCP → EXECUTING → SUCCEEDED
调用 repo_edit：CHECK_POLICY DENIED → mmw_route_denied（MCP 可能已启动，但调用没发生）
```

### 场景 3：管理员授予 edit

```
Policy: READY(policyRevision=42) --TTL_EXPIRED/FORCE_REFRESH--> FETCHING
        --FETCH_OK(policyRevision=43)--> READY
allowed 新增 repo_edit
调用 repo_edit：CHECK_POLICY ALLOWED → 执行
工具列表：没有变化（repo_edit 一直都在）
```

### 场景 4：管理员撤销 edit

```
Policy: READY --FORCE_REFRESH--> FETCHING --FETCH_OK--> READY
allowed 移除 repo_edit
调用 repo_edit：CHECK_POLICY DENIED → mmw_route_denied
工具列表：repo_edit 仍在
```

### 场景 5：token 过期

```
AUTHENTICATED --TOKEN_EXPIRED--> EXPIRED
Policy: READY --AUTH_EXPIRED--> INVALID
所有调用：CHECK_AUTH INVALID → DENIED（mmw_session_expired）
工具列表：不变
```

### 场景 6：核心不可达

```
Policy: READY --TTL_EXPIRED--> STALE（设置 graceDeadline）
读工具：CHECK_POLICY ALLOWED（grace 内）→ 执行
写工具：CHECK_POLICY NEED_REFRESH → 刷新失败 → DENIED（mmw_policy_unavailable）
超过 grace：
读工具：DENIED；Policy INVALID
```

### 场景 7：传输层崩溃

```
Transport: READY --CRASH--> DEGRADED
调用：CHECK_TRANSPORT UNAVAILABLE → DENIED（mmw_tool_unavailable）
下一次调用：DEGRADED --ENSURE--> STARTING → READY → 执行
工具列表：不变
```

### 场景 8：新增工具

```
插件新版本：启动时注册新 tool
核心旧版本：allowed 不含新 tool
调用：CHECK_POLICY DENIED（核心还没允许）
核心升级并授权后：allowed 包含 → 调用成功
```

---

## 9. 并发与顺序

| 操作 | 规则 |
|---|---|
| `policyFetch` | 单飞；低 revision 响应丢弃；失败退避 |
| `tokenRefresh` | 单飞；401 才清 token；网络错误保留旧 token |
| `loginPoll` | 单飞；terminal 停止定时器 |
| `transportStart` | 每个 feature 单飞；并发调用共享同一个 start promise |
| 调用 vs 刷新 | 调用捕获当前 allowed 快照；刷新完成后下一次调用生效；写工具同步刷新最多一次 |
| 调用 vs token 过期 | 过期后所有新调用拒绝；在途调用不杀 |
| 退出 vs 刷新 | 退出优先；refresh/policy 结果丢弃 |

建议用 actor 队列串行处理状态迁移；网络、spawn、文件等副作用作为命令执行，完成后再投递结果事件。

---

## 10. `mmw_status` 映射

```json
{
  "auth": {
    "state": "AUTHENTICATED",
    "member": { "id": "...", "name": "张三" },
    "tokenExpiresAt": 1790000000000,
    "lastError": null
  },
  "policy": {
    "state": "READY",
    "policyRevision": 42,
    "catalogRevision": "sha256:9f2c...",
    "fetchedAt": 1790000000000,
    "freshUntil": 1790000060000,
    "stale": false,
    "allowedCount": 3,
    "deniedCount": 1
  },
  "transports": [
    { "featureId": "race-ops", "state": "READY" }
  ],
  "tools": [
    { "id": "race-ops.repo_read", "state": "REGISTERED", "allowed": true, "reason": null },
    { "id": "race-ops.repo_edit", "state": "REGISTERED", "allowed": false, "reason": "race-ops.edit" }
  ]
}
```

- 所有工具始终是 `REGISTERED`；`allowed` 是派生字段。
- 不包含 token、文件内容、工具参数。

---

## 11. 测试用例

### 11.1 静态注册

- [ ] 插件启动后，全部实现都已注册，未登录也一样。
- [ ] 登录/登出/撤销权限后，工具注册表不变。
- [ ] 新增工具需要新版本插件；旧插件没有该 tool。

### 11.2 Auth

- [ ] 登录成功 → `AUTHENTICATED`。
- [ ] 登录拒绝/超时 → `AUTH_FAILED`。
- [ ] 刷新成功/401/网络错误。
- [ ] token 过期 → `EXPIRED`；工具仍可见。
- [ ] 退出 → `SIGNED_OUT`；工具仍可见。

### 11.3 Policy

- [ ] 首次 fetch 成功 → `READY`；allowed 正确。
- [ ] fetch 401 → `INVALID`；调用拒绝。
- [ ] 有旧表 + 网络错误 → `STALE`；读 grace。
- [ ] 无旧表 + 网络错误 → `INVALID`；所有调用拒绝。
- [ ] grace 过期 → `INVALID`。
- [ ] TTL 过期 → `STALE`；写工具触发刷新。
- [ ] `policyRevision` 变化 → allowed 更新。
- [ ] 目录版本不一致 → 记录 degraded；allowed 仍按核心。

### 11.4 Tool Call

- [ ] 未登录 → `mmw_auth_required`；MCP 未启动。
- [ ] 无权限 → `mmw_route_denied`；MCP 未启动。
- [ ] 有权限 → 懒启动 MCP → 执行成功。
- [ ] 撤销后 → 拒绝；工具仍在。
- [ ] token 过期 → 拒绝；工具仍在。
- [ ] 核心不可达：读 grace 内成功；写拒绝。
- [ ] 传输层崩溃：调用失败；下次懒重启。
- [ ] 刷新一次后仍不允许 → 拒绝（不死循环）。

---

## 12. 需要你确认的状态机决策

1. **工具可见性**：所有工具始终可见，无权调用被拒；是否接受？如果希望「看不见」，会重新引入动态列表。
2. **授权表 TTL**：读 60s、写 15s；是否合适？
3. **核心不可达时的写操作**：默认 fail closed；读 24h grace；是否接受？
4. **per-call 授权接口**：MVP 用缓存；是否接受撤销最多延迟 15s（写）/60s（读）？
5. **传输层懒启动**：第一次有权限调用才启动 MCP；是否接受？
6. **在途调用遇到撤销**：不杀，让调用完成；是否接受？

---

## 附录：状态名对照

| 层 | 状态 |
|---|---|
| Auth | `SIGNED_OUT`、`LOGIN_PENDING`、`AUTHENTICATED`、`REFRESHING`、`EXPIRED`、`AUTH_FAILED`、`SIGNING_OUT` |
| Policy | `NO_POLICY`、`FETCHING`、`READY`、`STALE`、`INVALID` |
| Transport | `STOPPED`、`STARTING`、`READY`、`DEGRADED`、`FAILED` |
| Tool Call | `RECEIVED`、`CHECK_AUTH`、`CHECK_POLICY`、`CHECK_TRANSPORT`、`EXECUTING`、`SUCCEEDED`、`FAILED`、`DENIED` |
| Tool 派生 | `REGISTERED` + `allowed: true/false` |
