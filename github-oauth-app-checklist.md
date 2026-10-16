# GitHub OAuth App 注册 Checklist（dsh-github-engineer 用）

> 适用：OAuth Device Flow + 单一用户身份推 PR 到 `mmw-devs/ffxiv-race-ops`。
> 预计时间：5 分钟。
> 你需要的产物：`client_id`（写到 plugin manifest）。

---

## 步骤

### 1. 进入注册页

1. 打开 https://github.com/settings/developers
2. 右上角点 **"New OAuth App"**

### 2. 填表

| 字段 | 填什么 | 说明 |
|---|---|---|
| **Application name** | `dsh-github-engineer` | 显示名，可改 |
| **Homepage URL** | 你的插件 README URL（先用占位 `https://github.com/<your-name>/dsh-github-engineer`） | GitHub 强制要求 |
| **Application description** | `DeepSeek Harness plugin: connects to a single configured repo and operates AGENTS.md-constrained workflows.` | 可选 |
| **Authorization callback URL** | `http://127.0.0.1:3000/oauth/callback` | **占位即可**：Device Flow 不需要真的回调 URL；任何 loopback URL 都能让 GitHub 接受 |

点 **"Register application"**。

### 3. 拿到 `client_id`

注册成功后会跳转到 App 设置页，**最顶上**就是：

- **Client ID**：形如 `Iv1.1234567890abcdef`
- **Client secrets**：点 "Generate a new client secret" 拿到

### 4. 关键步骤：启用 Device Flow

在 App 设置页右侧或下方，找到 **"Device Flow"** 部分：

- 默认可能是关闭
- **必须勾选 "Enable Device Flow"**

> ⚠️ 这一步是 OAuth App + Device Flow 的核心。GitHub 标准 OAuth App 默认走 web redirect，Device Flow 是独立开关。

### 5. Scope 选择（提前想清楚）

v1 推荐 scope（写入 plugin manifest 默认值）：

- ✅ `repo`（必须）：创建/推送 `content/*` 分支、开 PR
- ✅ `offline_access`（强烈推荐）：拿 6 个月 refresh_token
- ◻ `workflow`（可选）：让 PR 触发 GitHub Actions
- ◻ `public_repo`（可选，仅 public 仓库版本）：范围更窄的替代

> **Scope 在 OAuth App 注册时设置的是默认值**。每次用户授权的具体 scope 由插件在 authorize URL 里 `scope=` 参数决定。
>
> plugin manifest 写：`defaultScopes: ["repo", "workflow", "offline_access"]`，授权时拼成空格分隔 `repo workflow offline_access`。

### 6. 写 plugin manifest

把 `client_id` 写进 plugin manifest（`src/manifest.ts` 或 `package.json` 的 `dsh.bundle` 节）：

```yaml
# cordis.patch.yml
- insert:
    - id: github-engineer
      name: dsh-github-engineer
      config:
        announceToAgent: true
        enabled: true
        githubOAuthClientId: "Iv1.<your-client-id>"   # ← 来自步骤 3
        defaultScopes:
          - repo
          - workflow
          - offline_access
```

`client_secret` **不写**——Device Flow 不需要。

### 7. 验证

#### 7.1 手动跑一遍 Device Flow（用 curl）

```bash
# 1. 申请 device_code
curl -X POST https://github.com/login/device/code \
  -H "Accept: application/json" \
  -d "client_id=Iv1.<your-client-id>&scope=repo+workflow+offline_access"

# 响应形如：
# {
#   "device_code": "...",
#   "user_code": "ABCD-1234",        ← 用户在 github.com/login/device 输这个
#   "verification_uri": "https://github.com/login/device",
#   "expires_in": 900,
#   "interval": 5
# }

# 2. 用户去 https://github.com/login/device 输 user_code + Authorize
# 3. 轮询 token（每 interval 秒一次，直到 expires_in）
curl -X POST https://github.com/login/oauth/access_token \
  -H "Accept: application/json" \
  -d "client_id=Iv1.<your-client-id>&device_code=<your-device-code>&grant_type=urn:ietf:params:oauth:grant-type:device_code"

# 响应：
# { "access_token": "gho_...", "token_type": "bearer", "scope": "repo,workflow,offline_access" }

# 4. 测试 token
curl -H "Authorization: Bearer gho_..." https://api.github.com/user
```

#### 7.2 确认权限足够

```bash
# 验证能 push 到 content/*
curl -H "Authorization: Bearer gho_..." \
  -X POST https://api.github.com/repos/mmw-devs/ffxiv-race-ops/pulls \
  -d '{"title":"smoke","body":"smoke","head":"content/smoke","base":"main"}'

# 应该返回 422（branch 不存在）而不是 403（权限不足）
# 422 = 你的 token 权限 OK
# 403 = token 没有 repo:write 权限
```

### 8. 安全注意

- `client_id` 是公开的——可以放心进 plugin manifest
- `client_secret`（如果你生成了）**绝不放**进 manifest，**绝不放**进仓库，**绝不提交** git
- 如果你不打算用 web redirect flow，可以忽略 client_secret（Device Flow 用不到）
- Device Flow 不需要 HTTPS redirect URL，因为用户是在浏览器里输 user_code 而不是跳转到你的服务
- 该 OAuth App 是**个人开发者 App**（不是 GitHub App），归你的 GitHub 账号所有，不会上架

### 9. 收尾

- [ ] `client_id` 已记录
- [ ] "Enable Device Flow" 已勾选
- [ ] `cordis.patch.yml` 里的 `githubOAuthClientId` 已替换为真实值
- [ ] （可选）已把 secret 存到本地密码管理器，**不存仓库**

---

## 10. 常见坑

| 坑 | 解决 |
|---|---|
| 注册时填的 callback URL 不接受 `http://` | callback URL 必须 `http://127.0.0.1:xxx` 或 `https://`，不能用公网 HTTP |
| 勾不到 "Enable Device Flow" | 该 App 可能不是 OAuth App 而是 GitHub App——重新注册 OAuth App |
| Device Flow 拿不到 `refresh_token` | scope 里必须有 `offline_access` |
| 用户拒绝授权 | Device Flow 立刻返回 `access_denied`，plugin 落到 `no_token` |
| App 撤销 token 后再次调用 | 401 → plugin refresh 失败 → `reauth_needed` 红条 |
| 多人共用 OAuth App | 可以：每个用户独立 authorize 一次；plugin 把 token 存到自己的 `~/.dsh/dsh-github-engineer.json`，互不干扰 |

---

## 11. v1 不需要做的事

- ✗ 不需要注册 GitHub App
- ✗ 不需要 private key
- ✗ 不需要 webhook
- ✗ 不需要 marketplace listing
- ✗ 不需要 callback URL 真的可用（占位就行）