# 架构与业务逻辑设计案 v2 · `dsh-mmw-tools`

> 状态：方案 B（OAuth Device Flow）+ MCP server + DSH bundle。
> 目标客户仓库：`mmw-devs/ffxiv-race-ops`（以及任何符合同样规约的"运营型单仓"）。
> **与 v1 的差异**：v1 把插件当作通用"DSH 工程师"来设计，过度引入 GitHub App 凭证、领域 skill 包装、双凭证切换。这些在 v2 里**全部删除**——因为：
> - `race-ops-bot` GitHub App 是旧服务器部署模式的产物，新方案下不需要。
> - 领域 skill（`update-team`/`add-news`/`add-broadcaster`）是旧 PI Agent 的封装，新方案靠 LLM + `AGENTS.md` 直接编排。
> - 飞书 IM 入口不在 v1 范围。
>
> v2 收敛到：**OAuth Device Flow + 通用 MCP 工具 + 严格遵守客户仓库 `AGENTS.md` 规约 + 本地 pre-flight 校验**。

---

## 1. 真实需求（重新对焦后）

> 开发一个 DSH 插件 `dsh-mmw-tools`，让用户的 DSH 接入个人 GitHub 身份后，**能够在 `mmw-devs/ffxiv-race-ops` 这类"有 AGENTS.md 规约 + 限定修改文件 + 限定 PR 通道"的运营仓库上**，完成"读 AGENTS.md → 按规约改 → 本地校验 → 推 PR"的完整工作流。**默认不合并 PR**——CI 校验 + 运营人员最终 review 必须在 GitHub 上完成。

业务约束（来自客户仓库 `ffxiv-race-ops/AGENTS.md` 与 `README.md`）：

- **唯一允许修改的文件**：`public/data.json`
- **唯一允许的 PR 通道**：`content/*` 分支前缀，**绝不可直推 main**
- **CI 校验**：三阶段 `scripts/validate-data.ts`（schema / 值域交叉 / 业务规则）
- **本地预检**：`npm run validate` 必须通过
- **凭证**：用户个人 OAuth Device Flow（开发者身份）；`race-ops-bot` GitHub App 不在新方案中实现
- **文档规范**：默认飞书云文档（`lark-cli docs +create` / `+update`），非本地 docs/——**这部分不归本插件管**，由用户/agent 自行调用 `lark-cli`
- **注释语言**：中文

DSH 插件自身的目标：

1. **让 DSH agent 能直接动这个仓库**，而不需要绕道 `.pi/` 流程
2. **硬护栏**：禁止改 `public/data.json` 之外的文件、禁止非 `content/*` 前缀、禁止直推 main
3. **强制读取 `AGENTS.md`** 并把它作为 LLM 的 source of truth
4. **强制本地 pre-flight `npm run validate`**，失败拒绝 push
5. **不引入新的凭证模型**（不实现 GitHub App）

---

## 2. 一图概览

```
┌─────────────────────────────────────────────────────────────────────┐
│  DSH host (e.g. `dsh web`)                                           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  dsh-mmw-tools (bundle, cordis patch)                    │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────┐    │  │
│  │  │  AuthService (OAuth Device Flow)                     │    │  │
│  │  │  - GHOST_OAUTH_CLIENT_ID (manifest 固定)            │    │  │
│  │  │  - access/refresh token, login, scopes               │    │  │
│  │  │  - keychain 优先 / DSH storage 加密 备份              │    │  │
│  │  └──────────────────────────────────────────────────────┘    │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────┐    │  │
│  │  │  RepoBindingService                                   │    │  │
│  │  │  - 单一绑定仓库：owner=mmw-devs, name=ffxiv-race-ops │    │  │
│  │  │  - base_branch=main, branch_prefix=content/          │    │  │
│  │  │  - allowlist_files=[public/data.json]                │    │  │
│  │  │  - working_dir=~/.dsh/profiles/<state>/workspaces/   │    │  │
│  │  │       mmw-devs/ffxiv-race-ops                         │    │  │
│  │  │  - preflight_cmd="npm run validate"                  │    │  │
│  │  └──────────────────────────────────────────────────────┘    │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────┐    │  │
│  │  │  McpHost                                               │    │  │
│  │  │  - spawn MCP server (stdio)                          │    │  │
│  │  │  - 注入 env: GHOST_TOKEN, REPO_OWNER, REPO_NAME, …    │    │  │
│  │  └──────────────────────────────────────────────────────┘    │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────┐    │  │
│  │  │  AgentTools (高层包装)                                │    │  │
│  │  │  - mmw_tools_status                                    │    │  │
│  │  │  - engineer_config                                    │    │  │
│  │  │  - mmw_tools_run    ← 读 AGENTS.md + LLM loop + PR     │    │  │
│  │  └──────────────────────────────────────────────────────┘    │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────┐    │  │
│  │  │  UI: Settings → MMW Tools                         │    │  │
│  │  │  - [Connect GitHub] / Connected as / Token expires     │    │  │
│  │  │  - Repo: mmw-devs/ffxiv-race-ops (只读)                 │    │  │
│  │  │  - Branch prefix: content/                             │    │  │
│  │  │  - Allowlist files: public/data.json                    │    │  │
│  │  │  - Preflight cmd: npm run validate                       │    │  │
│  │  │  - Working dir: ...                                    │    │  │
│  │  └──────────────────────────────────────────────────────┘    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  MCP server (child process, stdio)                              │  │
│  │  Tools: repo_status · repo_clone · repo_pull · repo_read       │  │
│  │         repo_search · repo_edit · pr_create · pr_list         │  │
│  │  ⚠️ 不暴露 `pr_merge`（合并由 GitHub 上人工完成，CI 必经）        │  │
│  └──────────────────────────────────────────────────────────────┘  │
│           │                                                       │
└───────────┼─────────────────────────────────────────────────────────┘
            ▼
   ┌──────────────────────────────────┐
   │  本机文件系统                     │
   │  working_dir/<owner>/<repo>      │
   │  - 通过 git push 到 content/*      │
   │  - npm run validate (pre-flight) │
   │  - 通过 Octokit 创建 PR            │
   └──────────────────────────────────┘
            │
            ▼
   ┌──────────────────────────────┐
   │  api.github.com             │
   │  - GET /user (auth whoami) │
   │  - POST /repos/.../pulls    │
   └──────────────────────────────┘
```

---

## 3. 鉴权：OAuth Device Flow（个人身份）

完整状态机参考 v1 设计文档 §3，本版本**删除 GitHub App 模式**。要点：

### 3.1 一次性注册（你手动操作）

- 在 GitHub `Settings → Developer settings → OAuth Apps → New OAuth App` 注册
- Application name: `dsh-mmw-tools`
- Authorization callback URL: 占位（Device Flow 不用）
- 勾选 **Enable Device Flow**
- 拿 `client_id` —— 写进 bundle manifest

### 3.2 Scope 选择

- `repo`（必须）：推 `content/*` 分支、开 PR
- `workflow`（可选）：让 PR 触发 Actions
- `public_repo`（可选，给小白用户的轻量模式）：如果只动 public 仓库且不需要 private 访问
- `offline_access`（推荐）：拿 6 个月 refresh_token

`race-ops-bot` GitHub App、classic PAT、Org-level token **不在 v1 实现**。

### 3.3 Token 存储

- 优先：OS keychain（`@napi-rs/keyring`）
- 回退：DSH storage 加密文件（chmod 600，XChaCha20）
- **永不**写到：dotfile、PR body、commit message、日志、错误 trace、Session log

### 3.4 Refresh

- access_token 8h 过期 → 前 5 分钟主动 refresh
- 401/403 → 被动 refresh 一次，失败 → `reauth_needed`
- refresh_token 6 个月过期 → 重新走 Device Flow

---

## 4. 仓库绑定模型（单仓库固定）

```
profile.storages[dsh-mmw-tools]:
  binding:
    owner: mmw-devs
    name:  ffxiv-race-ops
    base_branch: main
    branch_prefix: content/
    allowlist_files:
        - public/data.json
    denylist_paths:
        - .github/workflows/**
        - schema/**
        - scripts/**
        - constants.js
        - AGENTS.md
        - README.md
        - .pi/**
        - dist/**
    working_dir: <dsh-profile>/workspaces/mmw-devs/ffxiv-race-ops
    preflight:
        enabled: true
        cmd: npm run validate
        timeout_seconds: 60
    pr:
        default_draft: true
        title_prefix: "[ops]"
        body_template: .github/PR_BODY.md    # 可选
```

### 4.1 关键约束（硬护栏）

| 路径类型 | 行为 |
|---|---|
| `public/data.json` | 允许修改 |
| `git diff` 中**新增或修改**其他路径 | 拒绝 push，返回详细错误（"AGENTS.md 只允许修改 public/data.json"） |
| 删除 `AGENTS.md`、`README.md`、`constants.js`、`scripts/**`、`schema/**`、`workflows/`、`dist/**` | 一律拒绝 |
| Push 到 `main` / `master` 或非 `content/*` 分支 | 一律拒绝 |
| Push 到已被保护分支 | 一律拒绝 |

这套约束写进 `RepoBindingService`，**MCP server 也要再次校验**——双层防御。

### 4.2 仓库清单（v1）

只绑定 `mmw-devs/ffxiv-race-ops`。如果将来想加 `mmw-devs/ffxiv-race-stats`（dev 仓库）或其他，**那是 v2 的事**——因为 dev 仓库的"修改规则"不一样（动 src/、schema/），会需要一套新的 allowlist/denylist。

---

## 5. DSH bundle 内部模块

### 5.1 `AuthService`（cordis service）

责任：
- 启动 OAuth Device Flow、轮询 token、持久化
- 主动 / 被动 refresh
- 撤销

接口：
```ts
interface AuthService {
  status(): 'no_token' | 'device_pending' | 'authorized' | 'reauth_needed';
  startDeviceFlow(): Promise<{ user_code; verification_uri; interval; expires_at }>;
  completeDeviceFlow(opts): Promise<{ access_token; refresh_token; expires_in; refresh_expires_in; login; scopes }>;
  refresh(): Promise<void>;
  revoke(): Promise<void>;
  getAccessToken(): Promise<string>;
  whoami(): Promise<{ login; name; avatar_url }>;
}
```

### 5.2 `RepoBindingService`（cordis service）

责任：
- 持久化仓库绑定（owner/name、分支前缀、allowlist/denylist、preflight cmd）
- 解析 working dir 路径
- `validateChangeSet(files: string[])`：根据 allowlist/denylist 决定是否可 push
- `enforceBranch(branch: string)`：必须是 `content/*` 前缀且非 base_branch

### 5.3 `McpHost`（cordis service）

责任：
- spawn MCP server 子进程（stdio）
- 注入 env：`GHOST_TOKEN`、`REPO_OWNER`、`REPO_NAME`、`BASE_BRANCH`、`BRANCH_PREFIX`、`WORKING_DIR`、`ALLOWLIST`、`DENYLIST`、`PREFLIGHT_CMD`
- MCP 进程健康监控、自动重启
- token refresh 后通知 MCP 进程（`notifications/initialized`）

### 5.4 `AgentTools`（cordis service）

注册 3 个**高层**工具：

| Tool | 用途 |
|---|---|
| `mmw_tools_status` | 检查 token / repo / working_dir / 分支预检是否就绪 |
| `engineer_config` | 修改绑定（仅本地 stash，不调 GitHub）：分支前缀、allowlist、preflight cmd |
| `mmw_tools_run` | **高层包装**：传用户诉求 → 拉仓库 → 读 AGENTS.md → LLM loop → 本地 validate → 推 content/* 分支 → 开 PR |

### 5.5 UI: `Settings → MMW Tools`

- `[Connect GitHub]` / `[Reconnect]` 按钮（Device Flow）
- 登录信息卡片：login、头像、token expires
- 仓库绑定卡片：只读展示当前绑定（owner/name/base/prefix/allowlist/preflight）；`[Edit]` 按钮修改本地配置
- Working dir：`[Open in Explorer]`
- 日志折叠区：每次 `mmw_tools_run` 的 summary（不含 PR body 全文、不含 commit 全文）

---

## 6. MCP server 设计

### 6.1 进程模型

```
DSH bundle ──spawn──> node ./mcp-server/dist/index.js
                  │
                  │ stdio (JSON-RPC, newline-delimited JSON)
                  │
                  ├─ initialize
                  ├─ tools/list 返回 7 个工具
                  ├─ tools/call { name, args }
                  └─ on token 失效 → MCP error: auth_required
```

环境变量（spawn 时注入）：
```
GHOST_TOKEN=<短期 token>
REPO_OWNER=mmw-devs
REPO_NAME=ffxiv-race-ops
BASE_BRANCH=main
BRANCH_PREFIX=content/
WORKING_DIR=<profile>/workspaces/mmw-devs/ffxiv-race-ops
ALLOWLIST_PATHS=public/data.json
DENYLIST_PATHS=.github/workflows/**,schema/**,scripts/**,constants.js,AGENTS.md,README.md,.pi/**,dist/**
PREFLIGHT_CMD=npm run validate
PREFLIGHT_TIMEOUT=60
```

### 6.2 工具集（7 个，无 `pr_merge`）

| Tool | 输入 | 输出 | 底层 |
|---|---|---|---|
| `repo_status` | — | `{cloned, current_branch, dirty, last_commit_sha, allowlist_files, denylist_files}` | `git status --porcelain` |
| `repo_clone` | `{force?: boolean}` | `{cloned_to, branch}` | `simple-git clone` |
| `repo_pull` | `{branch?: string, rebase?: boolean}` | `{fast_forwarded, conflicts?}` | `simple-git pull --rebase` |
| `repo_read` | `{path, max_bytes?}` | `{content, sha, truncated, byte_size}` | 文件读 + 字节限制 |
| `repo_search` | `{query, glob?, max_results?}` | `[{path, line, snippet}]` | `git grep` / `rg` |
| `repo_edit` | `{branch, edits: [{path, mode, find?, replace?, content?}], commit_message}` | `{branch, new_commit_sha, files_changed, preflight: {ran, exit_code, stdout, stderr}}` | 文件写 + pre-flight `npm run validate` + `git add/commit` |
| `pr_create` | `{head_branch, title, body, draft?, base?}` | `{number, url, head_sha}` | Octokit `POST /repos/.../pulls` |

### 6.3 ⚠️ 为什么没有 `pr_merge`

按 `ffxiv-race-ops/AGENTS.md` 的部署流程：

```
content/* 分支 → PR → CI 校验 → Review/合并 → main → CF Pages 自动部署
```

CI 校验和 Review 是合并前必经环节。**让 agent 自己合并 = 跳过 CI + Review = 违反规约**。所以 v1 不暴露 `pr_merge` 工具。合并必须人工在 GitHub 上完成。

### 6.4 关键约束（实现到 MCP server）

**仓库隔离**：
- `repo_edit.path` 必须相对仓库根，不允许 `..` 或绝对路径
- 路径必须在 `ALLOWLIST_PATHS` 内

**commit message 模板**：
```
<PR_TITLE_PREFIX> <branch>: <message>

🤖 由 dsh-mmw-tools 生成
```
**禁止**在 message 中包含 token、Authorization 头、user_access_token 字样。

**PR body 模板**（参考 ffxiv-race-ops 习惯）：
```markdown
## 摘要
<LLM 生成的 5 行总结>

## AGENTS.md 要求
<被显式引用的 AGENTS.md 节选>

## 验证
- [x] 本地 `npm run validate` 通过

🤖 由 dsh-mmw-tools 生成
```

**size 限制**：
- 单次 `repo_read` ≤ 100 KiB
- 单次 `pr_create` body ≤ 65 KiB
- 单次 commit 文件数 ≤ 5（因为只许改 `public/data.json`，改多了也是越权信号）

---

## 7. 高层包装：`mmw_tools_run` 业务逻辑

### 7.1 输入

```ts
interface EngineerRunInput {
  user_request: string;        // 用户的自然语言诉求
  branch_name?: string;        // 默认 `content/<timestamp>-<short-slug>`
  draft?: boolean;             // 默认 true
}
```

### 7.2 流程

```
                ┌───────────────────────────────┐
                │  mmw_tools_run(user_request)     │
                └──────────────┬─────────────────┘
                               │
   ┌───────────────────────────┼────────────────────────────┐
   │  1. 状态前置检查                                       │
   │  - token status == authorized                          │
   │  - working_dir 存在 (否则 repo_clone)                   │
   │  - 干净 working tree (no uncommitted changes)           │
   │  - 当前分支 != base_branch                            │
   │  - 目标分支名以 content/ 开头                          │
   └──────────────┬───────────────────────────┘
                  │ ok
                  ▼
   ┌──────────────────────────────────────┐
   │  2. 拉仓库 / 切分支                  │
   │  - if not cloned → repo_clone         │
   │  - 切到新 branch_name (从 base_branch) │
   │  - git pull --rebase (如有 upstream)  │
   └──────────────┬───────────────────────┘
                  ▼
   ┌──────────────────────────────────────┐
   │  3. 读上下文                          │
   │     - AGENTS.md (强制)                │
   │     - README.md (辅助)               │
   │     - repo tree (辅助)                    │
   │     - schema/* (如果路径在 allowlist) │
   └──────────────┬───────────────────────┘
                  ▼
   ┌──────────────────────────────────────┐
   │  4. LLM loop (≤ 30 step)              │
   │     - 工具: repo_read / repo_search / repo_edit │
   │     - repo_edit 强约束：             │
   │         · 每个 edit 的 path 必须在 allowlist │
   │         · 累计变更必须全部在 allowlist │
   │         · 文件数 ≤ 5                │
   │     - LLM 直到返回 "{ack}" 或步骤耗尽 │
   └──────────────┬───────────────────────┘
                  ▼
   ┌──────────────────────────────────────┐
   │  5. 强 pre-flight                    │
   │  - cd working_dir && npm run validate │
   │  - 失败 → 把 stderr 回给 LLM          │
   │  - 成功 → 继续                       │
   │  ⚠️ 这个步骤与 repo_edit 内部 pre-flight 双重防御 │
   └──────────────┬───────────────────────┘
                  ▼
   ┌──────────────────────────────────────┐
   │  6. push + 开 PR                     │
   │  - git push origin <branch>          │
   │  - pr_create (默认 draft)           │
   │  - PR body 模板填充                   │
   └──────────────┬───────────────────────┘
                  ▼
   ┌──────────────────────────────────────┐
   │  7. 返回结果                          │
   │  - PR_url, PR_number                  │
   │  - 变更摘要 (LLM 生成 5 行)          │
   │  - pre-flight 输出（成功/失败）       │
   │  - 若 pre-flight 失败：明确告诉用户  │
   │    "未 push，未开 PR，需手动修正"   │
   └──────────────────────────────────────┘
```

### 7.3 不做的事

- **不自动 merge**——MCP 没有 `pr_merge` 工具
- **不动 base_branch**
- **不改 AGENTS.md / README.md / schema / scripts / workflows / dist**
- **不在 PR body / commit message 里出现 token**

### 7.4 AGENTS.md 必读

- 启动第一步必须读 `AGENTS.md` 全文（max 100 KiB，超出截断并提示）
- 把它作为 LLM system prompt 的强制注入段
- 如果 `AGENTS.md` 不存在（理论上不该发生），`mmw_tools_run` 拒绝执行并提示用户

---

## 8. SKILL.md（仓库内引导）

这个 SKILL.md **不放在插件仓库**，而是由 `ffxiv-race-ops` 仓库自己提供（或插件在 `mmw_tools_run` 时自动把 AGENTS.md 内容暴露成 SKILL.md）。这避免了"插件的 SKILL 跟仓库 AGENTS.md 不一致"。

但插件自己仍需一个 **插件级 SKILL.md** 引导 agent 知道有这套工具：

```markdown
# MMW Tools Skill

You are a GitHub repository engineer using `dsh-mmw-tools`.

## Tools

Two layers:

1. **MCP tools** (`mcp__github_engineer__*`): 7 tools.
2. **High-level wrapper** (`mmw_tools_run`): one tool that runs the full pipeline.

## Typical workflow

For most user requests, prefer `mmw_tools_run`:

```
mmw_tools_run({
  user_request: "<the user's natural-language ask>",
  branch_name: "content/<short-slug>",   // default: content/<ts>-<slug>
  draft: true,                            // default: open as draft
})
```

The wrapper will:
1. Read the repo's `AGENTS.md` (mandatory) and `README.md`.
2. Plan the change with the LLM, using AGENTS.md as source of truth.
3. Apply edits only inside the allowlist.
4. Run `npm run validate` (pre-flight).
5. Push to a `content/*` branch and open a draft PR.

You MUST NOT:
- Edit any file outside the allowlist.
- Push to main/master or any non-`content/*` branch.
- Bypass the pre-flight `npm run validate`.
- Merge the PR yourself — there is no `pr_merge` tool by design.
  Merging happens on GitHub after CI passes and a human reviews.

## When to use low-level tools

- Inspection only (`repo_read`, `repo_search`).
- Tiny edits the user fully specified.
- Checking existing PR status (`pr_list`).
```

---

## 9. 仓库 / 文件结构

```
dsh-mmw-tools/
├── package.json
├── cordis.patch.yml
├── README.md
├── src/
│   ├── index.ts                 # bundle 入口
│   ├── auth/
│   │   ├── service.ts           # AuthService
│   │   ├── device-flow.ts       # 状态机
│   │   ├── token-store.ts       # keychain + DSH storage
│   │   └── github-api.ts
│   ├── repo/
│   │   ├── binding.ts           # RepoBindingService
│   │   └── changeset-guard.ts   # allowlist/denylist
│   ├── mcp/
│   │   ├── host.ts              # McpHost
│   │   └── spawn.ts
│   ├── agent/
│   │   ├── tools.ts             # mmw_tools_status / config / run
│   │   └── run-pipeline.ts      # §7 的高层业务逻辑
│   ├── ui/
│   │   └── settings.tsx         # Settings → MMW Tools
│   └── util/
│       ├── logger.ts            # token 过滤
│       └── errors.ts
├── mcp-server/                  # 独立子包
│   ├── package.json
│   ├── src/
│   │   ├── index.ts
│   │   ├── tools/
│   │   │   ├── repo_status.ts
│   │   │   ├── repo_clone.ts
│   │   │   ├── repo_pull.ts
│   │   │   ├── repo_read.ts
│   │   │   ├── repo_search.ts
│   │   │   ├── repo_edit.ts    # 含 pre-flight npm run validate
│   │   │   └── pr_create.ts
│   │   ├── git/wrapper.ts
│   │   ├── github/octokit.ts
│   │   └── guard/              # 路径 / 分支硬护栏
│   │       └── changeset.ts
│   └── tsconfig.json
├── skills/
│   └── mmw-tools/
│       └── SKILL.md
├── tests/
│   └── smoke.ts
└── docs/
    ├── DESIGN.md                # 本文档
    ├── AUTH.md                  # 注册 OAuth App 步骤
    └── SECURITY.md
```

---

## 10. 安全设计

### 10.1 Token 处理

| 阶段 | 行为 |
|---|---|
| 写入 | OS keychain 优先，DSH 加密存储回退 |
| 读取 | `getAccessToken()` 一次性取出，不缓存 |
| 刷新 | 过期前 5 分钟主动 / 401 后被动 |
| 撤销 | UI `[Revoke]` + GitHub `DELETE /applications/{client_id}/grant` |
| 失效 | 401 → refresh → 仍失败 → `reauth_needed` 红条 |
| 日志 | logger 过滤 `access_token=`、`Authorization:`、`Bearer ` |
| PR body / commit message | token 字符串**严禁**出现（双层正则黑名单兜底） |

### 10.2 越权防护（双层防御）

| 风险 | 第一层（MCP server） | 第二层（DSH bundle） |
|---|---|---|
| 改 AGENTS.md / README.md / scripts 等 | `REPO_EDIT` 前校验 path | `RepoBindingService.validateChangeSet()` |
| 推 main | `REPO_PUSH` 前检查 branch 前缀 | `RepoBindingService.enforceBranch()` |
| 改未在 allowlist 的路径 | 同上 | `validateChangeSet()` 在 push 前最终校验 |
| 跳过 pre-flight | `repo_edit` 内部强制跑 | `mmw_tools_run` 流程图里再跑一次 |
| 合并 PR | 没有 `pr_merge` 工具 | 没有高层 `engineer_merge` 工具 |
| token 泄漏到 PR body | logger 黑名单 | `pr_create` 提交前再 grep 一次 |

### 10.3 审计

每次 `mmw_tools_run` 在 DSH session log 留一条：
- 时间戳、login、PR 编号 + URL
- 变更文件路径列表
- commit SHA
- pre-flight exit code + 命令
- LLM 步数

**不**包含 token、PR body 全文、commit message 全文。

---

## 11. 失败 / 错误处理

| 场景 | 处理 |
|---|---|
| Device Flow 用户 5 分钟未输码 | `device_pending` → `no_token` |
| Token 401/403 连续 | 1 次 refresh，失败 → `reauth_needed` |
| 用户在 GitHub 撤销 token | refresh 失败 → `reauth_needed` |
| Working dir 被外部删 | `repo_status` 返回 `cloned: false`；`mmw_tools_run` 主动 `repo_clone` |
| `git push` 失败（conflict / 保护分支） | 错误回 LLM，让 LLM 决定下一步 |
| `npm run validate` 失败 | 错误回 LLM；不 push；不开 PR |
| repo_root 没有 `AGENTS.md` | `mmw_tools_run` 拒绝执行，提示用户先创建 |
| `repo_edit` 路径越权 | MCP server 直接拒绝（422） |
| `branch_name` 不符合 `content/*` 前缀 | MCP server 拒绝 |
| LLM 步数 > 30 | 终止，把当前 diff + 失败步骤返回 |
| 用户改了 allowlist 但未重启 MCP | 提示用户重启 bundle |

---

## 12. 部署与发布

1. **注册 GitHub OAuth App**（一次性，5 分钟）—— 把 `client_id` 写进 bundle manifest（hardcoded 或 config）。
2. **打包**：`pnpm build` 出 `dist/`。
3. **本地开发**：`dsh plugin --profile web add link:/path/to/dsh-mmw-tools`。
4. **首次启动**：Settings → MMW Tools 空状态 → `[Connect GitHub]`。
5. **首次使用 `mmw_tools_run`**：插件自动 `repo_clone` 到 `~/.dsh/profiles/<state>/workspaces/mmw-devs/ffxiv-race-ops`，跑 `npm ci`（如果 working_dir 没有 node_modules）。
6. **发布**：提 PR 到 `awesome-dsh-plugin` + 可选 npm `dsh-mmw-tools`。

---

## 13. 现状 / 已知未来工作

| 项 | v1 | 备注 |
|---|---|---|
| 单一客户仓库 `mmw-devs/ffxiv-race-ops` | ✅ | 硬绑定 |
| GitHub OAuth Device Flow（个人身份） | ✅ | |
| 通用 MCP 工具集 7 个 | ✅ | |
| `mmw_tools_run` 高层包装 | ✅ | |
| AGENTS.md 强制读取 | ✅ | |
| 本地 `npm run validate` 强校验 | ✅ | |
| `content/*` 分支硬护栏 | ✅ | |
| 禁止自动 merge | ✅ | 通过缺工具实现 |
| 多仓库支持 | v2 | 现在的设计是单仓库 |
| GitHub App 凭证模式（`race-ops-bot` 风格） | 不实现 | 已被业务侧否定 |
| 领域 skill 包装（`update-team` 等） | 不实现 | 已被业务侧否定 |
| 飞书 IM 入口联动 | 不实现 | 已被业务侧否定 |
| 与 `dsh-feishu-*` 系列事件总线 | v2 | 现 v1 无需 |
| Org-level 权限审计（谁是内容） | v2 | |

---

## 14. 风险

1. **DSH 进程被强杀**：working_dir 可能残留半成品 branch → 启动时 `repo_status` 检测 dirty state → 提示用户决定 `git checkout -- .` 或 `git stash`。
2. **`AGENTS.md` 被外部修改**：插件每次 `mmw_tools_run` 都重读最新版本，LLM 拿到的是当下 AGENTS.md，不是缓存版本——这点 OK。
3. **`content/*` 分支名冲突**：v1 假设多人协作时用 `content/<topic>` 不冲突；冲突由 GitHub PR 阶段解决（不算 plugin 责任）。
4. **LLM 在 commit message 里塞 token / 密钥**：双层正则黑名单兜底，但最强护栏是 `repo_edit` 提交前对 commit_message 做 `(?i)(api[-_]?key|secret|password|token|bearer)` 扫描。
5. **`scripts/validate-data.ts` 的业务规则**（bossHP ∈ [0,100]、rank 连续）会**继续变化**——v1 让用户自己在 Settings 里改 `preflight.cmd` 适配。
6. **`public/data.json` 体积随赛事增长**：v1 没有分片；如果加，对于只读 `repo_read` 仍 OK，但 `repo_edit` 需要小心（LLM 不要一次性重写整个文件）。
7. **本地 `npm run validate` 依赖 npm 项目**：插件不强制 working_dir 一定是 Node 项目；如果未来添加 Python 仓库，需要 preflight.cmd 可换。这条方案已留口子（`preflight_cmd` 是字符串）。

---

## 15. 一句话总结

> **`dsh-mmw-tools` v2 = DSH bundle + stdio MCP server + 个人 GitHub OAuth Device Flow + 单一客户仓库（`mmw-devs/ffxiv-race-ops`）+ 7 个通用 repo 工具（无 `pr_merge`）+ 严格遵守仓库 AGENTS.md 的 allowlist/denylist/`content/*` 分支/`npm run validate` pre-flight 硬护栏 + 高层 `mmw_tools_run` 包装。删掉了 GitHub App 模式、领域 skill 包装、飞书 IM 入口——因为这些都不在新方案的范围内。**

---

## 附录 A：从 v1 到 v2 改了什么

| 项目 | v1 | v2 | 理由 |
|---|---|---|---|
| 凭证模型 | OAuth Device Flow + GitHub App 双模 | 仅 OAuth Device Flow | `race-ops-bot` 是旧服务器部署产物 |
| 领域 skill | 4 个（update-team 等） | 0 个 | 旧 PI Agent 封装，不在新方案 |
| 仓库数 | 单仓库可切换 | 硬绑定 `mmw-devs/ffxiv-race-ops` | v1 范围确定 |
| PR 默认行为 | 默认开 draft，可调 auto_merge | 默认 draft，**没有 merge 工具** | CI 校验 + 人工 review 是 ops 流程硬环节 |
| 飞书集成 | 可选耦合 | 完全不集成 | v1 范围确定 |
| 客户端文件 allowlist | 通用 | `public/data.json` only | 来自 AGENTS.md |
| 分支前缀 | 配置项 | `content/` 写死（可配置） | 来自 AGENTS.md |
| pre-flight | 可选 | `npm run validate` 强校验 | 来自 AGENTS.md |
| AGENTS.md | 强校验存在 | 强校验存在 + 强制读取作为 LLM context | 新增"读取"语义 |
| 工作目录 | self / `workspaces/<slug>` | 本机文件系统下 `<profile>/workspaces/...` | 用户确认 |