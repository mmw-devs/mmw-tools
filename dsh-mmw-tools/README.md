# dsh-mmw-tools

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets a DSH agent work inside **one configured GitHub repository** under rules the repository itself publishes: read `AGENTS.md`, edit only allowlisted paths, pass a pre-flight check before every commit, open a pull request, show the hosting preview, and — only after the operator approves — merge or close it.

Authentication is broker-mediated: a **Feishu login** (no GitHub account needed) or an optional GitHub login. The broker exchanges either credential for a short-lived, **read-only** installation token; writes go through the broker's `/v1/write/*` proxy, which re-checks the operation and keeps the write token in memory. No webhook and no public IP on the operator's machine. Merging and closing happen through `pr_merge` / `pr_close`, which ask the host and require a one-time broker approval bound to the PR head SHA.

```
agent ──▶ mmw_tools_run ──▶ reads AGENTS.md / README.md, returns the operating rules
       ──▶ repo_read / repo_search ──▶ understand the current state
       ──▶ repo_edit ──▶ allowlist check + preflight + commit
       ──▶ pr_create ──▶ push content/* + open the PR
       ──▶ pr_preview ──▶ the preview URL the operator reviews
       ──▶ pr_merge ──▶ merge, after the operator confirms in the UI
       ──▶ pr_close ──▶ close without merging, after the same confirmation
```

## Why

Agent-written changes to an operations repository usually fail in one of two ways: the agent edits files it should not touch, or it ships something that the repository's own validation would have rejected. Both are preventable if the rules are machine-checkable and enforced before the write, not after the review.

This plugin takes the rules from the repository's `AGENTS.md` (mirrored into a checked-in binding so it can be enforced without an LLM parse), and enforces them at the tool boundary:

- **Allowlist** — an empty allowlist means nothing is writable.
- **Denylist beats allowlist** — a path matching both is refused.
- **Branch prefix** — a commit lands on `content/*` or it does not land.
- **Pre-flight** — `repo_edit` runs the configured command and rolls the working tree back if it fails.
- **Merge and close are gated, not automatic.** `pr_merge` and `pr_close` ask the operator to confirm in the UI before they run; `mergeStateStatus` — GitHub's own verdict — still decides whether merging is allowed.

## What it does not do

- Does not drive an LLM. `mmw_tools_run` prepares context; the DSH agent runs the loop.
- Does not merge without the operator confirming the host's prompt, and never bypasses branch protection.
- Does not push to the base branch.
- Does not switch repositories inside a session: `select_repo` binds once, and the binding cannot change until the session ends.
- Does not receive webhooks, and needs no public IP.

## Requirements

| | |
|---|---|
| DSH | `>= 0.1.5-rc.1` |
| Node | `^22.19.0 \|\| >= 24.0.0` (the DSH desktop build ships one) |
| `git` | on `PATH` — both for the install and for the plugin's own clones |
| `gh` | on `PATH` (used by `pr_create` / `pr_list`) |
| GitHub (optional) | only needed when you sign in with GitHub: the account must pass the broker's allowlist — a member of `mmw-devs`, **or** a username listed in the broker's `BROKER_ALLOWED_USERS`. A Feishu member whose roles include this repository's `repo_read` / `repo_edit` / `pr_create` / `pr_close` operations does **not** need a GitHub account |
| Network | `https://race-ops-broker.mmw-team.icu` and `https://mmw-tools.mmw-team.icu` reachable |

No OAuth App, client id or client secret is needed on the operator's machine:
authentication goes through the broker (docs/AUTH-BROKER.md), and the login
token is exchanged there for a short-lived installation token.

## Install

### From the plugin panel (recommended)

DSH 侧边栏 → **插件（Plugins）** → **添加插件** → **安装第三方插件**：

```
git+https://github.com/mmw-devs/mmw-tools.git#path:/dsh-mmw-tools
```

The panel accepts npm package names, git repositories and local directories;
this one is a subdirectory of a monorepo, hence the `#path:` selector. Install,
enable it, then **restart DSH** (the host bundle and the MCP child are loaded
at startup).

If the panel rejects the address, clone the repository and point the same
dialog at the local directory `<clone>/dsh-mmw-tools` instead — the build
output (`lib/`, `mcp-server/dist/`) is committed, so no build step is needed
on the operator's machine.

Then open **Settings → MMW Tools 授权** and press **使用飞书登录**. This is the
primary path: the gate denies every business tool until that login completes
(`mmw_tools_status` is the exception), and the broker mints the repository token
from the Feishu identity. No GitHub account is involved.

A GitHub login remains available in **Settings → MMW Tools** (button
**登录 GitHub（可选）**) for people who prefer it or whose Feishu roles do not
cover the repository. Either credential yields a read-only client token; writes
are proxied by the broker (see `docs/AUTH-BROKER.md` §13).

### Which profile to install into

A DSH **profile** is the unit of plugin installation — there is no per-workspace
plugin installation. A plugin installed into a profile is loaded in **every**
workspace that profile hosts, and it is the plugin's tools that appear in
those sessions. A profile may host several registered repositories, but each
session binds to exactly one with `select_repo`, and the workspace guard decides
per call whether the current workspace is one of them; for a single-repository
deployment a dedicated profile is still the cleanest boundary.

```sh
# a dedicated profile for this repository
dsh --profile race-ops --from-default-profile web --dump-config
dsh plugin --profile race-ops add dsh-mmw-tools
dsh web --profile race-ops
```

Keep the general-purpose profile (the one your other workspaces use) free of
this plugin. See [`docs/T5-RUNBOOK.md`](docs/T5-RUNBOOK.md) for the full
setup.

Installing it into a shared profile is supported: the Feishu gate only governs
this plugin's own tools, so the host's `read`, `pwsh`, `glob` and the rest keep
working everywhere, and the **workspace guard** refuses the mmw-tools calls
made outside the bound checkout. What a shared profile still gives you is the
tools showing up in unrelated sessions' schema lists. A dedicated profile is
the only way to get a session with no trace of the plugin at all. See **Scope
of the Feishu gate** and **Scope of the tools: the workspace guard** below.

### From the command line

```sh
dsh plugin --profile <profile> add "git+https://github.com/mmw-devs/mmw-tools.git#path:/dsh-mmw-tools"
# restart DSH
```

### From a local checkout (development)

```sh
git clone https://github.com/mmw-devs/mmw-tools.git
cd mmw-tools/dsh-mmw-tools
pnpm install
pnpm --filter dsh-mmw-tools-mcp build   # MCP child
pnpm build:all                          # host bundle + client bundle

dsh plugin --profile <profile> add file:$PWD   # `file:`, not `link:` — see below
# restart `dsh web`
```

### From npm (once published)

```sh
dsh plugin --profile <profile> add dsh-mmw-tools
```

See [`docs/PUBLISHING.md`](docs/PUBLISHING.md) for the release checklist.

### Updating

There is no auto-update for third-party plugins: uninstall and install again
from the new commit. Settings and the session live in `~/.dsh/`, so a
reinstall keeps the login unless the package name or data-file names changed
(they did in 0.9.0 — see [`CHANGELOG.md`](CHANGELOG.md)).

### First run

`repo_clone` puts the checkout at
`~/.dsh/workspaces/<owner>/<name>` unless `workingDir` is configured, and the
first `repo_edit` bootstraps it with `npm ci` (up to 5 minutes) because the
repo's own pre-flight runs through its dev dependencies.

## Configure

Everything lives in [`cordis.patch.yml`](cordis.patch.yml). The shipped file is bound to `mmw-devs/ffxiv-race-ops`; change four things for your own repository.

```yaml
workingDir: ~/.dsh/workspaces/you/your-repo   # where the clone lives
feishu:
  enabled: true
  authServiceUrl: https://mmw-tools.mmw-team.icu
repoBinding:
  owner: you
  name: your-repo
  baseBranch: main
  branchPrefix: content/            # every branch the plugin creates or pushes
  allowlistPaths: [public/data.json]
  denylistPaths: [.github/workflows/**, schema/**, scripts/**, AGENTS.md, README.md, dist/**]
  preflight:
    cmd: npm run validate
    timeoutSeconds: 60
  bootstrap:                         # optional; runs once per checkout
    cmd: npm ci
    whenMissing: node_modules
    timeoutSeconds: 300
repos:                               # optional; additional repositories
  - owner: mmw-devs
    name: xivstrat-relay
    baseBranch: master
    branchPrefix: content/
```

`repoBinding` is always the first (default) repository. Each `repos` entry is
merged with the same fields; omitted fields fall back to the defaults. A
session must call `mcp__mmw-tools__select_repo` before any business tool and
cannot switch repositories afterwards. The plugin passes the chosen
`owner/name` to the MCP child in `_meta.mmwRepo` and as `MMW_REPOS`; each
repository gets its own working copy and installation-token file
(`~/.dsh/dsh-mmw-tools-installation-<owner>-<name>.json`). Broker token
requests carry the selected repository as `?repo=`, so the minted token is
scoped to that repository rather than the default one.

When Feishu is enabled, the auth core's repository registry
(`GET /v1/agent/repos`, managed at **Admin → 仓库注册表**) is authoritative
for repository coordinates, while write rules come from that repository's own
`.dsh-mmw-tools.yaml` at the base branch. `select_repo` refreshes the registry
before binding and refuses a repository that is not enabled there. It then
reads that repository's grants (`GET /v1/agent/routes?repo=`) and refuses to
bind if the member has no `select_repo` role there; business calls use the
same repository-scoped table, so a member with no grant for the selected
repository gets an empty operation table rather than the global role set.
Grants are edited per member at **Admin → 成员 → 仓库授权**.
The rule file is read through the broker (`GET /repo-policy?repo=`), never
directly from GitHub. A missing, invalid or unreachable file fails the
selection with `[mmw_policy_unavailable]`; it never falls back to the profile
copy. The parsed allow/deny lists, `branchPrefix`, `preflight` and
`bootstrap` overlay the in-memory entry and are cached for MCP, which re-reads
the cache on every call.
Because DSH registers tools synchronously at load, the last successful
refresh is cached at `~/.dsh/mmw-tools-repos.json` (0600) and overlaid on the
profile at the next start; a repository added in the admin UI therefore
appears after a plugin reload. Profiles without Feishu keep using `repos`
from the profile file.

| Field | Meaning |
|---|---|
| `feishu.enabled` | Enforce the Feishu role gate at call time. Default off; the shipped file turns it on. |
| `feishu.authServiceUrl` | Auth core origin. Env `MMW_TOOLS_AUTH_URL` wins. |
| `feishu.gateScope` | `mmw-tools` (default) gates only this plugin's tools; `session` makes the gate an exclusive allowlist for the whole session. See **Scope of the Feishu gate**. |
| `workingDir` | Where `repo_clone` puts the checkout and where `mmw_tools_run` reads `AGENTS.md`. Falls back to `GHOST_WORKING_DIR`; a `repos[]` entry may override it. |
| `repos` | Optional list of additional repositories. Same fields as `repoBinding`; duplicate or malformed keys are skipped. |
| `allowlistPaths` | The only paths `repo_edit` may write. Glob, forward-slash, `**` and `*` supported. |
| `denylistPaths` | Always refused, even if also allowlisted. |
| `preflight.cmd` | Run before every commit; non-zero exit rolls the tree back. |
| `bootstrap.cmd` | Optional. Run before the first edit of a checkout when `whenMissing` is absent. Needed when `preflight` depends on devDependencies — a fresh clone has no `node_modules`, so without it every commit is refused by its own pre-flight (`tsx: not found`). |

### Keeping the binding honest

`allowlistPaths`, `denylistPaths`, `branchPrefix`, and `preflight.cmd` **mirror rules that already live in the target repository's `AGENTS.md`**. That duplication is deliberate — parsing free-form Markdown to derive a security boundary is not a trade worth making — but it does mean the two can drift.

Three things keep it visible:

1. [`cordis.patch.yml`](cordis.patch.yml) carries a `SSOT WARNING — MIRRORED FACTS` block naming each mirrored field and its `AGENTS.md` source.
2. At bundle apply, [`src/agents-md-check.ts`](src/agents-md-check.ts) fetches `AGENTS.md` from the bound repository and compares substring fingerprints against the binding, logging a warning on mismatch. It does not block; `AGENTS.md` is the authority.
3. [`docs/OPERATIONS-SYNC.md`](docs/OPERATIONS-SYNC.md) states who updates which side.

## Settings panel

**Settings → MMW Tools** (GitHub):

| Control | Effect |
|---|---|
| **登录 GitHub（可选）** | Starts the broker login and opens the verification page |
| **重新获取仓库权限** | Re-checks the broker's repository access (GitHub mode only) |
| **退出登录** | Revokes the broker session and clears the local session (GitHub mode only) |

**Settings → MMW Tools 授权** (Feishu):

| Control | Effect |
|---|---|
| **使用飞书登录** | Opens the auth core, then polls until the browser completes |
| **退出飞书** | Revokes the plugin token and clears `~/.dsh/dsh-mmw-tools-feishu.json` |

When a Feishu credential is active, the GitHub panel reports
`已登录（飞书）· <member>` and hides the GitHub-only refresh/logout controls;
**退出飞书** in the Feishu panel ends that session. `mmw_tools_status` reports
the active `mode` (`feishu`, `github`, or `none`), labels the one-hour
installation token as `仓库令牌剩余`, and points at the Feishu panel for the
7-day authorization expiry.

The panels are plain React with inline styles; `lib/client.js` registers both
sections through the DSH web `__ModuleLoader__` factory contract.

## Feishu authorization

The tool catalog is tool-centric: each tool declares `roles` and
`requiredPermissions`; there is no role → permission table. Operations may
override the tool's roles, and `race-ops` uses that to expose a ladder: `viewer`
reads, `editor` writes, opens, and closes its own PRs, `operator` / `admin` can
also merge and close any PR. `pr_merge` and `pr_close` ask the host; `pr_merge`
also requires a one-time broker approval bound to the PR head SHA. The host
confirmation is a UI gate, not a security boundary: a local process that can
read the write-auth file can call the approval endpoint itself.
The broker reads `contract/operations.json` from the **base** branch before it
issues an approval and again before it merges; a PR that changes that file is
refused (`contract-changed`), and an op-log `command` on a level with
`agentMerge: false` (L1/L3 in `race-ops`) is refused (`agent-merge-denied`).
The same contract is generated from `COMMANDS.md`. Repositories without that
file are unaffected. The legacy in-MCP merge path (used only when no broker
write credential is present) still reads the contract at the PR head.
`mmw-tools-status` is `always: true`.

At call time the plugin:

1. maps `mcp__mmw-tools__*` / `mmw_tools_*` to the parent tool and operation;
2. fetches `GET /v1/agent/routes` with the plugin token from
   `~/.dsh/dsh-mmw-tools-feishu.json` (60 s cache; write operations cap the table
   at 15 s so a revoked writer loses access quickly);
3. allows the call only if `allowedOperations` contains the operation id; the
   tool-level `allowed` list is a v1 compatibility fallback;
4. otherwise returns a refusal whose message starts with the stable code in
   brackets — `[mmw_route_denied]` for a missing operation, `[mmw_auth_required]`
   / `[mmw_session_expired]` for the token, `[mmw_policy_unavailable]` when the
   table cannot be fetched, and `[mmw_contract_mismatch]` for an unknown own tool;
   the Chinese text after the prefix is for humans. `mmw_tool_unavailable` is a
   transport-level code and is not emitted by this gate;
5. for `pr_merge` and `pr_close`, only after the policy check, asks the operator.

The plugin token is rotated automatically once it is inside its last day: a
six-hour watchdog calls `POST /v1/session/refresh`, the auth core revokes the
old token, and the local record is replaced with the rotated token. A
rotation never deletes a replacement token written by a concurrent request.

With `feishu.enabled: true`, a missing/expired token denies business tools.
`mmw_tools_status` remains callable so the agent can report why.

The Feishu token is also a **repository credential**, but only for the broker:
the client never receives a GitHub write token. When a Git operation needs an
installation token and no GitHub session is preferred, the plugin sends the
plugin token to the broker in `X-MMW-Feishu-Token`. The broker verifies it with
`GET /v1/me` and `GET /v1/agent/routes`, then mints a **read-only** token:

| Route-table operations | Client token |
|---|---|
| any of `repo_read` / `repo_edit` / `pr_create` / `pr_close` / `pr_merge` | `contents: read`, `pull_requests: read` |
| none | refused (`feishu-no-access`) |

Writes are proxied per call, never minted for the client: `repo_edit`,
`pr_create`, `pr_close`, and `pr_merge` go to `POST /v1/write/*`, which re-checks
the exact operation (and, for GitHub, the session plus allowlist) before using a
write token that exists only in broker memory. The plugin stores the credential used
for those calls in `~/.dsh/dsh-mmw-tools-write-auth.json` (mode `0600`); the MCP
child reads it and sends `X-MMW-Feishu-Token` or `Authorization: Bearer`. See
`docs/AUTH-BROKER.md` §13 for the request shapes and the approval nonce.

The Feishu credential is preferred when both exist; a valid GitHub session is
the fallback when the Feishu token is stale. The broker-side check is what makes
the Feishu login a security boundary rather than just a client-side gate.

### Scope of the Feishu gate

The gate is installed as a global `tools/pre-execute` listener, so it observes
every tool call in the session. By default it **only governs this plugin's
own tools** (`mcp__mmw-tools__*` and `mmw_tools_*`); every other tool — the
host's `read`, `pwsh`, `glob`, `web_search`, another plugin's tools — passes
through untouched.

`feishu.gateScope` widens or narrows that:

| Value | Effect |
|---|---|
| `mmw-tools` (default) | Only this plugin's tools are gated. The rest of the session is untouched. |
| `session` | The gate becomes an exclusive allowlist for the **whole session**: any tool outside the MMW Tools contract is denied. |

`session` is a footgun. Because a DSH profile is shared by every workspace
it hosts, setting it in a shared profile strips the file and shell tools out
of all of them — a workspace with no `read` and no `pwsh` cannot work. Use it
only in a profile dedicated to this repository.

| Key | Default | Meaning |
|---|---|---|
| `feishu.enabled` | off | Enforce the Feishu role gate at call time. The shipped file turns it on. |
| `feishu.authServiceUrl` | — | The auth core that owns roles and the route table. |
| `feishu.gateScope` | `mmw-tools` | `mmw-tools` or `session` — see above. |

### Scope of the tools: workspace relevance

A plugin is loaded per **profile**; a workspace is a **session** inside it. One
profile hosts every workspace, so being installed is not the same as being
relevant. The workspace guard answers one question per call: *is this workspace
one of the repositories mmw-tools is serving?* It answers from two independent
facts:

- the auth-core **repository registry** — which repositories this deployment
  serves; and
- the calling worktree's **`origin` remote** — which repository this workspace
  actually is.

`.dsh-mmw-tools.yaml` at the workspace root is the **rule marker**, not the
identity. It says this checkout opted in; the remote says which repository it
is. A marker without a matching remote, or a registered repository without a
marker, is a `mismatch`, never a silent guess. The guard reads the session's
working directory from the host's `workingDirectory` service and the remote
from the worktree, per call, so a `cd` in or out of a managed checkout takes
effect immediately.

| Mode | What the guard observed | What the session may do |
|---|---|---|
| `managed` | remote and marker both name a registered repository | Use the operations this plugin declares; the route table still decides each one |
| `unmanaged` | no marker and no registered remote | Do not call the plugin's business tools. No replacement tool is prescribed |
| `mismatch` | marker, remote, registry, or the selected repository disagree | Stop and let the user confirm the repository and rule file |
| `bootstrap` | registered checkout whose root has no `.git` yet | `select_repo` and `repo_clone` only; business tools stay refused until it is a checkout |
| `unknown` | the host cannot report a working directory | Refuse; never fail open |

This is a **relevance filter**, not a security boundary. The Feishu gate,
`select_repo`, and the broker's own authorization still decide what a call may
do. It also does not hide the tools from a session's schema list, and the MCP
child process still starts with the plugin — only a dedicated profile gives you
a session with no trace of the plugin at all.

`mmw_tools_status` is always callable: it is the diagnostic surface that reports
the current `workspace` mode and why the business tools are refused.

| Key | Default | Meaning |
|---|---|---|
| `workspaceGuard.enabled` | on | Set `false` only in a profile dedicated to one repository. |

The legacy `workspaceGuard.allowPaths` and `workspaceGuard.onUnavailable` remain
for hosts that only have the older path-based guard; the registry + remote
decision above does not use them.

## Agent tools

### High-level

| Tool | Purpose |
|---|---|
| `mmw_tools_status` | Auth state, repo binding, `AGENTS.md` drift |
| `mmw_tools_run` | Prepare project context + operating rules; the agent then drives the MCP tools |

### MCP (`mcp__mmw-tools__*`)

| Tool | Purpose |
|---|---|
| `select_repo` | Bind this session to one repository enabled in the auth-core registry. Required before business tools; an unselected session gets `[mmw_route_denied]`, and switching to another repository is refused. It is decided from local session state before the route table, so a lagging role table does not block selection; the registry is refreshed first, then the repository-scoped grants are read, and a member without a `select_repo` role there is refused. It also reads `.dsh-mmw-tools.yaml` through the broker and fails closed if that file is missing or invalid. The registry and rule answer are cached for the next plugin load and per-call MCP use |
| `repo_status` | Branch, dirty flag, HEAD SHA, uncommitted files; credentials in the remote URL are redacted |
| `repo_clone` | Shallow clone of the base branch into `workingDir` |
| `repo_pull` | `git pull --rebase origin <branch>`; refuses a dirty tree |
| `repo_read` | Read one file (100 KiB default, 500 KiB hard cap, refuses binary) |
| `repo_search` | `git grep`, capped results, redacted snippets |
| `repo_edit` | Validate → apply edits atomically → preflight → commit. With a broker write credential, the commit is created by the broker instead (no push) |
| `pr_create` | Open a PR (draft by default; pass `draft: false` to open it ready). With a broker write credential, the broker pushes and opens it |
| `pr_close` | Close a PR without merging it. The branch owner may close their own PR; `operator` / `admin` may close any. The host asks first; already closed or merged returns `already: true` |
| `pr_preview` | Preview URLs from the hosting check, plus check states and draft/merge state; read-only, optionally waits for the deployment |
| `pr_list` | List PRs (titles and bodies redacted) |
| `pr_merge` | Mark a draft ready if needed, then merge. With a broker write credential, first fetch a one-time approval bound to the head SHA, then merge; the broker refuses `agentMerge: false` levels and PRs that change the contract; the host still asks |

When `MMW_BROKER_URL` and a readable write-auth file are present, these four
write tools call the broker's `/v1/write/*` endpoints; otherwise they keep the
local git/`gh` behavior for standalone use.

## Security model

**Guards, applied before any I/O.** Path traversal and symlink escape; allowlist/denylist with deny-over-allow precedence; branch-prefix and base-branch rejection; token-shaped string detection on commit messages, PR titles, PR bodies, and `user_request`; byte caps per file, per commit, and per PR body; `execFile` (no shell) for the pre-flight command.

**Tokens.** The GitHub session lives in `~/.dsh/dsh-mmw-tools-session.json` at mode `0600`, and the one-hour client installation token in `~/.dsh/dsh-mmw-tools-installation.json` (also `0600`) because the MCP child reads it from disk. That client token is always read-only, whether minted from a GitHub session or a Feishu plugin token. Writes use `~/.dsh/dsh-mmw-tools-write-auth.json` (`0600`), which holds the Feishu pluginToken or GitHub sessionToken — never a GitHub write token; the broker keeps that token in memory. The Feishu plugin token lives in `~/.dsh/dsh-mmw-tools-feishu.json` (`0600`). All are masked in every view the agent can read and never written to logs, commit messages, PR bodies, or the audit trail. The panel's revoke wipes the local copies and tells the broker/auth core to drop the session.

**Audit.** `mmw_tools_run` appends `mmw_tools_run_start` / `mmw_tools_run_created` / `refused` events to `~/.dsh/dsh-mmw-tools-audit.jsonl` (mode `0600`, 1 MiB rotation). Every string field is recursively redacted; the request text itself is never logged, only its byte length. A failed audit write warns once and then goes silent — it never blocks work.

**Known trade-offs**, stated rather than hidden:

- When not using the broker's write proxy, `repo_clone` and `pr_create` pass the token on the git command line, so it is briefly visible in the process list. It is never written to `.git/config`: `repo_clone` resets `origin` to the credential-free URL immediately after cloning, and `pr_create` pushes to an explicit URL without `-u`, because `-u <url>` would store that URL — token included — as `branch.<name>.remote`. A future version should use `GIT_ASKPASS` and drop the argv exposure too.
- The broker approval nonce binds the member, PR, and head SHA, and is single-use. It does not prove a human clicked the host prompt: a local process that can read the write-auth file and send HTTP can request the approval and merge by itself. The host `pr_merge` / `pr_close` confirmation is a UI gate, not the security
boundary; closing this needs a host-held secret.
- `repo_edit` matches `find` byte-for-byte. On a Windows checkout with `core.autocrlf` the working tree holds CRLF, so a multi-line `find` written with LF will not match; the edit is refused with `find-not-found` rather than applied half-way. Read the file with `repo_read` first and reuse its exact bytes.
- `preflight` and `bootstrap` commands run through the shell on Windows, because `npm` there is `npm.cmd` and `execFile` does not consult `PATHEXT`. Without this every npm-based pre-flight failed with `ENOENT` on the platform this plugin is mostly used on. The command string comes from your own plugin config, never from the agent.
- `repo_edit`'s `patch` mode is not implemented; use `replace` or `insert`.
- Rate limiting is not implemented.

## Tests

Three layers, split by what they need in order to run rather than by what they
cover. Full rationale in [`docs/TESTING.md`](docs/TESTING.md).

```sh
pnpm check                 # typecheck + namespace + in-process suites + pack contents
cd mcp-server && pnpm test # guard, schema and PR-preview assertions
pnpm test:smoke            # MCP server handshake over real stdio
pnpm test:integration      # the MCP tool bodies against a real git repo
```

| Suite | Covers | Needs |
|---|---|---|
| `tests/skills.test.mjs` | skill catalog and the `race-ops-ops` instructions | — |
| `tests/client-bundle.test.mjs` | `__ModuleLoader__` shape of `lib/client.js` | — |
| `tests/bundle-apply.test.mjs` | `apply()` registration, routes, prompts, disposers, idempotence | — |
| `tests/feishu-gate.test.mjs` | authorization table, gate decisions, token refresh | — |
| `tests/workspace-guard.test.mjs` | workspace relevance, status/`select_repo` exemptions, `repo_clone` bootstrap | — |
| `tests/workspace-mode.test.mjs` | registry + `origin` remote + policy-file marker; managed/unmanaged/mismatch/bootstrap/unknown | — |
| `tests/routes-integration.test.mjs` | real HTTP against the loopback routes | — |
| `tests/mmw-tools-run.test.mjs` | input validation, branch slug, excerpts, redaction, truncation | — |
| `tests/audit.test.mjs` | deep redaction, rotation, failure handling | — |
| `tests/github-app.test.mjs` | installation-token flow and repository access | — |
| `tests/session-store.test.mjs` | credential persistence, masking, clearing | — |
| `tests/broker-client.test.mjs` | broker HTTP client behavior | — |
| `tests/broker-auth.test.mjs` | broker auth handshake, Feishu-first credentials, cache-hit write-auth refresh | — |
| `broker/tests/core.test.mjs` | broker core, read-only client tokens, base-branch contract gate, close ownership | — |
| `broker/tests/server.test.mjs` | broker HTTP surface and `/v1/write/*` routing | — |
| `mcp-server/tests/guard.test.mjs` | every cross-cutting guard | — |
| `mcp-server/tests/tools-list-schema.test.mjs` | all MCP tools registered with usable schemas | — |
| `mcp-server/tests/pr-preview.test.mjs` | PR preview URL and check extraction | — |
| `mcp-server/tests/tools-list.test.mjs` | MCP server starts and advertises its tools | `spawn` |
| `tests/integration-git.test.mjs` | tool bodies against git, incl. `repo_edit` rollback | `git`, `spawn` |

The last two need `child_process.spawn` with piped stdio. Where a sandbox denies
that they print a `SKIP` naming what was not verified and exit `0` — CI runs both
on `ubuntu-latest` and `windows-latest`, so a local skip is not a coverage gap.

## Docs

| Document | Contents |
|---|---|
| [`docs/AUTH-BROKER.md`](docs/AUTH-BROKER.md) | Broker topology, GitHub App setup, the Feishu direct path, the write proxy, threat model, deployment |
| [`docs/PANEL-CONTRACT.md`](docs/PANEL-CONTRACT.md) | The panel's state machine: four phases, action matrix, acceptance checks |
| [`docs/TESTING.md`](docs/TESTING.md) | The three test layers, why two self-skip, how to add a case |
| [`docs/T5-RUNBOOK.md`](docs/T5-RUNBOOK.md) | Step-by-step real round trip against the bound repo: gates, stop conditions, cleanup |
| [`docs/OPERATIONS-SYNC.md`](docs/OPERATIONS-SYNC.md) | Who keeps `AGENTS.md` and the binding in step |
| [`docs/INCREMENT-3-CHECKLIST.md`](docs/INCREMENT-3-CHECKLIST.md) | Per-tool hardening spec |
| [`docs/INCREMENT-3-DESIGN.md`](docs/INCREMENT-3-DESIGN.md) | What the eight MCP tools actually do |
| [`docs/INCREMENT-4-CHECKLIST.md`](docs/INCREMENT-4-CHECKLIST.md) | `mmw_tools_run` contract and why it does not drive an LLM |
| [`docs/INCREMENT-5-DESIGN.md`](docs/INCREMENT-5-DESIGN.md) | Audit events, storage, and deliberate omissions |
| [`docs/INCREMENT-2-VERIFICATION.md`](docs/INCREMENT-2-VERIFICATION.md) | The client-bundle build decisions, checked against DSH source |
| [`docs/PUBLISHING.md`](docs/PUBLISHING.md) | Release checklist and the two distribution channels |
| [`CHANGELOG.md`](CHANGELOG.md) | Per-increment history |
| [`docs/NEXT-STEPS.md`](docs/NEXT-STEPS.md) | What is not built yet, and why each omission is deliberate |

## License

[MIT](LICENSE) © 2026 mmw-devs
