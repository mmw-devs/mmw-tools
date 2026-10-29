# dsh-mmw-tools

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets a DSH agent work inside **one configured GitHub repository** under rules the repository itself publishes: read `AGENTS.md`, edit only allowlisted paths, pass a pre-flight check before every commit, and open a **draft** pull request that CI and a human still have to approve.

Personal OAuth Device Flow only. No GitHub App, no server, no webhook, no auto-merge.

```
agent ──▶ mmw_tools_run ──▶ reads AGENTS.md / README.md, returns the operating rules
       ──▶ repo_read / repo_search ──▶ understand the current state
       ──▶ repo_edit ──▶ allowlist check + preflight + commit
       ──▶ pr_create ──▶ push content/* + open draft PR
```

## Why

Agent-written changes to an operations repository usually fail in one of two ways: the agent edits files it should not touch, or it ships something that the repository's own validation would have rejected. Both are preventable if the rules are machine-checkable and enforced before the write, not after the review.

This plugin takes the rules from the repository's `AGENTS.md` (mirrored into a checked-in binding so it can be enforced without an LLM parse), and enforces them at the tool boundary:

- **Allowlist** — an empty allowlist means nothing is writable.
- **Denylist beats allowlist** — a path matching both is refused.
- **Branch prefix** — a commit lands on `content/*` or it does not land.
- **Pre-flight** — `repo_edit` runs the configured command and rolls the working tree back if it fails.
- **No merge tool exists.** Merging is CI's and a human's job.

## What it does not do

- Does not drive an LLM. `mmw_tools_run` prepares context; the DSH agent runs the loop.
- Does not merge PRs. There is no merge tool.
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
| GitHub | the operator's account must pass the broker's allowlist (default: an active member of `mmw-devs`) |
| Network | `https://race-ops-broker.mmw-team.icu` reachable |

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
githubOAuthClientId: "Ov23li…"      # your OAuth App's Client ID (Device Flow on)
defaultScopes: [repo, workflow, offline_access]
workingDir: ~/.dsh/workspaces/you/your-repo   # where the clone lives
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
| `githubOAuthClientId` | Public identifier of your OAuth App. Not a secret. |
| `defaultScopes` | `repo` is required; `offline_access` is needed for auto-refresh. |
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

**Settings → MMW Tools**:

| Control | Effect |
|---|---|
| **Connect GitHub** | Starts Device Flow, shows `user_code` + `verification_uri` in the panel |
| **I already authorized** | Polls for the authorization result (up to ~2 min) |
| **Refresh** | Forces an access-token refresh |
| **Revoke** | Wipes `~/.dsh/dsh-mmw-tools.json` |

Status line shows the login, granted scopes, and the remaining lifetime of the access token. The panel is plain React with inline styles; `lib/client.js` registers itself through the DSH web `__ModuleLoader__` factory contract.

## Agent tools

### High-level

| Tool | Purpose |
|---|---|
| `mmw_tools_status` | Auth state, repo binding, `AGENTS.md` drift |
| `engineer_oauth_start` | Begin Device Flow; returns `user_code` + `verification_uri` |
| `engineer_oauth_finish` | Poll once for the authorization result |
| `engineer_oauth_refresh` | Force a refresh (a 60 s watchdog also refreshes automatically) |
| `engineer_oauth_revoke` | Wipe local credentials |
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
| `pr_create` | Push the branch and open a **draft** PR |
| `pr_list` | List PRs (titles and bodies redacted) |

## Security model

**Guards, applied before any I/O.** Path traversal and symlink escape; allowlist/denylist with deny-over-allow precedence; branch-prefix and base-branch rejection; token-shaped string detection on commit messages, PR titles, PR bodies, and `user_request`; byte caps per file, per commit, and per PR body; `execFile` (no shell) for the pre-flight command.

**Tokens.** Stored in `~/.dsh/dsh-mmw-tools.json` at mode `0600`; masked in every view the agent can read; never written to logs, commit messages, PR bodies, or the audit trail. `engineer_oauth_revoke` wipes the local copy — revoking the grant on GitHub's side is a separate step.

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
