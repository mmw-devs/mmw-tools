# AUTH-BROKER — GitHub App + token broker

Status: design agreed (topology B). Not yet implemented.
Supersedes the Device Flow design in `OAUTH-FLOW.md` for repo access.
Device Flow is not deleted: it is re-scoped to *identity only* (see §3).

---

## 1. 目标

让若干使用者能用**自己的 GitHub 账号**登录，然后**以 bot 身份**操作
`mmw-devs/ffxiv-race-ops`。使用者不需要是该仓库的协作者，也不需要
`repo` scope；仓库的写权限只由一次性的 App 安装提供。

three properties that matter:

1. **写入身份是 bot**，不是使用者。PR 作者是 `race-ops-bot[bot]`。
2. **user 与 repo 权限解耦**。使用者登录只证明"他是谁"，不产生任何仓库权限。
3. **撤销是单点的**。从允许名单移除某人，或卸载 App，立即生效；不需要
   逐个仓库改权限。

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

## 3. 三个身份层次

| 层 | 证明什么 | 凭据 | 存放 | 有效期 |
|---|---|---|---|---|
| 使用者身份 | 你是 mmw-devs 成员 / 在白名单里 | GitHub user token（只用于 `/user`、`/user/memberships/...`，不落盘） | broker 内存 | 用户名 + 校验结果缓存 10 分钟 |
| 插件会话 | 这个插件实例已被 broker 认可 | session token（32 字节随机，sha256 存库） | 插件本机 0600 | 12 小时 |
| 仓库写入 | App 被安装在仓库上且具备权限 | installation token | 插件本机内存（可选缓存 ≤ 50 分钟） | 1 小时 |

关键性质：**session token 不能直接写仓库**。它只能向 broker 换一个 1 小时的
installation token，而 broker 每次都会重新检查该 session 仍然有效且使用者
仍在允许名单里。踢人不需要等 token 过期。

## 4. GitHub App 注册清单

在 `mmw-devs` 组织下注册（`Settings → Developer settings → GitHub Apps → New`）。

| 字段 | 值 | 备注 |
|---|---|---|
| Name | `race-ops-bot` | 会显示为 `race-ops-bot[bot]` |
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
{ "ok": true, "appId": 123456, "org": "mmw-devs", "allowlistSize": 3 }
```

不返回任何密钥。

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

### `GET /session/{state}?secret=<pollSecret>`

插件轮询。

- `{"status":"pending"}`
- `{"status":"denied","reason":"not-a-member"}`
- `{"status":"expired"}`
- `{"status":"authorized","sessionToken":"...","login":"...","expiresAt":...}`

`sessionToken` 只在这里返回一次。

### `POST /installation-token`

```
Authorization: Bearer <sessionToken>
```

响应：

```json
{
  "token": "ghs_...",
  "expiresAt": 1780000000000,
  "repository": "mmw-devs/ffxiv-race-ops",
  "permissions": { "contents": "write", "pull_requests": "write" }
}
```

流程：校验 session（未过期、未撤销）→ **重新确认使用者仍在允许名单**
（缓存 10 分钟）→ 私钥签 JWT（`iat=now-60s`, `exp=now+540s`）→
`POST /app/installations/{id}/access_tokens` → 返回 token。

### `POST /session/revoke`

```
Authorization: Bearer <sessionToken>
```

立即删除 session。插件侧的「Revoke」按钮调用它。

## 6. 允许名单

两种模式，配置里二选一（`BROKER_ALLOW_MODE`）：

| 模式 | 规则 | 校验调用 |
|---|---|---|
| `org`（默认） | 必须是 `mmw-devs` 的 active 成员 | `GET /user/memberships/orgs/mmw-devs`，要求 `state === "active"` |
| `list` | 用户名命中 `BROKER_ALLOWED_USERS`（逗号分隔） | 无额外调用 |

`org` 模式更好：权限管理留在 GitHub 组织里，不用维护第二份名单。

**2026-10-27 已切换到 `org` 模式并验证通过。** 前提是给 App 加上
`Organization → Members: Read-only`，并且**在安装上接受新权限**（只改 App 权限
不重新批准安装，用户 token 依然拿不到该权限，表现为 `allowlist-check-failed`）。
切换后的实测日志：

```
session_start      -> session_authorized login=weunimix
                   -> installation_token_issued
/health            -> allowMode: org, activeSessions: 1
```

`BROKER_ALLOWED_USERS` 现在为空且不再参与判断；保留它是为了随时能用
`BROKER_ALLOW_MODE=list` 回退。
`list` 模式用于临时给外部人员开个口子。

无论哪种模式，`BROKER_DENIED_USERS` 里的用户名一律拒绝（应急拉黑）。

## 7. 威胁模型

| 威胁 | 缓解 |
|---|---|
| 插件机器被入侵 | 只有 12 小时 session + 1 小时 installation token；`/session/revoke` 立即失效；私钥不在本机 |
| 浏览器 URL 泄漏（历史记录、截图） | `state` ≠ `pollSecret`，只泄漏 `state` 拿不到 session |
| 回调被重放 | `state` 一次性，用后即焚；5 分钟未回调则过期 |
| 允许名单里的账号被盗 | installation token 只有 Contents+PR 写，且只限一个仓库；GitHub 侧审计可见 bot 操作时间线 |
| 私钥泄漏 | 只能重签：GitHub App 删旧 key、生成新 key、重启 broker；已发 installation token 自然 1 小时内过期 |
| broker 被 DDoS | 每 IP 每分钟 60 次、每 state 轮询 1 次/2 秒；超限 429 |
| 日志泄漏 | 只记 `login`、`state` 前 8 位、结果码；token 一律不进日志（复用 `redactTokens`） |
| 中间人 | 强制 HTTPS，HSTS；broker 只监听 127.0.0.1，由 Caddy/nginx 终止 TLS |

**明确不防的**：拿到 installation token 的人可以在 1 小时内任意写仓库
（这正是它的用途）。所以 token 不落盘，只在内存里，用完即弃。

## 8. 插件侧改动

新增：

- `src/auth/broker-client.ts` — `startSession()`, `pollSession()`, `getInstallationToken()`, `revoke()`
- `src/auth/installation-token-cache.ts` — 内存缓存，提前 10 分钟刷新

修改：

- `config.authMode: "broker" | "device"`，默认 `broker`
- `routes.ts` — `/oauth/*` 保留给 `device` 模式；新增 `/broker/*` 面板动作
- `src/client/index.js` — 面板按钮文案按模式切换（「Sign in via broker」）
- `TokenStore` — broker 模式下只存 `sessionToken` + `expiresAt`，**不存** installation token
- `engineer_status` — 显示 `authMode`、`login`、session 剩余时间、installation token 是否已缓存

**不变**：`mcp-server/src/guard.ts` 全套、`repo_edit` 状态机、
`allowlist/denylist/branchPrefix/preflight/bootstrap`、审计日志、脱敏。
认证方式与这些正交，这是现有 10 个守卫能直接复用的原因。

## 9. 部署（腾讯云）

前置：一个域名 + HTTPS 证书（Caddy 自动签发最省事）。GitHub 的
callback URL 必须是 HTTPS，所以没有证书这条路走不通。

```
/opt/dsh-race-ops-broker/
  app.pem            # 0400, owner=service user
  .env               # 0400
  broker.mjs
```

`.env`：

```
BROKER_PUBLIC_URL=https://race-ops-broker.mmw-team.icu
GITHUB_APP_ID=123456
GITHUB_APP_CLIENT_ID=Iv1...
GITHUB_APP_CLIENT_SECRET=...
GITHUB_APP_INSTALLATION_ID=...
GITHUB_APP_PRIVATE_KEY_PATH=/opt/dsh-race-ops-broker/app.pem
BROKER_ORG=mmw-devs
BROKER_ALLOW_MODE=org
BROKER_ALLOWED_USERS=
BROKER_DENIED_USERS=
PORT=8787
```

systemd（只监听回环，TLS 由 Caddy 终止）：

```ini
[Unit]
Description=dsh race-ops broker
After=network.target

[Service]
WorkingDirectory=/opt/dsh-race-ops-broker
ExecStart=/usr/bin/node broker.mjs
Restart=always
EnvironmentFile=/opt/dsh-race-ops-broker/.env
User=broker
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

## 11. 未决

1. **域名与证书**：broker 用哪个域名？DNS 能指到腾讯云吗？（callback URL 必须是
   HTTPS，这一步没完成 8d 无法进行）
2. **允许名单模式**：`org`（mmw-devs 成员）还是 `list`（手写用户名）？
3. **App 归属**：注册在 `mmw-devs` 组织下，还是你的个人账号下？组织下更规范，
   但需要你是组织 owner。
