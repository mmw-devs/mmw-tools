# mmw-tools-auth

飞书 H5 鉴权核心：成员、角色、插件 token，以及 `GET /v1/agent/routes` 授权表。
DSH 插件是消费者；它静态注册全部工具，并在每次调用时按这里下发的 `allowed` 集合放行或拒绝。

> 状态：Phase 1 MVP 已部署到 `https://mmw-tools.mmw-team.icu`；公网 `/health` 正常。
> 首位管理员已配置，bootstrap token 已移除；真实飞书插件登录待验证。
> 设计见 [`../mmw-tools-routing-layer-plan.md`](../mmw-tools-routing-layer-plan.md) 和
> [`../mmw-tools-routing-state-machine.md`](../mmw-tools-routing-state-machine.md)。
> 部署步骤见 [`deploy/README.md`](deploy/README.md)。

## 要求

- Node.js **24+**（使用 `node:sqlite`，运行时会有 ExperimentalWarning）。
- 无第三方运行依赖。

## 快速开始

```sh
cd mmw-tools-auth
cp .env.example .env
# 编辑 .env：FEISHU_APP_ID / SECRET / TENANT_KEY / MMW_ORIGIN / MMW_DATA_DIR
node --env-file=.env src/main.mjs
# -> http://127.0.0.1:4326
```

服务只监听 `127.0.0.1`；公网由 nginx 终止 TLS 后转发。

### 飞书应用

在飞书开放平台创建**企业自建网页应用**。后台里有两个容易混淆的地方：

1. **网页应用配置**里的「桌面端主页 / 移动端主页」是**应用入口页**，不是 OAuth 回调地址。它只接受 HTTPS，填：
   ```text
   https://<MMW_ORIGIN>/
   ```
   用户在飞书里打开这个应用时会落到这个页面；我们的服务根路径就是登录/管理页。

2. **OAuth 回调地址**在另一个地方，通常在 **开发配置 → 安全设置 → 重定向 URL**（不同版本菜单可能叫「OAuth 重定向 URL」或「回调地址」）。这里填：
   ```text
   https://<MMW_ORIGIN>/auth/feishu/callback
   ```
   必须与代码里的 `redirect_uri` 完全一致：不能带 query、不能多/少尾部斜杠。

| 后台位置 | 字段 | 填什么 |
|---|---|---|
| 应用功能 → 网页应用 | 桌面端主页 | `https://<MMW_ORIGIN>/` |
| 应用功能 → 网页应用 | 移动端主页 | `https://<MMW_ORIGIN>/` |
| 开发配置 → 安全设置 | 重定向 URL | `https://<MMW_ORIGIN>/auth/feishu/callback` |
| 应用凭证与基础信息 | App ID / App Secret | 写入 `.env`，secret 只放服务端 |
| 权限管理 | 身份 scope | 先留空；如果 `user_info` 被拒绝，再补最小身份 scope |
| 可用范围 | 组织/测试成员 | 先只放你自己或测试组 |

如果后台只让你填「桌面端/移动端主页」，说明你还在「网页应用」这个能力页，**继续找左侧的「安全设置」或「开发配置」**；回调地址不在主页那一栏。

`FEISHU_TENANT_KEY` 是允许登录的飞书组织标识，不是组织名称。登录时会强校验。

**本地开发也需要 HTTPS**：飞书不接受 `http://127.0.0.1` 作为回调。可以用临时 HTTPS 隧道（如 Cloudflare Tunnel / ngrok）把本机 `4326` 暴露出去，把 `MMW_ORIGIN` 改成隧道地址，并把回调 URL 注册成同一个地址。正式上线仍以 `https://mmw-tools.mmw-team.icu` 为准。

### 检查配置

在 `mmw-tools-auth/` 下：

```sh
node scripts/check-config.mjs
# 验证 App ID / App Secret 是否被飞书接受（不会打印 token）
node scripts/check-config.mjs --verify-feishu
```

输出会列出：

- App ID / Tenant Key / admin/bootstrap 是否存在（secret 只显示掩码）；
- 应该在飞书后台填的两个 URL：
  - 主页：`<MMW_ORIGIN>/`
  - 重定向 URL：`<MMW_ORIGIN>/auth/feishu/callback`
- 契约目录与 `catalogRevision`；
- `--verify-feishu` 时调用 `app_access_token` 端点，只打印成功/失败码。

如果服务已经部署，再检查公网健康端点：

```sh
curl https://<MMW_ORIGIN>/health
```

### 部署检查

子域名上线需要三件事同时成立：

1. **DNS**：`mmw-tools.mmw-team.icu` 有 A 记录指向服务器（现有主域名/`race-ops-broker` 都是 `106.54.44.57`）。
2. **nginx**：有 `server_name mmw-tools.mmw-team.icu;` 的 server block，并把 `/` 代理到 `127.0.0.1:4326`。
3. **证书**：证书 SAN 包含 `mmw-tools.mmw-team.icu`；否则 TLS 会报 `SEC_E_WRONG_PRINCIPAL`，或者请求落到默认站点。

验证时不要只看“有没有 200”，要看返回体：

```text
{"ok":true,"contractVersion":2,"catalogRevision":"sha256:..."}   # 这是 auth core
{"status":"ok"}                                                  # 这是另一个站点
```

如果 `/auth/feishu/start` 的跳转里出现 `client_id=cli_...` 但不是你的 App ID，说明请求没有到 auth core，而是落到了主站。

完整的 DNS / systemd / 证书 / nginx / bootstrap 步骤见
[`deploy/README.md`](deploy/README.md)。

不知道 `FEISHU_TENANT_KEY` 时，可以用应用凭证查：

```sh
node scripts/fetch-tenant-key.mjs
```

它会调用 `tenant_access_token` + `tenant/v2/tenant/query`，只打印
`tenant_key` 和企业名称，不打印 token。如果返回 `99991672`，说明应用缺少
`tenant:tenant:readonly`；可以临时开通该只读权限，或直接从飞书管理后台的企业信息里取 `tenant_key`。

### 首位管理员（bootstrap）

不知道自己的 `open_id` 时，用一次性 bootstrap token：

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
# 写入 .env: MMW_BOOTSTRAP_TOKEN=<输出>
```

启动服务后，用你的飞书账号访问：

```text
https://<MMW_ORIGIN>/auth/feishu/start?bootstrap=<MMW_BOOTSTRAP_TOKEN>
```

**必须打开这个带 `bootstrap` 的 URL**；从 `/` 页面点普通「使用飞书登录」不会
触发 bootstrap，只会创建一个没有角色的普通成员。

回调成功后你会成为首位管理员；bootstrap token 立即失效。之后从 `.env` 删除
`MMW_BOOTSTRAP_TOKEN` 并重启。也可以在 `.env` 里直接填 `MMW_ADMIN_OPEN_ID`，
首次登录即成为管理员，二选一。

### 契约

服务默认从 `../contracts` 读取：

- `tools.json`：工具、可消费角色、技术权限、operations/risk；
- `roles.json`：成员角色（不包含权限映射）。

部署到 `/opt/mmw-tools-auth` 时，把 `contracts/` 复制到服务目录，并设置：

```dotenv
MMW_CONTRACTS_DIR=/opt/mmw-tools-auth/contracts
```

契约校验：

```sh
cd ..
node scripts/check-contracts.mjs
```

## 端点

端点签名与状态码以 [`src/server.mjs`](src/server.mjs) 为准；下表只用于导航，不是契约。
返回体字段以 `src/` 中的响应构造函数为准，文档不复制 JSON 示例。

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查；返回契约版本与 `catalogRevision` |
| `POST` | `/v1/login/start` | 创建插件登录事务 |
| `GET` | `/auth/feishu/start` | 浏览器 OAuth 入口 |
| `GET` | `/auth/feishu/callback` | OAuth 回调 |
| `GET` | `/v1/login/:id` | 插件轮询登录结果 |
| `GET` | `/v1/me` | 插件身份、角色与策略版本 |
| `POST` | `/v1/session/refresh` | 轮换插件 token |
| `POST` | `/v1/session/logout` | 撤销当前插件 token |
| `GET` | `/v1/agent/routes` | 授权表（allowed / denied / 版本 / TTL） |
| `POST` | `/v1/agent/events` | 执行侧审计事件 |
| `GET` | `/` | 管理 UI |
| `/api/admin/*` | 管理接口 | 角色、成员、审计；写请求需 CSRF |

## 状态与安全

- 插件 token 是 32 字节不透明随机值；服务端只存 `sha256(token)`，默认 7 天。
- 浏览器登录使用 `state` + browser cookie + PKCE；回调一次性消费。
- 管理 UI 的写请求校验 `Origin` + `X-CSRF-Token`；cookie 为 `HttpOnly; SameSite=Lax`。
- 停用成员会删除其全部 plugin token 和浏览器 session。
- 不能停用或降级最后一位有效管理员。
- 审计只记录 actor/action/target/时间；不记录 token、Feishu code、文件内容。

## 测试

```sh
node tests/run.mjs
```

测试用例的数量和名称以 `tests/` 为准，不在文档里维护计数。覆盖范围包括：

- 插件登录、身份、空角色、仅 status 的授权表；
- bootstrap 管理员、最后管理员保护；
- 角色变化、停用成员；
- 回调重放、换浏览器、错误 pollSecret、租户不符；
- token 刷新/撤销/过期；
- 事件审计、CSRF、未登录访问；
- 授权表与 `contracts/examples/` golden 文件一致。

测试使用 mock 飞书 `fetch`，不需要网络或真实飞书应用。

## 已知限制

- 真实飞书 OAuth 联调和浏览器手测尚未完成。
- SQLite 单进程；不支持多实例共享同一个库。
- 管理 UI 目前只编辑角色，不编辑工具目录；目录以 `contracts/` 为准。
- 没有 per-call 授权接口；插件缓存授权表，缓存上限由 `ttlSeconds` 和操作风险决定。
- systemd/nginx 目前是脚本 + 手工步骤（见 `deploy/`），还没有自动备份与回滚。
- `node:sqlite` 会打印 ExperimentalWarning；这是 Node 24 的预期行为。
