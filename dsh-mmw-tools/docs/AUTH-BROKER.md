# AUTH-BROKER — GitHub App + token broker

Status: target design (topology B). The GitHub path is deployed; the Feishu
direct path (§12) is implemented in the broker and plugin, but stays off until
the broker sets `MMW_TOOLS_AUTH_URL`. See §12 for what is shipped and what is
still a gap.
Supersedes the Device Flow design in `OAUTH-FLOW.md` for repo access.
Device Flow is not deleted: it is re-scoped to *identity only* (see §3).

---

## 1. 目标

让若干使用者能用**自己的 GitHub 账号**登录，然后**以 bot 身份**操作
`mmw-devs/ffxiv-race-ops`。使用者不需要是该仓库的协作者，也不需要
`repo` scope；仓库的写权限只由一次性的 App 安装提供。

three properties that matter:

1. **写入身份是 bot**，不是使用者。PR 作者是 `mmw-tools-app[bot]`。
2. **user 与 repo 权限解耦**。使用者登录只证明"他是谁"，不产生任何仓库权限。
3. **撤销是单点的**。从允许名单移除某人，或卸载 App，立即生效；不需要
   逐个仓库改权限。

Since 2026-11-11 there is a second, GitHub-free route: a **Feishu member** whose
roles include this repository's operations signs in only to the auth core, and
the broker mints the same kind of installation token from that plugin token
(§12). The bot identity, the user/repo permission split, and single-point
revocation are unchanged; what changes is who can ask the broker for a token.

## 2. 拓扑

```
┌─────────────┐   1. 登录（浏览器）      ┌──────────────────┐
│  使用者机器  │ ───────────────────────▶ │  GitHub OAuth    │
│  DSH 插件    │ ◀─────────────────────── │  (App 的用户授权) │
└──────┬──────┘   2. 回到 broker         └──────────────────┘
       │                                          ▲
       │ 3. 轮询 session / 取 installation token   │ 4. 校验身份 + 允许名单
       ▼                                          │
┌──────────────────────────────────────────────────┴───────────┐
│  Broker（腾讯云）                                              │
│  · 持有 App ID、私钥(.pem)、client_id/secret                 │
│  · 校验：GitHub 用户 → 组织成员 / 白名单                       │
│  · 用私钥签 JWT → 换 installation token（1 小时）              │
│  · 只把 1 小时 installation token 与短期 session 发给插件       │
└──────────────────────────────┬───────────────────────────────┘
                               │ 5. installation token
                               ▼
                    GitHub App 已安装到 ffxiv-race-ops
                    （Contents RW + Pull requests RW + Metadata R）
```

私钥**只存在于 broker**。插件所在的机器上没有任何能铸造仓库权限的东西。

The Feishu path adds a second front door to the same broker:

```
┌─────────────┐  1. 飞书登录（浏览器）   ┌──────────────────┐
│  使用者机器  │ ───────────────────────▶ │  auth core       │
│  DSH 插件    │ ◀─────────────────────── │  /v1/me, routes  │
└──────┬──────┘  2. pluginToken (0600)   └──────────────────┘
       │ 3. POST /installation-token
       │    X-MMW-Feishu-Token: <pluginToken>
       ▼
┌──────────────────────────────────────────────────────────────┐
│  Broker（腾讯云）                                             │
│  · 用 pluginToken 调 /v1/me + /v1/agent/routes               │
│  · 按 allowedOperations 决定 read / write / 拒绝              │
│  · 用私钥签 JWT → 换**收窄权限**的 installation token          │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
                    GitHub App 已安装到 ffxiv-race-ops
```

The auth core is the only place that answers "who is this and what may they
do"; the broker does not keep a second role table.

## 3. 三个身份层次

| 层 | 证明什么 | 凭据 | 存放 | 有效期 |
|---|---|---|---|---|
| 使用者身份 | 你是 `mmw-devs` 成员 / 在白名单里，**或**是有本仓库 operation 的飞书成员 | GitHub user token（只用于 `/user`，不落盘）**或**飞书 pluginToken（auth core 签发，插件 0600 保存） | broker 内存 / 插件本机 | GitHub：校验结果缓存 10 分钟；飞书：pluginToken 自身 TTL |
| 插件会话 | 这个插件实例已被 broker 认可 | session token（32 字节随机，sha256 存库） | 插件本机 0600 | 12 小时 |
| 仓库写入 | App 被安装在仓库上且具备权限 | installation token | 插件本机内存（可选缓存 ≤ 50 分钟） | 1 小时 |

关键性质：**session token 不能直接写仓库**。它只能向 broker 换一个 1 小时的
installation token，而 broker 每次都会重新检查该 session 仍然有效且使用者
仍在允许名单里。踢人不需要等 token 过期。Feishu 签发的 token 还会按路由表
收窄 `permissions`，不是 App 的完整权限集。

## 4. GitHub App 注册清单

在 `mmw-devs` 组织下注册（`Settings → Developer settings → GitHub Apps → New`）。

| 字段 | 值 | 备注 |
|---|---|---|
| Name | `mmw-tools-app` | 会显示为 `mmw-tools-app[bot]` |
| Homepage URL | broker 的站址 | 必填，无实际作用 |
| Callback URL | `https://<broker-host>/auth/github/callback` | **必须 HTTPS**，与 `BROKER_PUBLIC_URL` 一致 |
| Request user authorization (OAuth) during installation | 关闭 | 授权由 broker 单独发起 |
| Webhook | **Active 关闭** | 本项目不需要事件推送 |
| Where can this be installed | Only on this account | 限制为 `mmw-devs` |

Permissions —— **只给这些，其他全部 No access**：

| 权限 | 级别 | 用途 |
|---|---|---|
| Repository → Contents | Read and write | clone、push `content/*` |
| Repository → Pull requests | Read and write | 开 draft PR、列 PR |
| Repository → Metadata | Read | 强制项，自动带上 |

不要给 `Workflows`：`denylistPaths` 已经禁止改 `.github/workflows/**`，
给了只会扩大爆炸半径。

安装范围：**Only select repositories → `ffxiv-race-ops`**。

产出三样东西：

- `App ID`（数字）
- `Client ID` + `Client secret`（用于用户授权）
- 一个 **private key**（`.pem`，只下载一次）

外加安装后得到的 `installation id`（可从
`https://github.com/organizations/mmw-devs/settings/installations` 的 URL 里看到）。

## 5. Broker 接口

全部 JSON，全部要求 HTTPS。错误一律 `{ error: "<code>", message: "<人类可读>" }`。

### `GET /health`

```json
{
  "ok": true,
  "appId": "5469681",
  "repository": "mmw-devs/ffxiv-race-ops",
  "allowMode": "org",
  "org": "mmw-devs",
  "pendingSessions": 0,
  "activeSessions": 0,
  "allowCacheEntries": 0,
  "allowListSize": 3,
  "feishuEnabled": true
}
```

`allowListSize` 是名单人数（`allowListSize`，不是 `allowlistSize`），部署后用它确认新配置
真的被加载；不返回姓名，也不返回任何密钥。`feishuEnabled` 只表示 broker 配了
`MMW_TOOLS_AUTH_URL`，不代表 auth core 当前可达。

### `POST /session/start`

插件发起一次登录。

请求：`{}`（无 body 也接受）

响应：

```json
{
  "state": "b64url-32-bytes",
  "pollSecret": "b64url-32-bytes",
  "loginUrl": "https://<broker>/auth/github/start?state=<state>",
  "expiresAt": 1780000000000
}
```

`state` 用于关联浏览器回调；`pollSecret` 是插件轮询用的凭据，**只有插件知道**。
两者分开，避免浏览器 URL 泄漏即可换取 session。

### `GET /auth/github/start?state=...`

浏览器入口。302 到 GitHub：

```
https://github.com/login/oauth/authorize
  ?client_id=<App client id>
  &state=<state>
  &redirect_uri=https://<broker>/auth/github/callback
  &allow_signup=false
```

（GitHub App 的用户授权不使用 `scope`；权限来自 App 本身。）

### `GET /auth/github/callback?code=...&state=...`

1. 交换 `code` → user access token（server-to-server）。
2. `GET /user` → `login`。
3. 允许名单检查（§6）。
4. 通过则给该 `state` 打上 `authorized`，并在**那个 state 名下**生成
   `session token`，TTL 12 小时。
5. 立刻丢弃 user token（不落盘、不写日志）。
6. 渲染一个最小 HTML 页：`已授权，可以关闭此页面。`

**浏览器不参与等待。** 上面 1–3 全是 server-to-server 调用，浏览器只
需要拿到一个页面。所以回调最多等 GitHub 5 秒：正常时照旧渲染「已授权为
`login`」；超过 5 秒就先回答「正在确认身份」，exchange 继续在后台跑，
结果由插件轮询 `/session/{state}` 取走。返回给浏览器的状态码仅用于告知：
200（已确认或正在确认）、403（不在允许名单）、502（校验失败）、400
（链接过期或已使用）。

> **2026-10-29 事故**：此前回调是同步的，且 GitHub 调用没有超时。跨境链路
> 抖动时 handler 活过了 nginx 的 `proxy_read_timeout 20s`，用户看到的是
> `504 Gateway Time-out` 而不是登录页；同时失败的 state 停在 `consumed`，
> 轮询一直读作 `pending`，面板只能干等到 5 分钟过期。现在两者都已修正
> （见 CHANGELOG）。**注意 `proxy_read_timeout` 仍是 20s，但不再需要改**，
> 因为慢路径在 5s 内就已回答。

### `GET /session/{state}?secret=<pollSecret>`

插件轮询。

- `{"status":"pending"}`
- `{"status":"denied","reason":"not-a-member"}`
- `{"status":"expired"}`
- `{"status":"authorized","sessionToken":"...","login":"...","expiresAt":...}`

`sessionToken` 只在这里返回一次。

### `POST /installation-token`

Two credential forms share one mint path:

```
Authorization: Bearer <sessionToken>          # GitHub path
X-MMW-Feishu-Token: <pluginToken>             # Feishu path; no GitHub session
```

If both are present the Feishu header wins (the plugin sends only one).

Optional query parameter `?repo=owner/name` selects a non-default repository
from the broker's registry (`BROKER_REPOS`, §9). Omitted means the default
`REPO_OWNER/REPO_NAME`. An unknown key is refused with `403 repo-denied`; the
minted token is limited to that repository and the response echoes its
canonical `owner/name`.

Response:

```json
{
  "token": "ghs_...",
  "expiresAt": 1780000000000,
  "repository": "mmw-devs/ffxiv-race-ops",
  "permissions": { "contents": "read", "pull_requests": "read" },
  "authMode": "feishu",
  "login": "张三",
  "scope": "read"
}
```

`authMode`, `login` and `scope` are present on the Feishu path; a GitHub mint
returns `authMode: "github"` (and may omit `login`/`scope` for compatibility
with older brokers).

**GitHub path** — 校验 session（未过期、未撤销）→ **重新确认使用者仍在允许名单**
（缓存 10 分钟）→ 私钥签 JWT（`iat=now-60s`, `exp=now+540s`）→
`POST /app/installations/{id}/access_tokens` → 返回 token。

**Feishu path**：

1. `GET /v1/me` with `Authorization: Bearer <pluginToken>`; a string `id` is
   required.
2. `GET /v1/agent/routes`; read `allowedOperations`.
3. Require at least one repository operation (`repo_read`, `repo_edit`,
   `pr_create`, `pr_close`, or `pr_merge`); none →
   `403 feishu-no-access` (no mint).
4. `/installation-token` always mints the read-only client token
   `{contents: "read", pull_requests: "read"}`. Write permission is checked
   again on each `/v1/write/*` call (§13), never by this endpoint.
5. Failure codes: auth core 401/403 → `feishu-auth-rejected`; non-2xx / bad
   JSON → `feishu-check-failed` / `feishu-bad-response`; network → 
   `feishu-unreachable`; no `MMW_TOOLS_AUTH_URL` → `feishu-not-configured`.

### `POST /session/revoke`

```
Authorization: Bearer <sessionToken>
```

立即删除 session。插件侧的「Revoke」按钮调用它。

## 6. 允许名单

**决定顺序**（`broker/core.mjs` 的 `#checkAllowlist`）：

1. `BROKER_DENIED_USERS` 命中 → 拒绝（应急拉黑，任何模式都生效）
2. `BROKER_ALLOWED_USERS` 命中 → 放行，不调 GitHub
3. `BROKER_ALLOW_MODE=list` → 拒绝（名单是唯一授权来源）
4. 否则查组织成员：`GET /orgs/mmw-devs/members/{login}`，204 放行、404 拒绝

`BROKER_ALLOWED_USERS` 是**叠加授权**，不是与 `org` 互斥的第二种模式。这一点是
设计上的要害：本插件存在的理由就是让**不在 `mmw-devs` 的人**也能操作仓库 ——
他们用 GitHub 账号证明身份，写权限来自 App 安装（§1），因此不需要是组织成员、
不需要是协作者、也不需要 `repo` scope。如果 `org` 模式把显式名单排除在外，
"邀请一个外部协作者"这件事就无从实现：他连登录都完不成。

> 2026-10-29 修正：此前实现把 `org` / `list` 做成二选一，线上 `org` 模式下
> `BROKER_ALLOWED_USERS` 根本不参与判断，外部用户会在回调阶段被
> `not-a-member-of-mmw-devs` 拒绝。现在名单在两种模式下都生效。

| 配置 | 谁能登录 |
|---|---|
| `BROKER_ALLOW_MODE=org`（默认）+ 名单 | 组织成员 ∪ 名单 |
| `BROKER_ALLOW_MODE=list` + 名单 | 仅名单 |

**给外部人员开权限**：把他的 GitHub 用户名加进 `.env` 的
`BROKER_ALLOWED_USERS`（逗号分隔，大小写不敏感），
`sudo systemctl restart race-ops-broker`；`.env` 只在启动时读，所以重启是必须的。

生效时机（容易误判"没修好"）：

| 动作 | 生效时间 |
|---|---|
| 加入 `BROKER_ALLOWED_USERS` | 重启后，对方下一次尝试即可（显式放行在缓存之前判定，不会被他上次被拒的缓存挡住） |
| 移出 `BROKER_ALLOWED_USERS` | 下一次签发 installation token 即拒绝（名单命中不写缓存） |
| 加入 `BROKER_DENIED_USERS` | 下次请求即拒绝（拒绝判定在缓存之前） |
| 从 GitHub 组织移除成员 | 最多 10 分钟（组织成员判定有缓存） |

组织模式的既有前提不变：App 需要 `Organization → Members: Read-only`，并且
**在安装上接受新权限**（只改 App 权限不重新批准安装，会表现为
`allowlist-check-failed`）。切换后的实测日志：

```
session_start      -> session_authorized login=weunimix
                   -> installation_token_issued
/health            -> allowMode: org, activeSessions: 1
```

无论哪种模式，`BROKER_DENIED_USERS` 里的用户名一律拒绝（应急拉黑）。

### 飞书直连（2026-11-11）

This is a **second authorization source**, not a change to the GitHub allowlist.
`POST /installation-token` with `X-MMW-Feishu-Token` asks the auth core who the
member is and what the route table allows. The GitHub org/allowlist check is
not consulted on this path — the member may have no GitHub account at all.

The scope decision uses the same operation ids the plugin gate uses. The
`/installation-token` endpoint always answers with a **read-only** client token;
write operations are proxied per call in §13.

| `allowedOperations` contains | Client token |
|---|---|
| any of `repo_read` / `repo_edit` / `pr_create` / `pr_close` / `pr_merge` | read: `contents: read`, `pull_requests: read` |
| none | refused, `feishu-no-access` |

Properties worth stating:

- The broker does **not** cache the Feishu decision. Every mint calls
  `/v1/me` and `/v1/agent/routes`, so a role revocation takes effect on the next
  token request, not after a TTL.
- The client token is read-only even for an `editor` or `operator`. A stolen
  token file cannot write a branch or merge a PR.
- Write authorization is checked again on every `/v1/write/*` call (§13); it is
  not inferred from holding a client token.
- A Feishu member is not added to `BROKER_ALLOWED_USERS` and does not need a
  GitHub username. The two paths are independent.

## 7. 威胁模型

| 威胁 | 缓解 |
|---|---|
| 插件机器被入侵 | 只有 12 小时 session + 1 小时 installation token；`/session/revoke` 立即失效；私钥不在本机 |
| 浏览器 URL 泄漏（历史记录、截图） | `state` ≠ `pollSecret`，只泄漏 `state` 拿不到 session |
| 回调被重放 | `state` 一次性，用后即焚；5 分钟未回调则过期 |
| 允许名单里的账号被盗 | 客户端 token 只有 Contents/PR 读；写操作要经过 broker 的 `/v1/write/*`，每次重新校验 session 与允许名单；GitHub 侧审计可见 bot 操作时间线 |
| 飞书 pluginToken 被盗 | 只在该 token 的 TTL 内可用；broker 每次 mint 与每次写调用都向 auth core 复核；撤销角色后下一次调用即拒绝；客户端 token 只读 |
| 本机进程自行调用 `/v1/write/pr_merge/approval` | **部分防**：approval 绑定 member、PR、head SHA，5 分钟过期且一次性；但它不区分“用户在宿主里点了确认”与“agent 自己发 HTTP”。宿主对 `pr_merge` 的 ask 是 UI 门，不是服务端边界；彻底隔离需要 host-only secret |
| 私钥泄漏 | 只能重签：GitHub App 删旧 key、生成新 key、重启 broker；已发 installation token 自然 1 小时内过期 |
| broker 被 DDoS | 每 IP 每分钟 60 次、每 state 轮询 1 次/2 秒；超限 429 |
| 日志泄漏 | 只记 `login`、`state` 前 8 位、结果码；token 一律不进日志（复用 `redactTokens`） |
| 中间人 | 强制 HTTPS，HSTS；broker 只监听 127.0.0.1，由 Caddy/nginx 终止 TLS |

**明确不防的**：broker 内存里的 write token 可以在 1 小时内任意写仓库
（这正是它的用途），但它不再下发到客户端。客户端拿到的
`~/.dsh/dsh-mmw-tools-write-auth.json`（0600）只含飞书 pluginToken 或
GitHub sessionToken，不含 GitHub write token；能读该文件、又能发 HTTP 的
本地进程可以自行申请 approval 并触发合并，宿主确认拦不住这条路。
文件权限和机器账户是这一层的边界。

## 8. 插件侧改动

新增：

- `src/auth/broker-client.ts` — `startSession()`, `pollSession()`, `getInstallationToken()`, `revoke()`
- `src/auth/installation-token-cache.ts` — 内存缓存，提前 10 分钟刷新

修改：

- `config.authMode: "broker" | "device"`，默认 `broker`
- `routes.ts` — `/oauth/*` 保留给 `device` 模式；新增 `/broker/*` 面板动作
- `src/client/index.js` — 面板按钮文案按模式切换（「Sign in via broker」）
- `TokenStore` — broker 模式下只存 `sessionToken` + `expiresAt`，**不存** installation token
- `mmw_tools_status` — 显示 `authMode`、`login`、session 剩余时间、installation token 是否已缓存

**不变**：`mcp-server/src/guard.ts` 全套、`repo_edit` 状态机、
`allowlist/denylist/branchPrefix/preflight/bootstrap`、审计日志、脱敏。
认证方式与这些正交，这是现有 10 个守卫能直接复用的原因。

## 9. 部署（腾讯云）

前置：一个域名 + HTTPS 证书（Caddy 自动签发最省事）。GitHub 的
callback URL 必须是 HTTPS，所以没有证书这条路走不通。

```
/opt/race-ops-broker/
  app.pem            # 0400, owner=raceops
  .env               # 0400, owner=raceops
  broker/core.mjs
  broker/server.mjs
  lib/auth/github-app.js
```

`.env`：

```
BROKER_PUBLIC_URL=https://race-ops-broker.mmw-team.icu
GITHUB_APP_ID=123456
GITHUB_APP_CLIENT_ID=Iv1...
GITHUB_APP_CLIENT_SECRET=...
GITHUB_APP_INSTALLATION_ID=...
GITHUB_APP_PRIVATE_KEY_PATH=/opt/race-ops-broker/app.pem
BROKER_ORG=mmw-devs
BROKER_ALLOW_MODE=org
BROKER_ALLOWED_USERS=
BROKER_DENIED_USERS=
# 写代理（§13）：默认关闭；开启后客户端仍只拿只读 token。
BROKER_WRITE_ENABLED=true
# 与插件侧的 allowlist/denylist 保持一致；逗号分隔，支持 **/*/?。
BROKER_ALLOWLIST_PATHS=public/data.json,scripts/**
BROKER_DENYLIST_PATHS=AGENTS.md,.github/**
BROKER_BASE_BRANCH=main
BROKER_BRANCH_PREFIX=content/
# 可选：额外仓库注册表（JSON 数组）。目前只用于 /installation-token 的
# ?repo= 选择；写代理仍只操作默认仓库。每项可覆盖 baseBranch/branchPrefix/
# allowlistPaths/denylistPaths，省略则继承上面的默认值。
# BROKER_REPOS=[{"owner":"mmw-devs","name":"xivstrat-relay","baseBranch":"master"}]
BROKER_REPOS=
# 可选：写审计 JSONL；目录必须对服务用户可写。不配则只写进程日志。
BROKER_AUDIT_LOG=/opt/race-ops-broker/write-audit.jsonl
# 飞书直连（可选）：配了才会接受 X-MMW-Feishu-Token；broker 必须能访问 auth core。
MMW_TOOLS_AUTH_URL=https://mmw-tools.mmw-team.icu
PORT=8787
# 出网走本机 mihomo（Clash）的 HTTP 监听口；不开这个，跨境到 github.com
# 偶尔会卡住（2026-10-29 那次 504 的直接原因）。Node ≥ 24 的 fetch 才会
# 认 NODE_USE_ENV_PROXY，`/usr/local/bin/node -v` 要先确认版本。
NODE_USE_ENV_PROXY=1
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
NO_PROXY=127.0.0.1,localhost,::1
```

### 出网代理（2026-10-29 起）

这台机器上 mihomo（Clash.Meta，`/etc/mihomo/config.yaml`）已经在跑：
`port: 7890` 是 HTTP 代理，`socks-port: 7891` 是 SOCKS，7892 是 redir。
Node 的 `fetch` 只认 HTTP(S) 代理，所以只写 7890。

broker 是 systemd 服务，不会继承登录 shell 的 `no_proxy`，所以四个变量
必须写进上面那份 `.env`（`EnvironmentFile` 会带进进程），改完
`systemctl restart race-ops-broker` 生效。

验证「变量真的生效」而不是自我安慰：把 `HTTPS_PROXY` 指到一个关着的端口，
同一个 Node 调 GitHub 应当立刻 `ECONNREFUSED`；只有配对的代理才返回 200。
另一种确认方式是看进程自己的环境：

```bash
PID=$(systemctl show -p MainPID --value race-ops-broker)
sudo sh -c "tr '\0' '\n' < /proc/$PID/environ | grep -E '^(HTTPS_PROXY|NODE_USE_ENV_PROXY)='"
```

> 只改 App 的 callback URL 或 DNS 不受影响；`NO_PROXY` 只排除回环，
> 不要把它写成 `github.com`，否则代理等于没配。

systemd（只监听回环，TLS 由 Caddy 终止）：

```ini
[Unit]
Description=dsh race-ops broker
After=network.target

[Service]
WorkingDirectory=/opt/race-ops-broker
ExecStart=/usr/local/bin/node /opt/race-ops-broker/broker/server.mjs
Restart=always
EnvironmentFile=/opt/race-ops-broker/.env
User=raceops
Group=raceops
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### 主机名

`mmw-team.icu` 已在使用中，broker 走子域名，与现有项目互不影响：

```
race-ops-broker.mmw-team.icu
```

需要且只需要一条 DNS 记录：

| 类型 | 名称 | 值 | TTL |
|---|---|---|---|
| A | `race-ops-broker` | 腾讯云服务器的公网 IP | 300（联调期短 TTL） |

**不要**动现有的 `@` / `www` 记录。GitHub App 的 callback URL 必须是

```
https://race-ops-broker.mmw-team.icu/auth/github/callback
```

### TLS：DNS-01 是唯一可行的方式（已上线）

最初计划用 certbot + HTTP-01。实测不可行：这台机器的入站 80 端口，对
Let's Encrypt 的验证器（全部在境外）会返回腾讯的备案拦截页
（`302 -> dnspod.qcloud.com/static/webblock.html?d=<域名>`）。权威 DNS 在
所有 EDNS 分区都正确解析到本机，ACME 校验文件在国内访问也返回 200 ——
失败的只有跨境入站。因此 HTTP-01 永远无法通过，与 nginx 配置无关。

改用 **DNS-01**：控制权通过 `_acme-challenge` TXT 记录证明，不需要任何
入站访问。工具是 acme.sh（GitHub 在这台机器上拉不动，用 gitee 镜像安装）：

```
/root/.acme.sh/acme.sh          v3.1.5
/etc/acme/tencent.env           Tencent_SecretId / Tencent_SecretKey，0600
/etc/nginx/ssl/race-ops-broker/ fullchain.pem + privkey.pem
```

签发命令见 `broker/deploy/issue-cert-tencent.sh`。证书由 Let's Encrypt 签发，
`acme.sh --install-cert` 把文件装到固定路径并注册 `systemctl reload nginx`，
所以续期时 nginx 配置不需要改动。

续期：acme.sh 自带 cron（每天 4 次），按 ARI 建议窗口在到期前约 30 天续期，
本次窗口是 2026-12-23。

**凭据说明**：`Tencent_SecretKey` 是腾讯云 API 密钥，能操作该账号下的 DNS
解析。它只用于续期那一刻，broker 运行时不需要。建议用只含
`QcloudDNSPodFullAccess` 的 CAM 子用户密钥，而不是主账号密钥。

### 证书变更记录

| 事项 | 结果 |
|---|---|
| HTTP-01（certbot + webroot） | ❌ 跨境入站被备案拦截页劫持 |
| DNS-01（acme.sh + dns_tencent） | ✅ 2026-10-26 签发，`CN=race-ops-broker.mmw-team.icu`，至 2027-01-23 |
| `ssl_session_cache` 名称 | 必须用独立名字（`SSL_BROKER`）：与现有站点的 `SSL` 区大小不同会让 nginx 拒绝加载 |

### 已解除：备案审核中导致的域名不可用

**2026-10-27 备案通过，以下现象全部消失。** 复核结果（从开发机，无隧道、无代理）：

| 检查 | 备案前 | 备案后 |
|---|---|---|
| `http://mmw-team.icu/` | 302 → webblock 页 | **301 → https** |
| `http://race-ops-broker.mmw-team.icu/health` | 301（nginx 可达） | 301 |
| **`https://race-ops-broker.mmw-team.icu/health`** | **TLS 被 RST** | **200, verify=0** |
| `https://mmw-team.icu/` | 连接失败 | **200** |
| Node `fetch`（插件用的路径） | `ECONNRESET` | **200** |

因此 SSH 隧道已不再需要，`~/.dsh/rc-tunnel.pem` 已删除，
`GHOST_BROKER_URL` 也不再设置 —— 插件直接用
`cordis.patch.yml` 里的公网 HTTPS 地址。

以下为当时的诊断记录，保留以便对照。

### 历史：备案审核中的域名不可用

2026-10-26 定位到一条与本项目无关、但会阻塞上线的外部条件：

`mmw-team.icu` 的 ICP 备案当时仍在管局审核中。审核期间腾讯会对该域名做
网络层拦截，表现为：

| 端口 | 行为 |
|---|---|
| 80 | `302 → dnspod.qcloud.com/static/webblock.html?d=<域名>`（备案拦截页） |
| 443 | TCP 能连上，但 TLS 握手被 RST；换任何端口（试过 8443）同样被 RST |

排查结论留档，避免重复投入：

- 服务器自身访问自己的公网 IP:443 返回 200，证书链校验通过（`verify=0`），
  nginx 与 Let's Encrypt 证书都正常 —— **服务端没有问题**
- 权威 DNS 与各公共解析器一致指向该 IP，无分线路、无泛解析
- Let's Encrypt 的 HTTP-01 之所以永远失败，也是同一层拦截（它的验证器全部
  在境外），这与 nginx 配置无关
- 本机浏览器能打开 `https://race-ops-broker.mmw-team.icu/health`，而 Node /
  curl 全部在 TLS 阶段被 RST —— 同一台机器上不同进程走了不同链路，说明是
  中间设备按 TLS 特征拦截，不是本机防火墙

**因此：备案通过前，公网 HTTPS 不可达，任何证书方案都无法改变这一点。**

过渡期验证手段：用 SSH 隧道把 broker 的回环端口映射到本机，并把插件指向它

```
ssh -N -L 8787:127.0.0.1:8787 ubuntu@<server>
GHOST_BROKER_URL=http://127.0.0.1:8787 dsh --profile <profile>
```

插件里 `GHOST_BROKER_URL` 优先于 `cordis.patch.yml` 的 `brokerUrl`，正是为了
这种"单机改指向"的场景。**这只是验证手段，不是交付形态。**

备案通过后需要复核的三件事（都已在 nginx/证书侧就绪，只需确认）：

1. `curl https://race-ops-broker.mmw-team.icu/health` 返回 200
2. `curl http://mmw-team.icu/` 不再是 webblock 页
3. GitHub App 的 callback URL 仍是
   `https://race-ops-broker.mmw-team.icu/auth/github/callback`

## 10. 分步实施（每步保持现有测试全绿）

| 步 | 内容 | 可本地验证 |
|---|---|---|
| 8a | `github-app.ts`：JWT 签名、installation token 交换、过期计算 | ✅ 用本地生成的 RSA 密钥，fetch 打桩 |
| 8b | broker 服务 + session 存储 + 允许名单 + 限流 | ✅ 注入 fetch，不需要网络 |
| 8c | 插件 `authMode: "broker"` + 面板改造 | ✅ 打桩 broker |
| 8d | 真机联调：腾讯云 broker + `t5` profile | ⚠️ 需要你的服务器就绪 |
| 8e | 文档收尾、`OAUTH-FLOW.md` 改写 | ✅ |

8a、8b 完全不依赖你的服务器，可以立刻开始。

## 12. 飞书直连：已实现与未实现

**已实现（2026-11-12）**

- broker 接受 `X-MMW-Feishu-Token`；用 `/v1/me` 取身份、`/v1/agent/routes` 取
  `allowedOperations`。`/installation-token` 只发只读客户端 token；写操作改为
  每次调用都校验 operation 的 `/v1/write/*` 代理（§13）。
- 插件先试飞书凭据（`FeishuAuth.credential()`），失败才回退 GitHub session；
  `/api/mmw-tools/status` 与 `mmw_tools_status` 返回 `mode`。
- 插件把当前凭据写入 `~/.dsh/dsh-mmw-tools-write-auth.json`（0600），MCP 子进程
  用它调用 broker；文件里是飞书 pluginToken 或 GitHub sessionToken，不是 GitHub
  write token。
- 面板：飞书模式显示「已登录（飞书）」，隐藏「重新获取仓库权限」「退出登录」，
  GitHub 按钮降级为「登录 GitHub（可选）」。
- MCP 的 `repo_edit` / `pr_create` / `pr_close` / `pr_merge` 在有写认证时走 broker；
  没有写认证时保留旧的本地 git / `gh` 路径，供独立使用与旧测试。
- 测试：`broker/tests/core.test.mjs`、`broker/tests/server.test.mjs`、
  `tests/broker-auth.test.mjs` 覆盖只读 token、写授权、幂等、approval、路径
  allow/deny 与回退。

**上线步骤**

1. `/opt/race-ops-broker/.env` 加
   `MMW_TOOLS_AUTH_URL=https://mmw-tools.mmw-team.icu`，并按 §13 配
   `BROKER_WRITE_ENABLED=true` 与 allow/deny 列表。
2. `systemctl restart race-ops-broker`。
3. `GET /health` 看到 `"feishuEnabled": true` 与 `"writeEnabled": true`。
4. 飞书成员在插件里完成飞书登录，不需要 GitHub 账号。只读要 `viewer`；开 PR
   或关 PR 要 `editor` 或更高（`repo_edit` + `pr_create` / `pr_close`）。

**未实现（仍是缺口）**

- 没有 host-only 的 merge secret。能读 0600 写认证文件、又能发 HTTP 的本地进程
  可以自行申请 approval 并合并；宿主的 `pr_merge` 确认只是 UI 门。
- 没有按单个 PR/分支再收窄；写代理只校验分支前缀、base 分支与路径 allow/deny。
- 幂等与 approval 状态在 broker 内存里，重启即丢。approval 丢失只会让合并失败；
  幂等丢失时重试仍由 `pr_create` 的同 head 查询兜底。
- 读 token 撤销最多延迟 1 小时（GitHub installation token 的固有 TTL）；写操作
  每次调用都重新校验，撤销立即生效。
- 没有 SQLite/多实例；审计是单文件 JSONL，轮转靠外部。

## 13. 写代理（2026-11-12）

客户端不再持有 GitHub write token。`repo_edit`、`pr_create`、`pr_close`、
`pr_merge` 由 broker 用内存里的 write token 代执行，broker 是唯一能写仓库的进程。

### 端点

| 方法与路径 | operation | 说明 |
|---|---|---|
| `POST /v1/write/repo_edit` | `race-ops.repo_edit` | 用 Git Data API 建 blob/tree/commit/ref |
| `POST /v1/write/pr_create` | `race-ops.pr_create` | 创建 PR；同 head 的 open PR 直接复用 |
| `POST /v1/write/pr_close` | `race-ops.pr_close` | 关闭 PR；已关闭/已合并返回 `already: true` |
| `POST /v1/write/pr_merge/approval` | `race-ops.pr_merge` | 取一次性 approval，不合并 |
| `POST /v1/write/pr_merge` | `race-ops.pr_merge` | 消费 approval 并合并 |

### 凭据与授权

- 飞书：`X-MMW-Feishu-Token: <pluginToken>`；GitHub：`Authorization: Bearer
  <sessionToken>`。凭据只从 header 读，body 里的同名字段被忽略。
- 飞书每次调用都重新取 `/v1/agent/routes`，缺对应 operation 返回
  `feishu-operation-denied`（403），不依赖上一次 mint 的 scope。
- GitHub session 走 `#sessionFor` + `#checkAllowlist`；组织成员/白名单用户被视为
  可信写者，不再区分读/写角色。
- `BROKER_WRITE_ENABLED` 不是 `true` 时所有 `/v1/write/*` 返回
  `write-disabled`（503）。没有凭据返回 `write-credential-required`（401）。
- write token 由 broker 以 `contents: write` + `pull_requests: write` mint，
  缓存 60 秒；它只存在于 broker 内存，响应里不出现。

### `repo_edit`

请求：

```json
{
  "branch": "content/foo",
  "base_sha": "<40 hex>",
  "message": "…",
  "edits": [
    { "path": "src/a.txt", "content": "…" },
    { "path": "src/b.txt", "delete": true }
  ],
  "idempotency_key": "optional"
}
```

- `branch` 必须以 `BROKER_BRANCH_PREFIX` 开头；`base_sha` 必须等于该分支当前
  head（分支不存在时等于 base 分支 head），否则 `base-sha-mismatch`（409）。
- 路径经 `normalizeRepoPath` 规范化；必须命中 `BROKER_ALLOWLIST_PATHS`，命中
  `BROKER_DENYLIST_PATHS` 即拒绝（deny 优先）。
- 最多 50 条编辑、单文件 1 MiB、总计 4 MiB；`replace` 必须恰好匹配一次，
  `insert` 追加，`patch` 不支持。
- 内容校验（preflight/测试）仍由 CI 负责；broker 只做结构、路径与并发检查。
- 成功返回 `{branch, base_sha, new_commit_sha, files_changed, idempotent}`。

### `pr_create`

请求 `{head, base, title, body, draft}`。`head` 必须已存在且以分支前缀开头；
`base` 必须等于 `BROKER_BASE_BRANCH`；`draft` 默认 `true`。broker 先查同 head
的 open PR，有则复用，没有才创建。成功返回 `{number, url, head_sha, draft}`。

### `pr_close`

请求 `{pr_number}`。broker 先 `GET /pulls/{n}`：不存在返回 `pr-not-found`（404）；
已经不是 open（包括已合并）时直接返回 `{closed: true, already: true, merged}`，
不重复调用 GitHub。只有 head 以 `BROKER_BRANCH_PREFIX` 开头、base 等于
`BROKER_BASE_BRANCH` 的 open PR 才会被 `PATCH state: closed`。关闭不合并，也
不会删除分支；成功返回 `{number, closed: true, already: false, head_sha, url}`。
宿主在执行前仍会弹出一次确认。

### `pr_merge`

1. `POST /v1/write/pr_merge/approval` 传 `{pr_number, merge_method,
   commit_title}`。broker 读 PR，校验 open、base、分支前缀；draft 先
   `PATCH draft:false`；`mergeable_state` 必须为 `clean`（`unknown` 最多轮询
   5 次 × 2 秒）。通过后生成 32 字节 `approval_id`，绑定 member、PR、head SHA、
   method 与 title，5 分钟过期，仅一次有效。
2. 宿主向用户确认后，`POST /v1/write/pr_merge` 传 `{approval_id, pr_number,
   head_sha, merge_method, commit_title}`。broker 校验 approval 未过期、成员与
   PR 一致；重新读 PR，head SHA 必须仍等于 approval 里的值（否则
   `approval-stale`）；最后 `PUT /pulls/{n}/merge`。
3. approval 在发出 merge 请求前删除，重放不会二次合并。

### 幂等、审计与配置

- `Idempotency-Key` header 或请求里的 `idempotency_key` 都可用；缺省时按
  operation + body 派生。成功结果在内存保留 24 小时，重试返回
  `idempotent: true` 与原结果。
- 成功的写与 approval 追加到 `BROKER_AUDIT_LOG`（JSONL），字段含
  `requestId`、operation、结果码与 PR/commit 标识；不记 token、文件正文或
  commit message。
- 相关环境变量：`BROKER_WRITE_ENABLED`、`BROKER_ALLOWLIST_PATHS`、
  `BROKER_DENYLIST_PATHS`、`BROKER_BASE_BRANCH`、`BROKER_BRANCH_PREFIX`、
  `BROKER_AUDIT_LOG`。`/health` 报告 `writeEnabled`、`pendingApprovals` 与
  `idempotencyEntries`。

### 残留边界

- approval 绑定参数但不绑定“人真的点了确认”。能读 0600 写认证文件并直接发
  HTTP 的进程可以自调用 approval + merge；宿主确认只在工具调用路径上生效。
- 写 token 仍是仓库级 `contents/pull_requests: write`，没有按文件/PR 的 GitHub
  侧细粒度；broker 的路径与分支检查是唯一收窄点。
- 审计文件不自动轮转；生产上应交给 logrotate 或定期归档。
