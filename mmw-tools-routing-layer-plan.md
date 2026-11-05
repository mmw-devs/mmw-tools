# mmw-tools 功能路由规划（v4：tool-centric）

> 状态：方案 v4，tool-centric 契约与插件 gate 已落地；本文早期章节保留为设计历史
> 日期：2026-10-26（2026-11-04 tool-centric 更新）
> 定位：**飞书网页应用鉴权是核心业务逻辑；DSH 插件是载体；功能路由是目标。**
> 关键模型：**角色只决定能否消费工具；`requiredPermissions` 是工具自身需要的能力，不是用户授权；没有 role → permission 映射。**
> 路由消费者：DSH agent
> 路由表所有者：飞书鉴权核心
> 进展：契约 v2（[`contracts/tools.json`](contracts/tools.json)、[`contracts/roles.json`](contracts/roles.json)）与 auth core 已部署；公网 `/health` 返回 `contractVersion: 2`。插件已实现 Feishu gate / Settings 授权面板 / token 续期 / `pr_merge` 确认顺序。桌面宿主重启后已验证：`mmw_tools_status` 在绑定工作区外可用；`repo_status` 在区外被 workspace guard 拒绝、在绑定工作区内正常；`mmw_tools_run` 能读取 AGENTS.md/README.md。GitHub broker 会话当前为 `reauth_needed`，写操作仍需用户在面板重新登录。
>
> ⚠️ 本文第 3/4 节中 `race-ops.read` / `race-ops.edit` / `race-ops.pr` 的描述属于早期权限模型；当前以 [`contracts/README.md`](contracts/README.md) 和 `tools.json` 为准。

---

## 1. 一句话结论

> **飞书鉴权核心负责「你是谁、你能用哪些工具」；DSH 插件在启动时把所有工具静态注册好，在每次调用时按核心下发的授权表决定放行还是拒绝。**

```
飞书身份（Principal）
   → 角色 / 权限（Policy）
   → 功能注册表（Feature Catalog）
   → 授权表（Policy Table：toolId → allowed / denied）
   → 静态注册的 DSH 工具
   → 调用时检查 → 放行 / 拒绝
```

三个关键性质：

1. **工具集合是静态的**：插件启动时注册全部本地实现，不因登录、登出、权限变化而增删。
2. **授权发生在调用时**：每次工具调用先过 Auth 和 Policy，缺权限就返回 `mmw_route_denied`。
3. **核心仍然是唯一授权来源**：插件不能自己决定谁能用什么；它只执行核心下发的授权表。

```
┌──────────────────────────────┐
│ 飞书用户                       │
│  浏览器 OAuth（PKCE）          │
└──────────────┬───────────────┘
               │ 登录
               ▼
┌──────────────────────────────────────────────┐
│ mmw-tools-auth（核心业务）                     │
│  · 飞书身份 / 租户校验 / 会话                  │
│  · 成员 / 角色 / 权限                          │
│  · 功能注册表（Feature Catalog）               │
│  · 策略判定 → 授权表（Policy Table）            │
│  · 审计                                       │
└──────────────┬───────────────────────────────┘
               │ GET /v1/agent/routes（Bearer）
               ▼
┌──────────────────────────────────────────────┐
│ mmw-tools DSH 插件（载体）                     │
│  · 启动时静态注册全部工具                      │
│  · 登录交接 / pluginToken                      │
│  · 授权表缓存 + TTL                            │
│  · 调用时：Auth → Policy → Transport → 执行    │
│  · mmw_status 解释放行/拒绝原因                │
└──────────────┬───────────────────────────────┘
               │ tools/call
               ▼
┌──────────────────────────────────────────────┐
│ DSH agent                                     │
└──────────────────────────────────────────────┘
```

---

## 2. 为什么 v3 比 v2 更合适

| v2 的做法 | 问题 | v3 的修正 |
|---|---|---|
| 按权限动态挂载/卸载工具 | 依赖 DSH 会话内工具热插拔；要处理 reconcile、竞态、卸载窗口 | 启动时静态注册全部工具，**不依赖热插拔** |
| 路由表决定「工具是否存在」 | 权限变化要改 DSH 工具注册表，复杂且易错 | 路由表只决定「调用是否放行」 |
| Feature 挂载状态机 | `UNMOUNTED/PLANNED/STARTING/MOUNTED/DEGRADED/STOPPING` 大部分是权限引起的 | 只保留传输层健康状态，权限状态简化为授权表 |
| 撤销权限要卸载工具 | 卸载与在途调用竞争，窗口期难处理 | 撤销后工具仍在，但调用直接拒绝；无竞态 |
| 先做 DSH 热插拔 spike | 验证一个本可以绕开的能力 | **取消这个 spike**，直接做调用时授权 |

代价是：**agent 能看到一些自己无权使用的工具。** 这是有意的取舍：

- 工具名和描述不是敏感信息；
- 调用一定会在插件侧被拦住；
- agent 可以通过 `mmw_status` 知道「为什么不能用」；
- 面板可以显示 `allowed / denied` 徽标，而不是把工具藏起来。

如果未来确实需要「看不见」而不是「用不了」，再在 UI 层过滤，不需要改路由层。

---

## 3. 核心模型

### 3.1 概念

| 概念 | 定义 | 归属 |
|---|---|---|
| **Principal** | 飞书 OAuth 身份：`tenant_key + open_id` | 鉴权核心 |
| **Permission** | 可授予的权限字符串，如 `race-ops.read` | 鉴权核心 |
| **Feature** | 业务功能，如 `race-ops` | 鉴权核心的 Feature Catalog |
| **Action** | 功能下的动作，如 `read` / `edit` / `pr` | 鉴权核心的 Feature Catalog |
| **Tool** | agent 可调用的最小单位，如 `race-ops.repo_read` | 核心定义，插件实现 |
| **Policy Table** | 某个 Principal 当前允许调用的 tool 集合 | 鉴权核心生成 |
| **Implementation** | 插件本地 `toolId → MCP 工具/原生函数` 的映射 | 插件 |

约束：

- Feature / Action / Tool 的**定义权**在核心；插件只有**实现权**。
- 工具注册是静态的；插件不会因为权限变化而新增或删除工具。
- Policy Table 是**按请求生成的**，不是静态配置；成员角色变化后，下一次拉取就会得到不同的允许集合。
- 插件没有「自己判断角色」的逻辑；它只检查 `toolId` 是否在当前允许集合里。

### 3.2 权限模型

| Permission | 允许的 Action | 对应 Tool | 风险级别 |
|---|---|---|---|
| `race-ops.read` | `race-ops.read` | `repo_status`、`repo_read`、`repo_search`、`repo_clone`、`repo_pull`、`pr_list`、`engineer_run`、`engineer_status` | read |
| `race-ops.edit` | `race-ops.edit` | `repo_edit` | write |
| `race-ops.pr` | `race-ops.pr` | `pr_create` | write |
| `mmw.admin` | 管理 UI | 不是 agent tool | — |

角色：

| 角色 | 权限 |
|---|---|
| `viewer` | `race-ops.read` |
| `editor` | `race-ops.read`、`race-ops.edit` |
| `operator` | `race-ops.read`、`race-ops.edit`、`race-ops.pr` |
| `admin` | 以上全部 + `mmw.admin` |

`risk` 的作用不是「权限大小」，而是**授权表不可用时的降级策略**：

- `read`：核心不可达时，可在 grace 内继续使用旧授权表。
- `write`：核心不可达时，**默认拒绝**（fail closed），避免在无法确认权限时执行写操作。

关于 `repo_clone` / `repo_pull`：它们写本地工作区，但不写远端；如果 read 不含它们，用户无法拉仓库，read 工具也没有意义。因此 v1 放在 `race-ops.read`；远端写仍由 `edit` / `pr` 控制。

---

## 4. 功能注册表（Feature Catalog）

### 4.1 存放位置

```
mmw-tools/
├── contracts/
│   ├── features.json          # 功能/动作/工具/权限/风险级别
│   └── features.schema.json   # JSON Schema
├── mmw-tools-auth/            # 核心：读取 features.json
└── dsh-github-engineer/       # 插件：构建时打包同一份，静态注册
```

`features.json` 是核心与插件之间的**功能清单 / 接口清单**：

- 核心读它：决定某个用户的路由表里允许哪些 tool。
- 插件读它：知道要静态注册哪些 tool、`publicName` 是什么、需要什么权限。
- 它不是运行时权限数据；成员实际权限在 roles / permissions 里。
- 两边共用一份，CI 做漂移检查。

### 4.2 目录条目

```json
{
  "contractVersion": 1,
  "features": [
    {
      "id": "race-ops",
      "title": "FFXIV Race Ops 仓库",
      "requiresAny": ["race-ops.read", "race-ops.edit", "race-ops.pr"],
      "actions": [
        {
          "id": "read",
          "title": "读取与同步",
          "permission": "race-ops.read",
          "tools": [
            {
              "id": "race-ops.repo_read",
              "publicName": "mcp__mmw-tools__race_ops__repo_read",
              "description": "读取仓库中的一个文件",
              "risk": "read"
            },
            {
              "id": "race-ops.repo_edit",
              "publicName": "mcp__mmw-tools__race_ops__repo_edit",
              "description": "按 allowlist 修改文件、跑 preflight、本地 commit",
              "risk": "write"
            }
          ]
        }
      ]
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `features[].requiresAny` | 至少命中一个权限，feature 才可能出现在授权表 |
| `actions[].permission` | 该 action 下 tool 的默认权限；tool 可覆盖 |
| `tools[].id` | 全局唯一、稳定的逻辑 ID；插件实现映射的键 |
| `tools[].publicName` | agent 看到的工具名；**由核心定义**，插件必须一致 |
| `tools[].risk` | `read` / `write`；决定授权表不可用时的降级策略 |
| `tools[].permission` | 可选；覆盖 action 默认权限 |

### 4.3 新增一个工具

1. `contracts/features.json` 加 tool + permission + risk。
2. `mmw-tools-auth/src/permissions.ts` 把权限加入 `KNOWN_PERMISSIONS` 和角色包。
3. 插件 `IMPLEMENTATIONS` 加 `toolId → 本地实现`，静态注册时自动出现。
4. 契约测试：目录与插件实现一致。
5. 发布顺序：先核心（旧插件没有该工具，核心不会允许一个不存在的 tool）；再插件。

插件启动时注册全部实现；核心的授权表只决定「这个 tool 是否 allowed」。**新增工具不需要动态注册机制，只需要新版本插件。**

---

## 5. 授权表 API

### 5.1 `GET /v1/agent/routes`

名字保留 `routes`，但语义是**授权表**，不是挂载计划。

请求头：

```
Authorization: Bearer <pluginToken>
X-MMW-Plugin-Version: 0.9.0
```

响应：

```json
{
  "contractVersion": 1,
  "catalogRevision": "sha256:9f2c...",
  "policyRevision": 42,
  "ttlSeconds": 60,
  "allowed": [
    "race-ops.repo_read",
    "race-ops.repo_status"
  ],
  "denied": [
    {
      "toolId": "race-ops.repo_edit",
      "missingPermission": "race-ops.edit"
    },
    {
      "toolId": "race-ops.pr_create",
      "missingPermission": "race-ops.pr"
    }
  ]
}
```

语义：

- `allowed` 是插件调用时唯一认可的白名单；不在其中的 tool 一律拒绝。
- `denied` 只用于面板/`mmw_status` 解释原因，不参与放行判断。
- `policyRevision` 在成员/角色/权限变化时 +1；`catalogRevision` 只在目录变化时变。
- `ttlSeconds` 是插件缓存授权表的时长。MVP 建议 60 秒。
- 核心按 `X-MMW-Plugin-Version` 过滤插件不支持的 tool（可选；MVP 可先不做）。

### 5.2 调用时如何用授权表

插件不缓存「工具是否存在」，只缓存 `allowed` 集合：

```ts
async function authorize(toolId: string, risk: "read" | "write"): Promise<void> {
  const policy = await policyCache.ensureFresh(risk); // 见 7.4
  if (!policy.allowed.has(toolId)) {
    throw new Error(`mmw_route_denied: 缺少 ${toolId} 所需权限`);
  }
}
```

- **只读工具**：授权表 60 秒内有效；过期后刷新；刷新失败可在 grace 内继续用旧表。
- **写工具**：授权表必须足够新（建议 ≤ 15 秒），否则同步刷新；刷新失败直接拒绝。
- 不在 `allowed` 里的 tool 永远拒绝，不管本地实现是否存在。

### 5.3 为什么不做 per-call 授权接口

`POST /v1/agent/authorize` 能让撤销立即生效，但代价是：

- 每次工具调用都依赖核心可用；
- 核心多一次网络往返；
- 需要额外处理超时、重试、幂等。

小团队用「60 秒缓存 + 写工具 15 秒新鲜度」已经足够；真要更强，再加 per-call 接口，不影响现有契约。

### 5.4 其他核心端点

| Method | Path | 认证 | 用途 |
|---|---|---|---|
| `GET` | `/health` | 无 | 健康检查 |
| `POST` | `/v1/login/start` | 无，限流 | 创建登录事务 |
| `GET` | `/auth/feishu/start?login=` | 浏览器 cookie | 302 到飞书 |
| `GET` | `/auth/feishu/callback` | 浏览器 cookie | 完成 OAuth，登记成员 |
| `GET` | `/v1/login/:id?secret=` | pollSecret | 插件轮询，拿 pluginToken |
| `GET` | `/v1/me` | Bearer | 身份、角色、权限、revision |
| `POST` | `/v1/session/refresh` | Bearer | 轮换 pluginToken |
| `POST` | `/v1/session/logout` | Bearer | 撤销 token |
| `GET` | `/v1/agent/routes` | Bearer | **授权表（核心产出）** |
| `POST` | `/v1/agent/events` | Bearer | 执行侧审计事件 |
| `GET` | `/` | 浏览器 session | 管理 UI |
| `GET/PATCH` | `/api/admin/members/...` | `mmw.admin` + CSRF | 成员/角色 |
| `GET` | `/api/admin/audit` | `mmw.admin` | 审计 |

H5 页面只用于登录和管理，不承载功能页面。

---

## 6. 飞书鉴权核心

### 6.1 登录时序

```
用户        DSH 面板       插件 host        mmw-tools-auth       飞书
 │ 点登录      │               │                  │               │
 │────────────▶│ POST /login/start                │               │
 │             │──────────────▶│ POST /v1/login/start             │
 │             │               │─────────────────▶│               │
 │             │               │◀─ loginUrl, pollSecret           │
 │             │◀─ loginUrl ───│                  │               │
 │ 浏览器打开 loginUrl           │                  │               │
 │───────────────────────────────────────────────▶│               │
 │             │               │                  │── 302 ───────▶│
 │             │               │                  │◀─ code ───────│
 │             │               │                  │ exchange      │
 │             │               │                  │ tenant check  │
 │             │               │                  │ upsert member │
 │             │               │◀── 轮询 ─────────│               │
 │             │               │  /v1/login/:id?secret=...          │
 │             │               │─────────────────▶│               │
 │             │               │◀─ pluginToken ───│               │
 │             │               │  GET /v1/agent/routes             │
 │             │               │─────────────────▶│               │
 │             │               │◀─ allowed/denied ─│               │
 │◀─ 工具已注册 ─│◀──────────────│  （启动时已全部注册）              │
```

注意：**工具在登录前就已经注册好了**。登录只影响授权表，不影响工具列表。

### 6.2 插件 token

| 项 | 设计 |
|---|---|
| 形式 | 32 字节随机，base64url；不透明 token |
| 服务端存储 | `sha256(token)` |
| 有效期 | 默认 7 天；`MMW_PLUGIN_TOKEN_TTL_SECONDS` 可调 |
| 续期 | 剩余 < 24h 时轮换；旧 token 立即失效 |
| 撤销 | 登出、成员停用、角色变更后删除 token |
| 本地存储 | `~/.dsh/mmw-tools.json`，`0600` |
| 日志 | 只记 hash 前 8 位 |

不用 JWT：撤销必须立即生效；不透明 token + 服务端查表更适合「权限变化影响授权表」。

### 6.3 数据模型

```sql
CREATE TABLE members (
  id           TEXT PRIMARY KEY,   -- sha256(tenant_key + ':' + open_id)
  tenant       TEXT NOT NULL,
  open_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  roles        TEXT NOT NULL,
  permissions  TEXT NOT NULL,
  enabled      INTEGER NOT NULL,
  version      INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE sessions (
  id_hash      TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL,
  csrf         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE plugin_tokens (
  token_hash   TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE TABLE login_tx (
  id_hash          TEXT PRIMARY KEY,
  poll_secret_hash TEXT NOT NULL,
  browser_hash     TEXT NOT NULL,
  verifier         TEXT NOT NULL,
  oauth_state      TEXT NOT NULL,
  status           TEXT NOT NULL,
  member_id        TEXT,
  token_hash       TEXT,
  expires_at       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE audit (
  id       TEXT PRIMARY KEY,
  actor    TEXT NOT NULL,
  action   TEXT NOT NULL,
  target   TEXT NOT NULL,
  details  TEXT NOT NULL,
  at       TEXT NOT NULL
);

CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`config` 保存 `policyRevision`、`catalogRevision`、`bootstrapped`。成员/角色/权限变更与 `policyRevision + 1` 同一事务提交。

### 6.4 管理 UI

四件事：

1. 成员列表：姓名、角色、直授权限、启用状态、最近登录。
2. 角色分配：`viewer` / `editor` / `operator` / `admin`。
3. 直授权限：临时例外，显示来源。
4. 审计：登录、登出、成员变更、token 撤销、授权表生成异常。

约束：

- 不能停用或降级最后一位有效管理员。
- 停用成员时删除其全部 `plugin_tokens` 与 `sessions`，`policyRevision + 1`。
- 管理员不能查看他人的工具调用内容；核心拿不到参数。
- 管理 UI 写请求校验 `Origin` + `X-CSRF-Token`。

#### 6.4.1 首位管理员：不知道 open_id 怎么办

`MMW_ADMIN_OPEN_ID` 需要飞书应用内的 `open_id`（`ou_...`）。两种方式：

1. **本地首登读取**：本地启动服务，用自己的账号登录一次，查 `sqlite3 data/auth.sqlite "select open_id, name from members;"`，写入 `.env`，重启，再加 admin 角色。仅适合服务未公开时。
2. **一次性 bootstrap token（推荐）**：
   - 部署时设 `MMW_BOOTSTRAP_TOKEN=<随机值>`（只放服务端 `.env`）。
   - 你本人访问 `/auth/feishu/start?bootstrap=<token>`。
   - 回调成功后该账号成为首位管理员，bootstrap token 立即失效，`open_id` 写入审计/管理 UI。
   - 之后从 `.env` 删除并重启。

### 6.5 飞书应用与部署

| 配置 | 值 |
|---|---|
| 应用类型 | 企业自建应用 / 网页应用 |
| 回调 | `https://mmw-tools.mmw-team.icu/auth/feishu/callback` |
| 可信域名 | `https://mmw-tools.mmw-team.icu` |
| scope | 只开身份所需；不开文档/知识库/云盘 |
| 租户 | `FEISHU_TENANT_KEY` 强校验 |

- 单进程 Node 24，`node:http` + `node:crypto` + `node:sqlite`，零第三方运行依赖。
- 只监听 `127.0.0.1:4326`；nginx 终止 TLS。
- ICP 备案仍是上线门槛；备案前用 SSH 隧道联调。

---

## 7. 插件载体

### 7.1 启动时静态注册全部工具

```
插件 apply()
  ├─ 读 contracts/features.json（本地副本）
  ├─ 枚举 IMPLEMENTATIONS（全部本地实现）
  ├─ 对每个 tool: ctx.tools.register(proxyTool)
  ├─ 注册 mmw_status
  └─ 启动 login hydrate + policy 定时刷新
```

每个代理工具：

```ts
{
  name: publicName,                 // 来自 features.json
  description: description + `（需要权限：${permission}）`,
  execute: async (args, exec) => {
    await auth.ensureValid();       // 未登录/过期 → mmw_auth_required
    await policy.authorize(toolId, risk);
    const transport = await transports.ensure(featureId);
    return transport.call(mcpTool, args, exec.signal);
  }
}
```

关键点：

- **注册不依赖登录态**；未登录时工具也存在，只是调用会拒绝。
- **注册不依赖授权表**；授权表只用于调用时检查。
- **工具列表稳定**；权限变化不会触发 DSH 工具注册表变化。
- **MCP 子进程懒启动**：第一次真正调用某个 feature 的 tool 时才启动；启动失败返回 `mmw_tool_unavailable`，tool 仍然注册。

### 7.2 实现映射

```ts
// dsh-github-engineer/src/features/race-ops.ts
export const IMPLEMENTATIONS: Record<string, ToolImplementation> = {
  "race-ops.repo_read": {
    featureId: "race-ops",
    mcpTool: "repo_read",
    publicName: "mcp__mmw-tools__race_ops__repo_read",
    permission: "race-ops.read",
    risk: "read",
  },
  "race-ops.repo_edit": {
    featureId: "race-ops",
    mcpTool: "repo_edit",
    publicName: "mcp__mmw-tools__race_ops__repo_edit",
    permission: "race-ops.edit",
    risk: "write",
  },
  "race-ops.pr_create": {
    featureId: "race-ops",
    mcpTool: "pr_create",
    publicName: "mcp__mmw-tools__race_ops__pr_create",
    permission: "race-ops.pr",
    risk: "write",
  },
  // ...
};
```

启动时校验 `publicName` / `permission` / `risk` 与 `features.json` 一致；不一致拒绝注册该 tool，并报 `contract_mismatch`。

### 7.3 调用流水线

```
tools/call(toolId)
  │
  ├─ 1. Auth 检查
  │      auth ∈ {AUTHENTICATED, REFRESHING}?
  │      否 → mmw_auth_required / mmw_session_expired
  │
  ├─ 2. Policy 检查
  │      policy.ensureFresh(risk)?
  │      allowed 包含 toolId?
  │      否 → mmw_route_denied / mmw_policy_unavailable
  │
  ├─ 3. Transport 检查
  │      transports.ensure(featureId)?
  │      否 → mmw_tool_unavailable
  │
  └─ 4. 执行 MCP / 原生工具
```

顺序不能反：**先 Auth，再 Policy，最后 Transport**。未登录/无权限时不应该启动 MCP 子进程。

### 7.4 授权表缓存

| 工具风险 | 缓存新鲜度 | 刷新失败 |
|---|---|---|
| `read` | 60 秒 | grace 内用旧表；超过 grace 拒绝 |
| `write` | 15 秒 | 直接拒绝（fail closed） |

- 定时器每 60 秒刷新一次；写工具调用前如果表超过 15 秒，同步刷新。
- 401：清 token，所有调用拒绝；工具不卸载。
- 403：记录；按 `mmw_route_denied` 处理。
- 网络错误/5xx：保留旧表，标记 `stale`；写工具拒绝，读工具在 grace 内可用。
- grace 默认：read 24 小时，write 0；可按 feature 覆盖。

### 7.5 面板

```
飞书身份
  账号：张三（mmw-devs）
  状态：有效 / 剩余 6 天
  角色：editor
  授权表：42（60 秒前刷新）
  [使用飞书登录] [刷新授权] [退出]

工具（静态注册，共 10 个）
  repo_read     ✅ 允许（race-ops.read）
  repo_edit     ✅ 允许（race-ops.edit）
  pr_create     ⛔ 拒绝（缺少 race-ops.pr）
  ...

仓库授权（race-ops）
  GitHub：race-ops-bot[bot]
  状态：就绪 / 未完成 / 已过期
  [连接 GitHub] [刷新] [撤销]
```

面板只调用 loopback 路由；登录按钮用 `window.open(loginUrl)`。

### 7.6 loopback 路由

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/api/mmw-tools/status` | 身份、授权表版本、工具允许/拒绝状态 |
| `POST` | `/api/mmw-tools/login/start` | 请求核心创建登录事务 |
| `POST` | `/api/mmw-tools/login/poll` | 轮询一次；成功后存 token、拉授权表 |
| `POST` | `/api/mmw-tools/logout` | 撤销 token；工具保留但调用全部拒绝 |
| `POST` | `/api/mmw-tools/refresh` | 强制刷新授权表 |
| `GET` | `/api/mmw-tools/tools` | 静态工具列表 + allowed/denied |

### 7.7 配置

```yaml
authServiceUrl: https://mmw-tools.mmw-team.icu
router:
  mode: feishu          # feishu | legacy
  policyTtlSeconds: 60
  writePolicyTtlSeconds: 15
  readGraceSeconds: 86400
  writeGraceSeconds: 0
```

- `mode: legacy`：不做 Auth/Policy 检查，全部放行；只用于迁移/离线测试，启动打 WARN。
- `mode: feishu` 但缺 `authServiceUrl`：启动失败。
- 发布版默认 `feishu`。

### 7.8 两套授权的关系

| | 飞书功能授权 | GitHub 仓库授权 |
|---|---|---|
| 证明 | 你是谁、能用哪些 agent tool | 这个插件实例能拿到仓库写权限 |
| 凭据 | pluginToken（7 天） | broker session（12h）+ installation token（1h） |
| 撤销 | 角色/权限变更 → 授权表变化 | 移出 GitHub 组织 / 卸载 App / revoke |
| 失败表现 | `mmw_route_denied` / `mmw_auth_required` | 仓库操作失败 |

面板分开展示。飞书授权是主授权；GitHub 是 race-ops feature 的二次凭据。

---

## 8. 撤销、过期与故障

| 事件 | 核心动作 | 插件表现 |
|---|---|---|
| 撤销 `race-ops.edit` | `policyRevision + 1` | 下一次授权表刷新后，`repo_edit` 调用被拒；工具仍可见 |
| 停用成员 | 删除 tokens/sessions；`policyRevision + 1` | 下一次调用 401 → 拒绝；工具仍可见 |
| 成员重新启用 | 恢复角色/权限 | 重新登录后调用恢复；工具一直都在 |
| token 过期 | — | 所有调用拒绝；工具仍可见；提示登录 |
| 核心不可达 | — | 读工具 grace 内可用；写工具立即拒绝 |
| 授权表陈旧 | — | `stale` 标记；读工具按 grace，写工具拒绝 |
| 目录新增 tool | `catalogRevision` 变 | 旧插件没有该 tool；核心不会允许不存在的 tool |
| 目录删除 tool | `catalogRevision` 变 | 插件仍注册；核心授权表不再 allowed → 调用拒绝 |
| 传输层崩溃 | — | 调用失败；懒重启；工具仍注册 |

关键：**撤销不再触发卸载**。这消除了卸载与在途调用的竞态；代价是撤销后工具仍然可见，但一定用不了。

---

## 9. 分阶段实施

> 原则：先核心，后载体；不依赖 DSH 工具热插拔。

### Phase 0 — 契约 v0（已完成）

- [x] `contracts/features.json` + Schema：`race-ops` 的 `repo_status`、`repo_read`（read）和 `repo_edit`（write）。
- [x] `/v1/agent/routes` 响应契约：`allowed` / `denied` / `policyRevision` / `ttlSeconds`。
- [x] 错误码：`mmw_auth_required`、`mmw_route_denied`、`mmw_policy_unavailable`、`mmw_tool_unavailable`，见 [`contracts/ERRORS.md`](contracts/ERRORS.md)。
- [x] 确认静态注册的取舍（工具可见但不可用）。
- [x] `scripts/check-contracts.mjs`：结构校验、契约漂移检查、golden route tables。
- [x] CI 增加 `Validate feature contracts` 步骤。

**验收**：`node scripts/check-contracts.mjs` 通过；golden route tables 与 catalog 一致；v0 目录内容待你确认。

### Phase 1 — 飞书鉴权核心 MVP（已实现，待真实联调）

- [x] `mmw-tools-auth`：Store / Auth / server / 最小管理 UI。
- [x] 飞书 OAuth + PKCE + browser cookie + state。
- [x] `POST /v1/login/start`、`GET /v1/login/:id`、`GET /v1/me`、`POST /v1/session/{refresh,logout}`。
- [x] 成员表、角色、`policyRevision`、审计、最后管理员保护。
- [x] mock 飞书测试（13 个用例），见 [`mmw-tools-auth/tests/run.mjs`](mmw-tools-auth/tests/run.mjs)。
- [ ] 真实飞书组织联调 + 浏览器手测（bootstrap 链接已生成，待你本人登录）。
- [x] 部署到 `mmw-tools.mmw-team.icu`：DNS A、nginx server block、ZeroSSL 证书、systemd。
- [x] 公网 `/health` 返回 auth core JSON；`/api/me`、`/v1/agent/routes` 未登录返回 401。

**验收**：`node mmw-tools-auth/tests/run.mjs` 通过；公网 `/health` 正常；新成员默认无权限；管理员改角色后 revision 递增。真实飞书登录仍待你本人完成 bootstrap。

### Phase 2 — 授权表（已完成）

- [x] 核心读取 `features.json`，计算 `catalogRevision`。
- [x] 角色 + 直授 → effective permissions。
- [x] `GET /v1/agent/routes`：返回 `allowed` / `denied` / revisions / ttl。
- [x] `POST /v1/agent/events`：接收调用拒绝/错误事件。
- [x] 核心测试：viewer/editor/operator/admin 的授权表与 `contracts/examples/` 一致。

**验收**：给定成员，allowed 集合可预测；撤销权限后下一张表立即少 tool。

### Phase 3 — 插件静态注册 + 调用门禁（4–6 天）

- [ ] 启动时枚举 `IMPLEMENTATIONS`，静态注册全部工具。
- [ ] 每个代理工具实现 Auth → Policy → Transport 流水线。
- [ ] `policyCache`：60s TTL；写工具 15s 新鲜度。
- [ ] `mmw_status`：身份、授权表状态、每个工具 allowed/denied 原因。
- [ ] 面板：静态工具列表 + allowed/denied 徽标。
- [ ] 未登录、无权限、token 过期、核心不可达的测试。

**验收**：viewer 的工具列表里能看到 `repo_edit`，但调用返回 `mmw_route_denied`；editor 调用成功；全程不需要重启 DSH。

### Phase 4 — 加固（3–4 天）

- [ ] 401/403/网络错误/过期/grace 处理。
- [ ] MCP 传输层懒启动、崩溃重启、隔离。
- [ ] 契约漂移（publicName/permission/risk）检测。
- [ ] 本地 JSONL + 核心事件上报。
- [ ] 安全测试：未登录、无权限、伪造 toolId、token 过期、核心不可达。

**验收**：撤销后写工具在 15s 内拒绝；读工具在 grace 内可用；日志无 token。

### Phase 5 — 第二个功能（2–3 天）

- [ ] 加一个只读 feature。
- [ ] 只改 `features.json` + 权限 + 插件实现；不改调用门禁。
- [ ] 验证：静态注册出现；无权限时调用被拒。

### Phase 6 — 部署与灰度（3–5 天）

- [ ] 核心上线；bootstrap 首位管理员；pilot 用户。
- [ ] 监控：登录失败、授权表失败、拒绝率、传输层失败。
- [ ] 回滚：`router.mode: legacy`。
- [ ] ICP 公网可达性确认。

---

## 10. 测试策略

### 10.1 契约测试

- [ ] `features.json` 通过 Schema。
- [ ] 每个 `tool.permission` 在 `KNOWN_PERMISSIONS` 中。
- [ ] 插件 `IMPLEMENTATIONS` 覆盖目录中的 tool，`publicName` / `permission` / `risk` 一致。
- [ ] 目录中每个 `requiresAny` 至少有一个角色能满足。

### 10.2 核心测试

- [ ] 登录成功/拒绝/重放/换浏览器/租户不符。
- [ ] token 过期/刷新/登出/停用。
- [ ] 角色展开、直授权限、revision 事务。
- [ ] 授权表：viewer/editor/operator/admin 快照。
- [ ] 最后管理员保护。
- [ ] CSRF / 限流 / body 上限。

### 10.3 插件测试

- [ ] 启动时全部工具注册，未登录也一样。
- [ ] 未登录调用 → `mmw_auth_required`，不启动 MCP。
- [ ] 无权限调用 → `mmw_route_denied`，不启动 MCP。
- [ ] 有权限调用 → 启动 MCP 并执行。
- [ ] 撤销权限后调用 → 拒绝；工具仍在注册表。
- [ ] token 过期 → 所有调用拒绝；工具仍在。
- [ ] 核心不可达 → 读 grace / 写拒绝。
- [ ] 传输层崩溃 → 调用失败；下次调用懒重启。
- [ ] 契约不一致 → 该 tool 不注册；其他正常。
- [ ] 日志/审计无 token。

### 10.4 真机

- [ ] 真实飞书 H5 登录（桌面 + 移动）。
- [ ] viewer/editor/operator 的 allowed 集合。
- [ ] 撤销后 15s 内写工具拒绝。
- [ ] race-ops edit / preflight / draft PR 全链路。
- [ ] GitHub broker 未授权时的错误区分。

---

## 11. 安全与威胁模型

| 威胁 | 缓解 |
|---|---|
| 本地插件被篡改 | 插件不是安全沙箱；真正的爆炸半径由 GitHub App token、repo guard、人工 PR 审核限制。核心不依赖本地代码做授权决策。 |
| pluginToken 泄漏 | 0600、7 天、可撤销；token 只能读授权表/身份，不能直接写仓库。 |
| 核心被入侵 | 能改授权表，但拿不到 GitHub 私钥，不能下发代码；审计可追踪。 |
| 飞书账号被盗 | 租户校验 + 管理员停用 + token 撤销；写操作仍受 race-ops guard 约束。 |
| 回调重放/换浏览器 | 一次性 state + browser cookie + PKCE + pollSecret 分离。 |
| 未授权调用 | 每次调用检查 `allowed`；不在集合内一律拒绝；工具可见但不放行。 |
| 授权表陈旧 | 60s TTL；写工具 15s 新鲜度；核心不可达时写操作 fail closed。 |
| 插件自行放行 | 插件代码可以被改，但远端写仍受 GitHub App token / repo guard 限制；核心授权表是正常路径的 PEP。 |
| 核心下发恶意代码 | 核心只下发 tool ID / 允许集合；代码来自插件本地。 |
| 日志泄漏 | 不记 token/cookie/code；事件只报 tool ID 与结果。 |

**明确不防的**：

- 用户主动把 pluginToken 交给别人。
- 有 `race-ops.edit` 的用户在本机执行任意代码。
- 管理员给自己授权（审计可见）。
- GitHub installation token 在 1 小时内的滥用。

---

## 12. 运维与回滚

- 核心：systemd + nginx + SQLite；保留上一版本目录；备份 `auth.sqlite`。
- 插件：`router.mode: legacy` 回滚；工具仍然注册，但跳过 Auth/Policy 检查。
- 监控：登录失败、授权表失败、`mmw_route_denied` 比例、传输层启动失败。
- 审计：核心只记成员/权限/登录/token；插件本地 JSONL 记调用拒绝与传输层错误。

---

## 13. 待确认

### 13.1 已确认

- 域名：`mmw-tools.mmw-team.icu`。
- 飞书应用：新建。
- 首位管理员：用你的账号；不知道 `open_id` 时走 6.4.1 的 bootstrap。
- 路由消费者：DSH agent。
- 功能注册表：核心拥有。
- **工具不动态增删；静态注册 + 调用时授权。**

### 13.2 仍需确认

1. **授权表 TTL**：读 60s、写 15s 是否合适？更短更安全但请求更多；更长更省但撤销更慢。
2. **核心不可达时的写操作**：默认 fail closed（写直接拒绝），读 24h grace；是否接受？
3. **工具可见性**：agent 能看到无权工具（调用被拒）；是否接受？如果希望“看不见”，需要在 UI/注册层再做一层过滤，但会重新引入动态列表。
4. **是否要 per-call 授权接口**：MVP 先用缓存；如果要求撤销秒级生效，再加 `POST /v1/agent/authorize`。
5. **`race-ops.read` 是否包含 `repo_clone` / `repo_pull`**：建议包含；否则拆 `race-ops.sync`。
6. **事件上报范围**：只报 tool ID/结果/时间，不报参数；是否接受？

---

## 14. 验收清单

- [ ] 插件启动后，全部工具已注册；未登录也能看到工具列表。
- [ ] 未登录调用任何业务工具 → `mmw_auth_required`，MCP 未启动。
- [ ] viewer 调用 `repo_edit` → `mmw_route_denied`；工具仍在列表。
- [ ] editor 调用 `repo_edit` → 成功。
- [ ] 撤销 `race-ops.edit` 后 15s 内写工具调用被拒。
- [ ] token 过期后所有调用被拒；工具仍在列表。
- [ ] 核心不可达时读工具 grace 内可用，写工具拒绝。
- [ ] 传输层崩溃后，下次调用懒重启。
- [ ] `mmw_status` 能解释每个工具 allowed/denied 的原因。
- [ ] 契约测试、核心测试、插件测试、race-ops 真机回归全绿。
- [ ] `router.mode: legacy` 1 分钟内回滚。
- [ ] 日志、审计、面板、错误信息中没有 token/secret。

---

## 附录 A：一次调用的完整链路

```
1. 插件启动：注册全部 tool，注册 mmw_status
2. 用户登录：拿 pluginToken，GET /v1/agent/routes
3. 核心：member → roles → permissions → allowed/denied
4. agent 调用 repo_edit：
     Auth 检查（token 有效？）
     Policy 检查（repo_edit 在 allowed？）
     Transport 检查（race-ops MCP 已启动？没有则懒启动）
     执行 repo_edit
5. 管理员撤销 race-ops.edit：
     policyRevision + 1
6. 下一次写调用前：
     授权表超过 15s → 同步刷新
     repo_edit 不在 allowed → mmw_route_denied
7. 工具仍在 agent 的工具列表中；mmw_status 显示 denied + 缺失权限
```

## 附录 B：与 v2 的差异

| v2 | v3 |
|---|---|
| 动态挂载/卸载 | 静态注册，永不因权限增删 |
| 路由表决定工具是否存在 | 路由表决定调用是否允许 |
| Feature 挂载 FSM | 传输层健康 FSM + 调用授权 |
| 需要 DSH 热插拔 | 不需要；取消 spike |
| 撤销触发卸载 | 撤销只影响下一次调用 |
| agent 只看到有权限的工具 | agent 看到全部工具，但无权调用会被拒 |

## 附录 C：相关代码位置

| 内容 | 位置 |
|---|---|
| 现有插件 apply / 工具注册 | [`dsh-github-engineer/src/index.ts`](dsh-github-engineer/src/index.ts) |
| 本机回环路由与安全校验 | [`dsh-github-engineer/src/routes.ts`](dsh-github-engineer/src/routes.ts) |
| GitHub 仓库授权 | [`dsh-github-engineer/src/auth/broker-auth.ts`](dsh-github-engineer/src/auth/broker-auth.ts) |
| 现有 MCP 工具 | [`dsh-github-engineer/mcp-server/src/tools/`](dsh-github-engineer/mcp-server/src/tools/) |
| GitHub token broker | [`dsh-github-engineer/broker/core.mjs`](dsh-github-engineer/broker/core.mjs) |
| 参考的 H5 授权模式 | `mmw-review-system/src/review-auth.ts`、`review-server.ts`（外部仓库） |
