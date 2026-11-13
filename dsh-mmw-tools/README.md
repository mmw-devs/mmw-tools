# dsh-mmw-tools

这是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，让 DSH agent 在**一个已注册的 GitHub 仓库**里，按仓库自己发布的规则工作：读 `AGENTS.md`，只改 allowlist 中的路径，每次提交前跑 pre-flight，开 pull request，展示托管预览，并且只有操作者确认后才合并或关闭。一个 profile 可以服务多个已注册仓库；每个会话用 `select_repo` 绑定其中一个。

认证由 broker 中介：**飞书登录是唯一的用户凭据**，不需要 GitHub 账号。broker 验证飞书身份后，用自己的 GitHub App installation 签出一个短期、**只读**的 token；写操作走 broker 的 `/v1/write/*` 代理，代理会逐次重新校验 operation，并把写 token 留在 broker 内存里。不需要 webhook，操作者机器也不需要公网 IP。`pr_merge` 会请求宿主确认，并要求一次性 broker approval 绑定 PR head SHA；`pr_close` 会请求宿主确认并检查分支归属，但不需要这个 approval nonce。

```
agent ──▶ select_repo ──▶ 把会话绑定到一个已注册仓库
       ──▶ mmw_tools_run ──▶ 读取 AGENTS.md / README.md，返回操作规则
       ──▶ repo_read / repo_search ──▶ 理解当前状态
       ──▶ repo_edit ──▶ allowlist 校验 + preflight + commit
       ──▶ pr_create ──▶ push content/* + 开 PR
       ──▶ pr_preview ──▶ 操作者审阅的预览 URL
       ──▶ pr_merge ──▶ 操作者在 UI 确认后合并
       ──▶ pr_close ──▶ 同样确认后关闭，不合并
```

## 为什么需要它

agent 对运维仓库的修改通常以两种方式失败：改了不该改的文件，或者提交了仓库自己的校验本来就会拒绝的内容。只要规则可以被机器检查，并且在写入前执行，而不是等 review 后才发现，这两种失败都可以避免。

这个插件从仓库的 `AGENTS.md` 取规则（镜像到 checked-in binding，从而不依赖 LLM 解析），并在工具边界执行：

- **Allowlist** —— allowlist 为空表示任何文件都不能写。
- **Denylist 优先于 allowlist** —— 同时命中两者的路径会被拒绝。
- **分支前缀** —— 提交只能落在 `content/*`，否则不会落地。
- **Pre-flight** —— `repo_edit` 运行配置里的命令，失败就回滚工作树。
- **合并和关闭是受门禁的，不自动执行。** `pr_merge` 和 `pr_close` 在运行前请求操作者在 UI 中确认；`mergeStateStatus`（GitHub 自己的判断）仍然决定是否允许合并。

## 它不做什么

- 不驱动 LLM。`mmw_tools_run` 只准备上下文；循环由 DSH agent 执行。
- 不在操作者确认宿主提示之前合并，也绝不绕过分支保护。
- 不向 base 分支推送。
- 不在会话内切换仓库：`select_repo` 只绑定一次，会话结束前绑定不能改变。
- 不接收 webhook，也不需要公网 IP。

## 环境要求

| | |
|---|---|
| DSH | `>= 0.1.5-rc.1` |
| Node | `^22.19.0 \|\| >= 24.0.0`（DSH 桌面版自带一个） |
| `git` | 在 `PATH` 中——安装和插件自己的 clone 都需要 |
| `gh` | 在 `PATH` 中——`pr_list` 使用，以及没有 broker 写凭据时 `pr_create` / `pr_merge` 的本地回退路径使用 |
| GitHub 账号 | **不需要。** broker 用自己的 App installation 认证到 GitHub。用户只需要一个飞书身份，其角色覆盖要用的 operation：编辑工作用 `repo_read` / `repo_edit` / `pr_create` / `pr_close`，合并用 `pr_merge` |
| 网络 | 能访问 `https://race-ops-broker.mmw-team.icu` 和 `https://mmw-tools.mmw-team.icu` |

操作者机器上不需要 OAuth App、client id 或 client secret：认证走 broker（见 `docs/AUTH-BROKER.md`），登录 token 在 broker 那里换成短期 installation token。

### 第一次调用之前

只安装插件还不够。管理员必须先：

1. 在 auth core 注册仓库（**Admin → 仓库注册表**）；
2. 给飞书成员授予 `select_repo` 以及该仓库需要的 operations（**Admin → 成员 → 仓库授权**）；
3. 在仓库的 base 分支放一个 `.dsh-mmw-tools.yaml`。

会话必须运行在 `origin` remote 匹配某个已注册仓库的 clone 里，或者从一个 `repo_clone` 能创建 checkout 的目录开始。不确定时调用 `mmw_tools_status`：它的 `workspace` 段会报告 `managed`、`unmanaged`、`mismatch`、`bootstrap` 或 `unknown`，并说明原因。

## 安装

### 从插件面板安装（推荐）

DSH 侧边栏 → **插件（Plugins）** → **添加插件** → **安装第三方插件**：

```
git+https://github.com/mmw-devs/mmw-tools.git#path:/dsh-mmw-tools
```

面板接受 npm 包名、git 仓库和本地目录；本插件是 monorepo 的子目录，所以要用 `#path:` 选择器。安装、启用，然后**重启 DSH**（host bundle 和 MCP 子进程都在启动时加载）。

如果面板拒绝这个地址，就克隆仓库，把同一个对话框指向本地目录 `<clone>/dsh-mmw-tools`——构建产物（`lib/`、`mcp-server/dist/`）已经提交，操作者机器上不需要构建。

然后打开 **Settings → MMW Tools**，点击 **使用飞书登录**。这是唯一的登录方式：完成前门禁会拒绝所有业务工具（`mmw_tools_status` 例外），broker 根据飞书身份签发仓库 token。不涉及 GitHub 账号、OAuth 授权或 client secret。仓库访问由 broker 的 GitHub App 身份完成；写代理见 `docs/AUTH-BROKER.md` §13。

### 安装到哪个 profile

DSH 的 **profile** 是插件安装单位——不存在按工作区安装插件这回事。安装进一个 profile 的插件会在该 profile 托管的**每一个**工作区加载，这些会话里都会出现插件的工具。一个 profile 可以托管多个已注册仓库，但每个会话用 `select_repo` 只绑定一个；workspace guard 每次调用判断当前工作区是否属于它。单仓库部署仍然建议使用专用 profile，边界最干净。

```sh
# 为这个仓库建一个专用 profile
dsh --profile race-ops --from-default-profile web --dump-config
dsh plugin --profile race-ops add dsh-mmw-tools
dsh web --profile race-ops
```

让通用 profile（你其他工作区用的那个）不装这个插件。完整设置见 [`docs/T5-RUNBOOK.md`](docs/T5-RUNBOOK.md)。

也支持装进共享 profile：飞书门禁只管本插件自己的工具，宿主的 `read`、`pwsh`、`glob` 等在所有地方照常工作，**workspace guard** 会拒绝绑定 checkout 之外的 mmw-tools 调用。共享 profile 仍然会让工具出现在无关会话的 schema 列表里。只有专用 profile 才能得到一个完全看不到该插件的会话。见下文 **飞书门禁的范围** 和 **工具范围：工作区相关性**。

### 从命令行安装

```sh
dsh plugin --profile <profile> add "git+https://github.com/mmw-devs/mmw-tools.git#path:/dsh-mmw-tools"
# 重启 DSH
```

### 从本地 checkout 安装（开发）

```sh
git clone https://github.com/mmw-devs/mmw-tools.git
cd mmw-tools/dsh-mmw-tools
pnpm install
pnpm --filter dsh-mmw-tools-mcp build   # MCP 子进程
pnpm build:all                          # host bundle + client bundle

dsh plugin --profile <profile> add file:$PWD   # 用 `file:`，不要用 `link:` —— 见下文
# 重启 `dsh web`
```

### 从 npm 安装（发布后）

```sh
dsh plugin --profile <profile> add dsh-mmw-tools
```

发布清单见 [`docs/PUBLISHING.md`](docs/PUBLISHING.md)。

### 更新

第三方插件没有自动更新：卸载后从新的 commit 重新安装。设置和会话在 `~/.dsh/`，所以重装会保留登录，除非包名或数据文件名变了（0.9.0 变过——见 [`CHANGELOG.md`](CHANGELOG.md)）。

### 第一次运行

先调用 `select_repo`：它从 auth-core 注册表把会话绑定到一个仓库。然后 `repo_clone`（或已有的 clone）把 checkout 放到 `~/.dsh/workspaces/<owner>/<name>`，除非配置了 `workingDir`。第一次 `repo_edit` 会用 `npm ci` 做 bootstrap（最多 5 分钟），因为仓库自己的 pre-flight 依赖 devDependencies。

## 使用

飞书登录并 `select_repo` 之后，正常和 agent 对话即可，它会选择工具。一次典型的往返：

```text
你：先读一下 mmw_tools_run 里的规则，再把 public/data.json 里的 X 改成 Y，
    跑 validation，然后开一个 PR。

agent：select_repo → mmw_tools_run → repo_read → repo_edit → pr_create
```

- `pr_create` 默认开 **draft** PR。如果你要 ready 的 PR，明确说出来。
- “看一下 PR #12 的预览和检查”会走 `pr_preview`。
- “合并 PR #12”会走 `pr_merge`：宿主先请你确认，然后 broker 检查 base 分支契约，并返回一个绑定 head SHA 的一次性 approval。
- “关闭 PR #12”会走 `pr_close`：宿主先请你确认，broker 允许分支作者、`operator` 或 `admin` 关闭。
- 如果调用因为工作区原因被拒，先运行 `mmw_tools_status` 看 `workspace` 模式，再决定是否换目录或换仓库。

## 配置

所有配置都在 [`cordis.patch.yml`](cordis.patch.yml)。随包文件绑定的是 `mmw-devs/ffxiv-race-ops`；为自己的仓库改这些字段。

```yaml
workingDir: ~/.dsh/workspaces/you/your-repo   # clone 放在哪里
feishu:
  enabled: true
  authServiceUrl: https://mmw-tools.mmw-team.icu
repoBinding:
  owner: you
  name: your-repo
  baseBranch: main
  branchPrefix: content/            # 插件创建或推送的每个分支
  allowlistPaths: [public/data.json]
  denylistPaths: [.github/workflows/**, schema/**, scripts/**, AGENTS.md, README.md, dist/**]
  preflight:
    cmd: npm run validate
    timeoutSeconds: 60
  bootstrap:                         # 可选；每个 checkout 运行一次
    cmd: npm ci
    whenMissing: node_modules
    timeoutSeconds: 300
repos:                               # 可选；额外的仓库
  - owner: mmw-devs
    name: xivstrat-relay
    baseBranch: master
    branchPrefix: content/
```

`repoBinding` 永远是第一个（默认）仓库。每个 `repos` 条目用相同字段合并，省略的字段回退到默认值。会话必须先调用 `mcp__mmw-tools__select_repo`，之后不能再切换仓库。插件把选中的 `owner/name` 通过 `_meta.mmwRepo` 和 `MMW_REPOS` 传给 MCP 子进程；每个仓库有自己的工作副本和 installation-token 文件（`~/.dsh/dsh-mmw-tools-installation-<owner>-<name>.json`）。broker 的 token 请求带 `?repo=`，所以签出的 token 绑定所选仓库，而不是默认仓库。

启用飞书后，auth core 的仓库注册表（`GET /v1/agent/repos`，在 **Admin → 仓库注册表** 管理）是仓库坐标的权威；写规则来自该仓库 base 分支上的 `.dsh-mmw-tools.yaml`。`select_repo` 绑定前先刷新注册表，拒绝没有启用的仓库。然后它读取该仓库的 grants（`GET /v1/agent/routes?repo=`），如果成员在那里没有 `select_repo` 角色就拒绝绑定；业务调用使用同一张按仓库的表，所以所选仓库没有授权的成员拿到的是空 operation 表，而不是全局角色集。Grants 在 **Admin → 成员 → 仓库授权** 按成员编辑。
规则文件通过 broker 读取（`GET /repo-policy?repo=`），从不直接从 GitHub 读。文件缺失、非法或不可达都会让选择失败，返回 `[mmw_policy_unavailable]`；绝不会回退到 profile 里的副本。解析出的 allow/deny 列表、`branchPrefix`、`preflight` 和 `bootstrap` 会覆盖内存条目，并缓存给 MCP；MCP 每次调用重新读取缓存。
因为 DSH 在加载时同步注册工具，最后一次成功刷新会缓存到 `~/.dsh/mmw-tools-repos.json`（0600），下次启动覆盖到 profile 上；因此在 admin UI 新增的仓库要等插件 reload 后才出现。没有启用飞书的 profile 继续使用 profile 文件里的 `repos`。

| 字段 | 含义 |
|---|---|
| `feishu.enabled` | 在调用时执行飞书角色门禁。默认关闭；随包文件打开。 |
| `feishu.authServiceUrl` | Auth core 的 origin。环境变量 `MMW_TOOLS_AUTH_URL` 优先。 |
| `feishu.gateScope` | `mmw-tools`（默认）只管本插件工具；`session` 把门禁变成整个会话的排他 allowlist。见 **飞书门禁的范围**。 |
| `workingDir` | `repo_clone` 把 checkout 放在哪里，以及 `mmw_tools_run` 从哪里读 `AGENTS.md`。回退到 `GHOST_WORKING_DIR`；`repos[]` 条目可以覆盖。 |
| `repos` | 可选的额外仓库列表。字段与 `repoBinding` 相同；重复或格式错误的 key 会被跳过。 |
| `allowlistPaths` | `repo_edit` 唯一可写的路径。支持 glob、正斜杠、`**` 和 `*`。 |
| `denylistPaths` | 永远拒绝，即使也在 allowlist 里。 |
| `preflight.cmd` | 每次提交前运行；非零退出会回滚工作树。 |
| `bootstrap.cmd` | 可选。checkout 第一次编辑前，当 `whenMissing` 不存在时运行。`preflight` 依赖 devDependencies 时需要它——新 clone 没有 `node_modules`，没有它每次提交都会被自己的 pre-flight 拒绝（`tsx: not found`）。 |

### 让 binding 保持诚实

`allowlistPaths`、`denylistPaths`、`branchPrefix` 和 `preflight.cmd` **镜像的是目标仓库 `AGENTS.md` 里已经存在的规则**。这种重复是故意的——为了推导安全边界去解析自由格式的 Markdown，不值得——但这也意味着两边会漂移。

有三件事让漂移可见：

1. [`cordis.patch.yml`](cordis.patch.yml) 带一个 `SSOT WARNING — MIRRORED FACTS` 块，列出每个镜像字段及其 `AGENTS.md` 来源。
2. bundle apply 时，[`src/agents-md-check.ts`](src/agents-md-check.ts) 从绑定仓库拉取 `AGENTS.md`，与 binding 做子串指纹比较，不匹配时记录警告。它不阻塞；`AGENTS.md` 是权威。
3. [`docs/OPERATIONS-SYNC.md`](docs/OPERATIONS-SYNC.md) 说明谁负责更新哪一边。

## 设置面板

**Settings → MMW Tools** 是唯一的设置 section：

| 控件 | 效果 |
|---|---|
| **使用飞书登录** | 打开 auth core，然后轮询直到浏览器完成 |
| **退出飞书** | 撤销 plugin token，清理本地飞书、write-auth 和 installation-token 文件 |

登录后，面板显示 `已登录（飞书）· <member>`，把 1 小时的 installation token 标为 `仓库令牌剩余`，把 7 天的飞书授权显示为 `飞书授权剩余`。它不渲染 GitHub 登录、刷新或撤销控件。`mmw_tools_status` 报告相同的 `mode`（`feishu` 或 `none`）。

面板是纯 React + inline styles；`lib/client.js` 通过 DSH web 的 `__ModuleLoader__` factory 契约注册这个唯一的 section。

## 飞书授权

工具目录以工具为中心：每个工具声明 `roles` 和 `requiredPermissions`；没有 role → permission 表。Operation 可以覆盖工具的 roles，`race-ops` 用这个能力形成阶梯：`viewer` 读，`editor` 写、开 PR、关自己的 PR，`operator` / `admin` 还能合并和关闭任何 PR。`pr_merge` 和 `pr_close` 都会问宿主；`pr_merge` 还需要一次性 broker approval，绑定 PR head SHA。宿主确认是 UI 门，不是安全边界：能读 write-auth 文件的本地进程可以自己调用 approval endpoint。
broker 在签发 approval 前，以及合并前，都从 **base** 分支读 `contract/operations.json`；修改这个文件的 PR 会被拒绝（`contract-changed`），op-log `command` 所在级别是 `agentMerge: false`（`race-ops` 的 L1/L3）也会被拒绝（`agent-merge-denied`）。同一份契约由 `COMMANDS.md` 生成。没有这个文件的仓库不受影响。旧的 in-MCP 合并路径（只在没有 broker 写凭据时使用）仍然读 PR head 的契约。`mmw_tools_status` 是 `always: true`。

调用时插件会：

1. 把 `mcp__mmw-tools__*` / `mmw_tools_*` 映射到父工具和 operation；
2. 用 `~/.dsh/dsh-mmw-tools-feishu.json` 里的 plugin token 拉取 `GET /v1/agent/routes`（缓存 60 秒；写操作把表的最长年龄压到 15 秒，让被撤销的写者尽快失效）；
3. 只有 `allowedOperations` 包含 operation id 才放行；tool-level 的 `allowed` 列表是 v1 兼容回退；
4. 否则返回拒绝，消息以括号里的稳定 code 开头——缺少 operation 是 `[mmw_route_denied]`，token 问题是 `[mmw_auth_required]` / `[mmw_session_expired]`，表拉不到是 `[mmw_policy_unavailable]`，未知自有工具是 `[mmw_contract_mismatch]`；前缀后的中文是给人看的。`mmw_tool_unavailable` 是 transport-level code，不由这个门禁发出；
5. 对 `pr_merge` 和 `pr_close`，只在策略检查之后才问操作者。

plugin token 进入最后一天后会自动轮换：一个六小时一次的 watchdog 调用 `POST /v1/session/refresh`，auth core 撤销旧 token，本地记录替换成轮换后的 token。轮换不会删除并发请求写入的替代 token。

`feishu.enabled: true` 时，缺失或过期的 token 会拒绝业务工具。`mmw_tools_status` 仍可调用，让 agent 能报告原因。

飞书 token 也是**仓库凭据**，但只对 broker 有效：客户端永远拿不到 GitHub 写 token。Git 操作需要 installation token 时，插件把 plugin token 放在 `X-MMW-Feishu-Token` 里发给 broker。broker 用 `GET /v1/me` 和 `GET /v1/agent/routes` 验证，然后签一个**只读** token：

| 路由表中的 operations | 客户端 token |
|---|---|
| `repo_read` / `repo_edit` / `pr_create` / `pr_close` / `pr_merge` 中任意一个 | `contents: read`、`pull_requests: read` |
| 都没有 | 拒绝（`feishu-no-access`） |

写操作逐次代理，从不为客户端铸造：`repo_edit`、`pr_create`、`pr_close` 和 `pr_merge` 走 `POST /v1/write/*`，代理在使用只存在于 broker 内存里的写 token 之前，会重新校验确切的 operation。插件把用于这些调用的飞书 plugin token 存到 `~/.dsh/dsh-mmw-tools-write-auth.json`（权限 `0600`）；MCP 子进程读取它并发送 `X-MMW-Feishu-Token`。请求形状和 approval nonce 见 `docs/AUTH-BROKER.md` §13。

正是 broker 侧的校验，让飞书登录成为安全边界，而不只是客户端门禁。

### 飞书门禁的范围

门禁安装为全局的 `tools/pre-execute` listener，因此能观察会话里的每次工具调用。默认它**只管本插件自己的工具**（`mcp__mmw-tools__*` 和 `mmw_tools_*`）；其他所有工具——宿主的 `read`、`pwsh`、`glob`、`web_search`，以及其他插件的工具——原样通过。

`feishu.gateScope` 可以扩大或收窄这个范围：

| 值 | 效果 |
|---|---|
| `mmw-tools`（默认） | 只门禁本插件的工具，会话其余部分不受影响。 |
| `session` | 门禁变成**整个会话**的排他 allowlist：任何不属于 MMW Tools 契约的工具都会被拒绝。 |

`session` 是一个陷阱。DSH profile 被它托管的所有工作区共享，在共享 profile 里设置它，会把所有工作区的文件和 shell 工具都剥掉——一个没有 `read` 和 `pwsh` 的工作区无法工作。只在专用于这个仓库的 profile 里使用。

| Key | 默认值 | 含义 |
|---|---|---|
| `feishu.enabled` | 关闭 | 调用时执行飞书角色门禁。随包文件打开。 |
| `feishu.authServiceUrl` | — | 拥有角色和路由表的 auth core。 |
| `feishu.gateScope` | `mmw-tools` | `mmw-tools` 或 `session`——见上。 |

### 工具范围：工作区相关性

插件按 **profile** 加载；工作区是 profile 里的一个 **session**。一个 profile 托管所有工作区，所以“安装了”不等于“相关”。workspace guard 每次调用回答一个问题：*这个工作区是不是 mmw-tools 正在服务的仓库之一？* 它依据两个独立事实：

- auth-core 的**仓库注册表**——这个部署服务哪些仓库；
- 调用工作树的 **`origin` remote**——这个工作区实际是哪个仓库。

工作区根目录的 `.dsh-mmw-tools.yaml` 是**规则标记**，不是身份。它表示这个 checkout 选择接入；remote 才表示它是哪个仓库。有标记但 remote 不匹配，或者注册仓库没有标记，都是 `mismatch`，绝不静默猜测。guard 每次调用都从宿主的 `workingDirectory` 服务读会话工作目录，从 worktree 读 remote，所以 `cd` 进出受管 checkout 会立即生效。

| 模式 | guard 观察到什么 | 会话可以做什么 |
|---|---|---|
| `managed` | remote 和标记都指向一个已注册仓库 | 使用本插件声明的 operations；路由表仍然逐项决定 |
| `unmanaged` | 没有标记，也没有已注册的 remote | 不要调用插件的业务工具。不推荐任何替代工具 |
| `mismatch` | 标记、remote、注册表或所选仓库互相不一致 | 停下来，让用户确认仓库和规则文件 |
| `bootstrap` | 已注册 checkout，但根目录还没有 `.git` | 只能用 `select_repo` 和 `repo_clone`；变成 checkout 前业务工具保持拒绝 |
| `unknown` | 宿主无法报告工作目录 | 拒绝；绝不 fail open |

这是**相关性过滤器**，不是安全边界。飞书门禁、`select_repo` 和 broker 自己的授权仍然决定一次调用能做什么。它也不会把工具从会话的 schema 列表里隐藏，MCP 子进程仍然随插件启动——只有专用 profile 才能给你一个完全看不到插件的会话。

`mmw_tools_status` 始终可调用：它是诊断界面，报告当前 `workspace` 模式以及业务工具被拒的原因。

| Key | 默认值 | 含义 |
|---|---|---|
| `workspaceGuard.enabled` | 开启 | 只在专用于一个仓库的 profile 里设为 `false`。 |

旧的 `workspaceGuard.allowPaths` 和 `workspaceGuard.onUnavailable` 仍保留给只有旧路径门禁的宿主；上面的“注册表 + remote”判定不使用它们。

## Agent 工具

### 高层工具

| 工具 | 用途 |
|---|---|
| `mmw_tools_status` | 认证状态、仓库绑定、`AGENTS.md` 漂移 |
| `mmw_tools_run` | 准备项目上下文和操作规则；之后由 agent 驱动 MCP 工具 |

### MCP 工具（`mcp__mmw-tools__*`）

| 工具 | 用途 |
|---|---|
| `select_repo` | 把本会话绑定到 auth-core 注册表中启用的一个仓库。业务工具之前必须调用；未选择的会话会收到 `[mmw_route_denied]`，切换到另一个仓库会被拒绝。它在路由表之前由本地会话状态决定，所以滞后的角色表不会阻塞选择；先刷新注册表，再读按仓库的 grants，成员没有 `select_repo` 角色会被拒绝。它还通过 broker 读 `.dsh-mmw-tools.yaml`，文件缺失或非法时失败关闭。注册表和规则结果会缓存，供下次插件加载和 MCP 逐次调用使用 |
| `repo_status` | 分支、dirty 标记、HEAD SHA、未提交文件；remote URL 里的凭据会被脱敏 |
| `repo_clone` | 把 base 分支浅克隆到 `workingDir` |
| `repo_pull` | `git pull --rebase origin <branch>`；工作树 dirty 时拒绝 |
| `repo_read` | 读一个文件（默认 100 KiB，硬上限 500 KiB，拒绝二进制） |
| `repo_search` | `git grep`，结果有上限，片段脱敏 |
| `repo_edit` | 校验 → 原子应用编辑 → preflight → commit。有 broker 写凭据时，commit 由 broker 创建（不 push） |
| `pr_create` | 开 PR（默认 draft；传 `draft: false` 直接 ready）。有 broker 写凭据时，由 broker push 并创建 |
| `pr_close` | 关闭 PR，不合并。分支作者可以关自己的 PR；`operator` / `admin` 可以关任何 PR。宿主先询问；已关闭或已合并返回 `already: true` |
| `pr_preview` | 从托管 check 取预览 URL，以及 check 状态和 draft/merge 状态；只读，可选等待部署 |
| `pr_list` | 列出 PR（标题和正文脱敏） |
| `pr_merge` | 必要时把 draft 标为 ready，然后合并。有 broker 写凭据时，先取绑定 head SHA 的一次性 approval，再合并；broker 拒绝 `agentMerge: false` 的级别和修改契约的 PR；宿主仍然会询问 |

当 `MMW_BROKER_URL` 存在且 write-auth 文件可读时，这四个写工具调用 broker 的 `/v1/write/*` 端点；否则保留本地 git/`gh` 行为，供独立使用。

## 安全模型

**任何 I/O 之前应用的 guard。** 路径穿越和 symlink 逃逸；allowlist/denylist，deny 优先于 allow；分支前缀和 base 分支拒绝；commit message、PR 标题、PR 正文和 `user_request` 中的 token 形状字符串检测；单文件、单 commit 和 PR 正文的字节上限；pre-flight 命令通过 `execFile` 执行（不经 shell）。

**Token。** 1 小时的客户端 installation token 放在 `~/.dsh/dsh-mmw-tools-installation.json`（`0600`），因为 MCP 子进程从磁盘读它。它始终只读。写操作使用 `~/.dsh/dsh-mmw-tools-write-auth.json`（`0600`），里面是飞书 pluginToken——绝不是 GitHub token；broker 把写 token 留在内存。飞书 plugin token 放在 `~/.dsh/dsh-mmw-tools-feishu.json`（`0600`）。所有这些在 agent 能读到的视图里都会脱敏，也从不写入日志、commit message、PR 正文或审计轨迹。退出飞书会清除本地副本，并让 auth core 丢弃会话。

**审计。** `mmw_tools_run` 把 `mmw_tools_run_start` / `mmw_tools_run_created` / `refused` 事件追加到 `~/.dsh/dsh-mmw-tools-audit.jsonl`（模式 `0600`，1 MiB 轮换）。每个字符串字段都会递归脱敏；请求正文本身从不记录，只记录字节长度。审计写入失败只警告一次，然后静默——绝不阻塞工作。

**已知取舍**，明确写出而不是隐藏：

- 不使用 broker 写代理时，`repo_clone` 和 `pr_create` 会把 token 放在 git 命令行上，因此它会在进程列表中短暂可见。它从不写入 `.git/config`：`repo_clone` 在克隆后立即把 `origin` 重置为无凭据 URL，`pr_create` 向显式 URL push 且不加 `-u`，因为 `-u <url>` 会把该 URL（含 token）存成 `branch.<name>.remote`。未来版本应该用 `GIT_ASKPASS`，把 argv 暴露也去掉。
- broker approval nonce 绑定成员、PR 和 head SHA，且只能使用一次。它不能证明有人点了宿主提示：能读 write-auth 文件并发送 HTTP 的本地进程可以自己请求 approval 并合并。宿主 `pr_merge` / `pr_close` 的确认是 UI 门，不是安全边界；要关闭这个缺口需要宿主持有的 secret。
- `repo_edit` 的 `find` 是逐字节匹配。在启用 `core.autocrlf` 的 Windows checkout 上，工作树里是 CRLF，所以用 LF 写的多行 `find` 不会匹配；编辑会被拒绝为 `find-not-found`，而不是应用一半。先用 `repo_read` 读文件，并复用它的精确字节。
- Windows 上 `preflight` 和 `bootstrap` 命令通过 shell 运行，因为那里的 `npm` 是 `npm.cmd`，而 `execFile` 不查询 `PATHEXT`。没有这一点，所有基于 npm 的 pre-flight 在这个插件最常用的平台上都会以 `ENOENT` 失败。命令字符串来自你自己的插件配置，从不来自 agent。
- `repo_edit` 的 `patch` 模式尚未实现；用 `replace` 或 `insert`。
- 尚未实现限流。

## 测试

分三层，按运行所需条件而不是覆盖范围划分。完整理由见 [`docs/TESTING.md`](docs/TESTING.md)。

```sh
pnpm check                 # typecheck + namespace + 进程内套件 + 打包内容
cd mcp-server && pnpm test # guard、schema 和 PR-preview 断言
pnpm test:smoke            # 通过真实 stdio 做 MCP server handshake
pnpm test:integration      # 针对真实 git 仓库运行 MCP 工具体
```

| 套件 | 覆盖 | 需要 |
|---|---|---|
| `tests/skills.test.mjs` | skill 目录和 `race-ops-ops` 指令 | — |
| `tests/client-bundle.test.mjs` | `lib/client.js` 的 `__ModuleLoader__` 形状 | — |
| `tests/bundle-apply.test.mjs` | `apply()` 注册、路由、prompt、disposer、幂等 | — |
| `tests/feishu-gate.test.mjs` | 授权表、门禁决策、token 刷新 | — |
| `tests/workspace-guard.test.mjs` | 工作区相关性、status/`select_repo` 豁免、`repo_clone` bootstrap | — |
| `tests/workspace-mode.test.mjs` | 注册表 + `origin` remote + 规则文件标记；managed/unmanaged/mismatch/bootstrap/unknown | — |
| `tests/routes-integration.test.mjs` | 对 loopback 路由发起真实 HTTP | — |
| `tests/mmw-tools-run.test.mjs` | 输入校验、分支 slug、摘录、脱敏、截断 | — |
| `tests/audit.test.mjs` | 深度脱敏、轮换、失败处理 | — |
| `tests/github-app.test.mjs` | installation-token 流程和仓库访问 | — |
| `tests/session-store.test.mjs` | 凭据持久化、脱敏、清理 | — |
| `tests/broker-client.test.mjs` | broker HTTP 客户端行为 | — |
| `tests/broker-auth.test.mjs` | 仅飞书凭据交换、仓库不匹配、缓存命中时刷新 write-auth | — |
| `broker/tests/core.test.mjs` | broker core、只读客户端 token、base 分支契约门、close 归属 | — |
| `broker/tests/server.test.mjs` | broker HTTP 表面和 `/v1/write/*` 路由 | — |
| `mcp-server/tests/guard.test.mjs` | 每个横切 guard | — |
| `mcp-server/tests/tools-list-schema.test.mjs` | 所有 MCP 工具都注册了可用 schema | — |
| `mcp-server/tests/pr-preview.test.mjs` | PR 预览 URL 和 check 提取 | — |
| `mcp-server/tests/tools-list.test.mjs` | MCP server 启动并宣告工具 | `spawn` |
| `tests/integration-git.test.mjs` | 针对 git 的工具体，包括 `repo_edit` 回滚 | `git`、`spawn` |

最后两个需要带管道 stdio 的 `child_process.spawn`。沙箱拒绝时，它们会打印 `SKIP` 说明未验证什么，并以 `0` 退出——CI 在 `ubuntu-latest` 和 `windows-latest` 上都跑，所以本地 skip 不是覆盖缺口。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/AUTH-BROKER.md`](docs/AUTH-BROKER.md) | broker 拓扑、GitHub App 设置、飞书直连路径、写代理、威胁模型、部署 |
| [`docs/PANEL-CONTRACT.md`](docs/PANEL-CONTRACT.md) | 面板状态机：一个飞书登录、两个状态加本地 authorizing、动作矩阵、验收检查 |
| [`docs/TESTING.md`](docs/TESTING.md) | 三层测试、为什么两个会自我跳过、如何加用例 |
| [`docs/T5-RUNBOOK.md`](docs/T5-RUNBOOK.md) | 针对绑定仓库的真实往返步骤：门禁、停止条件、清理 |
| [`docs/OPERATIONS-SYNC.md`](docs/OPERATIONS-SYNC.md) | 谁负责让 `AGENTS.md` 和 binding 保持一致 |
| [`docs/INCREMENT-3-CHECKLIST.md`](docs/INCREMENT-3-CHECKLIST.md) | 按工具列出的加固规格 |
| [`docs/INCREMENT-3-DESIGN.md`](docs/INCREMENT-3-DESIGN.md) | MCP 工具实际做什么 |
| [`docs/INCREMENT-4-CHECKLIST.md`](docs/INCREMENT-4-CHECKLIST.md) | `mmw_tools_run` 契约，以及为什么它不驱动 LLM |
| [`docs/INCREMENT-5-DESIGN.md`](docs/INCREMENT-5-DESIGN.md) | 审计事件、存储和有意省略 |
| [`docs/INCREMENT-2-VERIFICATION.md`](docs/INCREMENT-2-VERIFICATION.md) | client-bundle 构建决策，对照 DSH 源码验证 |
| [`docs/PUBLISHING.md`](docs/PUBLISHING.md) | 发布清单和两个分发渠道 |
| [`CHANGELOG.md`](CHANGELOG.md) | 按 increment 的历史 |
| [`docs/NEXT-STEPS.md`](docs/NEXT-STEPS.md) | 还没建什么，以及为什么每个省略都是故意的 |

## 许可证

[MIT](LICENSE) © 2026 mmw-devs
