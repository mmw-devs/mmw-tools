# dsh-mmw-tools

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets a DSH agent work inside **one configured GitHub repository** under rules the repository itself publishes: read `AGENTS.md`, edit only allowlisted paths, pass a pre-flight check before every commit, open a pull request, show the hosting preview, and — only after the operator approves — merge it.

Authentication is broker-mediated (GitHub App); no webhook and no public IP on the operator's machine. Merging happens through `pr_merge`, which the host gates behind an explicit confirmation.

```
agent ──▶ mmw_tools_run ──▶ reads AGENTS.md / README.md, returns the operating rules
       ──▶ repo_read / repo_search ──▶ understand the current state
       ──▶ repo_edit ──▶ allowlist check + preflight + commit
       ──▶ pr_create ──▶ push content/* + open the PR
       ──▶ pr_preview ──▶ the preview URL the operator reviews
       ──▶ pr_merge ──▶ merge, after the operator confirms in the UI
```

## Why

Agent-written changes to an operations repository usually fail in one of two ways: the agent edits files it should not touch, or it ships something that the repository's own validation would have rejected. Both are preventable if the rules are machine-checkable and enforced before the write, not after the review.

This plugin takes the rules from the repository's `AGENTS.md` (mirrored into a checked-in binding so it can be enforced without an LLM parse), and enforces them at the tool boundary:

- **Allowlist** — an empty allowlist means nothing is writable.
- **Denylist beats allowlist** — a path matching both is refused.
- **Branch prefix** — a commit lands on `content/*` or it does not land.
- **Pre-flight** — `repo_edit` runs the configured command and rolls the working tree back if it fails.
- **Merge is gated, not automatic.** `pr_merge` asks the operator to confirm in the UI before it runs, and `mergeStateStatus` — GitHub's own verdict — still decides whether merging is allowed.

## What it does not do

- Does not drive an LLM. `mmw_tools_run` prepares context; the DSH agent runs the loop.
- Does not merge without the operator confirming the host's prompt, and never bypasses branch protection.
- Does not push to the base branch.
- Does not work across multiple repositories. One binding per install.
- Does not receive webhooks, and needs no public IP.

## Requirements

| | |
|---|---|
| DSH | `>= 0.1.5-rc.1` |
| Node | `^22.19.0 \|\| >= 24.0.0` (the DSH desktop build ships one) |
| `git` | on `PATH` — both for the install and for the plugin's own clones |
| `gh` | on `PATH` (used by `pr_create` / `pr_list`) |
| GitHub | the operator's account must pass the broker's allowlist: a member of `mmw-devs`, **or** a username listed in the broker's `BROKER_ALLOWED_USERS`. The second path is the reason the plugin exists — an outsider can operate the repo without joining the org |
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

Then open **Settings → MMW Tools** and press **登录 GitHub**.
Then open **Settings → MMW Tools 授权** and press **使用飞书登录**; the gate
denies every business tool until that login completes (`mmw_tools_status` is
the exception).

### Which profile to install into

A DSH **profile** is the unit of plugin scope — there is no per-workspace
plugin scope. A plugin installed into a profile is loaded in **every**
workspace that profile hosts, and it is the plugin's tools that appear in
those sessions. One plugin, one repository, one binding: give this plugin a
profile of its own.

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
```

| Field | Meaning |
|---|---|
| `feishu.enabled` | Enforce the Feishu role gate at call time. Default off; the shipped file turns it on. |
| `feishu.authServiceUrl` | Auth core origin. Env `MMW_TOOLS_AUTH_URL` wins. |
| `feishu.gateScope` | `mmw-tools` (default) gates only this plugin's tools; `session` makes the gate an exclusive allowlist for the whole session. See **Scope of the Feishu gate**. |
| `workingDir` | Where `repo_clone` puts the checkout and where `mmw_tools_run` reads `AGENTS.md`. Falls back to `GHOST_WORKING_DIR`. |
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
| **登录 GitHub** | Starts the broker login and opens the verification page |
| **重新获取仓库权限** | Re-checks the broker's repository access |
| **退出登录** | Revokes the broker session and clears the local session |

**Settings → MMW Tools 授权** (Feishu):

| Control | Effect |
|---|---|
| **使用飞书登录** | Opens the auth core, then polls until the browser completes |
| **退出飞书** | Revokes the plugin token and clears `~/.dsh/dsh-mmw-tools-feishu.json` |

The panels are plain React with inline styles; `lib/client.js` registers both
sections through the DSH web `__ModuleLoader__` factory contract.

## Feishu authorization

The tool catalog is tool-centric: each tool declares `roles` and
`requiredPermissions`; there is no role → permission table. `race-ops` is one
atomic tool, so a role that can consume it can call its operations; `pr_merge`
keeps the host confirmation as the final protection. `mmw-tools-status` is
`always: true`.

At call time the plugin:

1. maps `mcp__mmw-tools__*` / `mmw_tools_*` to the parent tool;
2. fetches `GET /v1/agent/routes` (60 s cache, plugin token from
   `~/.dsh/dsh-mmw-tools-feishu.json`);
3. allows the call if `allowedOperations` contains the operation id, or
   `allowed` contains the parent tool;
4. otherwise returns `mmw_route_denied`;
5. for `pr_merge`, only after the policy check, asks the operator.

With `feishu.enabled: true`, a missing/expired token denies business tools.
`mmw_tools_status` remains callable so the agent can report why.

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

### Scope of the tools: the workspace guard

A plugin is loaded per **profile**; a workspace is a **session** inside it. One
profile hosts every workspace, so being installed is not the same as being
relevant. The workspace guard closes that gap: a call is served only when the
*calling session's* working directory is inside the bound repository's
checkout.

It reads that directory from the host's `workingDirectory` service —
synchronously, with no filesystem I/O — through the `agent` carried by every
`tools/pre-execute` execution. Because it is evaluated **per call**, a
`cd` in or out of the repository takes effect immediately; a profile or a
launch flag could never express that, which is why this is a runtime guard and
not a second profile.

In a session opened anywhere else, the eleven tools answer:

```
mmw-tools 只在绑定仓库的工作区可用（当前会话目录：…；允许：…）
```

instead of an auth error or a repository error, and the host's own tools —
`read`, `pwsh`, `glob`, … — are untouched, as always.

| Key | Default | Meaning |
|---|---|---|
| `workspaceGuard.enabled` | on | Set `false` only in a profile dedicated to this repository. |
| `workspaceGuard.allowPaths` | `[]` | Extra roots, **added** to the checkout derived from `workingDir` / `~/.dsh/workspaces/<owner>/<name>`. The path is never duplicated in the config file. |
| `workspaceGuard.onUnavailable` | `allow` | When the host exposes no working directory. `deny` refuses the tools instead — for an installation that must never run outside its own profile. |

The guard is a relevance filter, not a security boundary: the Feishu gate and
the repository sandbox still decide what a call may do. It also does not hide
the tools from a session's schema list, and the MCP child process still starts
with the plugin — only a dedicated profile gives you a session with no trace of
the plugin at all.

## Agent tools

### High-level

| Tool | Purpose |
|---|---|
| `mmw_tools_status` | Auth state, repo binding, `AGENTS.md` drift |
| `mmw_tools_run` | Prepare project context + operating rules; the agent then drives the MCP tools |

### MCP (`mcp__mmw-tools__*`)

| Tool | Purpose |
|---|---|
| `repo_status` | Branch, dirty flag, HEAD SHA, uncommitted files |
| `repo_clone` | Shallow clone of the base branch into `workingDir` |
| `repo_pull` | `git pull --rebase origin <branch>`; refuses a dirty tree |
| `repo_read` | Read one file (100 KiB default, 500 KiB hard cap, refuses binary) |
| `repo_search` | `git grep`, capped results, redacted snippets |
| `repo_edit` | Validate → apply edits atomically → preflight → commit (no push) |
| `pr_create` | Push the branch and open a PR (draft by default; pass `draft: false` to open it ready) |
| `pr_preview` | Preview URLs from the hosting check, plus check states and draft/merge state; read-only, optionally waits for the deployment |
| `pr_list` | List PRs (titles and bodies redacted) |
| `pr_merge` | Mark a draft ready if needed, then merge — only after the host's confirmation prompt |

## Security model

**Guards, applied before any I/O.** Path traversal and symlink escape; allowlist/denylist with deny-over-allow precedence; branch-prefix and base-branch rejection; token-shaped string detection on commit messages, PR titles, PR bodies, and `user_request`; byte caps per file, per commit, and per PR body; `execFile` (no shell) for the pre-flight command.

**Tokens.** The GitHub session lives in `~/.dsh/dsh-mmw-tools-session.json` at mode `0600`, and the one-hour installation token in `~/.dsh/dsh-mmw-tools-installation.json` (also `0600`) because the MCP child reads it from disk. The Feishu plugin token lives in `~/.dsh/dsh-mmw-tools-feishu.json` (`0600`). All are masked in every view the agent can read and never written to logs, commit messages, PR bodies, or the audit trail. The panel's revoke wipes the local copies and tells the broker/auth core to drop the session.

**Audit.** `mmw_tools_run` appends `mmw_tools_run_start` / `mmw_tools_run_created` / `refused` events to `~/.dsh/dsh-mmw-tools-audit.jsonl` (mode `0600`, 1 MiB rotation). Every string field is recursively redacted; the request text itself is never logged, only its byte length. A failed audit write warns once and then goes silent — it never blocks work.

**Known trade-offs**, stated rather than hidden:

- `repo_clone` and `pr_create` pass the token on the git command line, so it is briefly visible in the process list. It is never written to `.git/config`: `repo_clone` resets `origin` to the credential-free URL immediately after cloning, and `pr_create` pushes to an explicit URL without `-u`, because `-u <url>` would store that URL — token included — as `branch.<name>.remote`. A future version should use `GIT_ASKPASS` and drop the argv exposure too.
- `repo_edit` matches `find` byte-for-byte. On a Windows checkout with `core.autocrlf` the working tree holds CRLF, so a multi-line `find` written with LF will not match; the edit is refused with `find-not-found` rather than applied half-way. Read the file with `repo_read` first and reuse its exact bytes.
- `preflight` and `bootstrap` commands run through the shell on Windows, because `npm` there is `npm.cmd` and `execFile` does not consult `PATHEXT`. Without this every npm-based pre-flight failed with `ENOENT` on the platform this plugin is mostly used on. The command string comes from your own plugin config, never from the agent.
- `repo_edit`'s `patch` mode is not implemented; use `replace` or `insert`.
- Rate limiting is not implemented.

## Tests

Three layers, split by what they need in order to run rather than by what they
cover. Full rationale in [`docs/TESTING.md`](docs/TESTING.md).

```sh
pnpm check                 # typecheck + namespace + 177 assertions + pack contents
cd mcp-server && pnpm test # 44 guard + 11 schema assertions
pnpm test:smoke            # MCP server handshake over real stdio
pnpm test:integration      # the eight tool bodies against a real git repo
```

| Suite | Asserts | Needs |
|---|---|---|
| `tests/token-store.test.mjs` | 25 · persistence, masking, clear | — |
| `tests/client-bundle.test.mjs` | 16 · `__ModuleLoader__` shape of `lib/client.js` | — |
| `tests/bundle-apply.test.mjs` | 36 · `apply()` registers 6 tools, 5 routes, 1 section; idempotence | — |
| `tests/routes-integration.test.mjs` | 26 · real HTTP against the five loopback routes | — |
| `tests/mmw-tools-run.test.mjs` | 37 · input validation, branch slug, excerpts, redaction, truncation | — |
| `tests/audit.test.mjs` | 29 · deep redaction, rotation, failure handling | — |
| `mcp-server/tests/guard.test.mjs` | 44 · every cross-cutting guard | — |
| `mcp-server/tests/tools-list-schema.test.mjs` | 11 · all eight tools registered | — |
| `mcp-server/tests/tools-list.test.mjs` | MCP server starts and advertises 8 tools | `spawn` |
| `tests/integration-git.test.mjs` | tool bodies against git, incl. `repo_edit` rollback | `git`, `spawn` |

The last two need `child_process.spawn` with piped stdio. Where a sandbox denies
that they print a `SKIP` naming what was not verified and exit `0` — CI runs both
on `ubuntu-latest` and `windows-latest`, so a local skip is not a coverage gap.

## Docs

| Document | Contents |
|---|---|
| [`docs/AUTH-BROKER.md`](docs/AUTH-BROKER.md) | Broker topology, GitHub App setup, threat model, deployment, ICP blocker |
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
