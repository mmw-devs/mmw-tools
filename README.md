# mmw-tools

Tooling for the mmw-devs operation repos. Two deliverables:

- **`dsh-mmw-tools/`** — a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
  plugin that lets a DSH agent work inside a single configured GitHub repository under
  the rules that repository publishes in its own `AGENTS.md` — read, edit only
  allowlisted paths, pass a pre-flight check before every commit, open a **draft** PR.
  No auto-merge.
- **`mmw-tools-auth/`** — the Feishu H5 authorization core. It owns members, roles,
  and the `allowed` tool set the plugin checks on every tool call.

```text
dsh-mmw-tools/     the plugin (bundle + stdio MCP server)
mmw-tools-auth/          Feishu auth core + agent route table
contracts/               shared tool catalog / roles / golden route tables
```

## The plugin

**`dsh-mmw-tools`** — broker-backed GitHub App auth, the MCP tools, two native
tools (`mmw_tools_status`, `mmw_tools_run`), a Settings panel, and a hardened
tool boundary. Version and scripts live in
[`dsh-mmw-tools/package.json`](dsh-mmw-tools/package.json). Full description,
configuration, and security model:
[`dsh-mmw-tools/README.md`](dsh-mmw-tools/README.md).

```sh
cd dsh-mmw-tools
pnpm install
pnpm --filter dsh-mmw-tools-mcp build
pnpm build:all
dsh plugin --profile web add link:$PWD
# restart `dsh web`
```

Then open **Settings → MMW Tools** and press **Connect GitHub**.

## The auth core

**`mmw-tools-auth` Phase 1 MVP** — Feishu OAuth (PKCE), members/roles, plugin tokens,
and `GET /v1/agent/routes`. The plugin does not mount or unmount tools based on these
routes; it registers all tools statically and checks the `allowed` set on every call.

```sh
cd mmw-tools-auth
cp .env.example .env
node --env-file=.env src/main.mjs   # http://127.0.0.1:4326
node tests/run.mjs                  # auth-core test suite
```

Configuration, bootstrap-admin flow, endpoints, and limitations:
[`mmw-tools-auth/README.md`](mmw-tools-auth/README.md). Deployment steps are in
[`mmw-tools-auth/deploy/README.md`](mmw-tools-auth/deploy/README.md).

**Deployment:** host layout, TLS, and verification steps are in
[`mmw-tools-auth/deploy/README.md`](mmw-tools-auth/deploy/README.md). The auth
core listens on loopback only; nginx terminates TLS.

## First customer: [`mmw-devs/ffxiv-race-ops`](https://github.com/mmw-devs/ffxiv-race-ops)

The plugin is built around that repository's `AGENTS.md` contract:

- **Only** `public/data.json` may be modified.
- Branches use the `content/*` prefix — direct pushes to `main` are refused.
- `npm run validate` must pass before a commit lands.
- The PR opens as a draft; merging happens on GitHub after CI and human review.

The binding mirrors those rules into `dsh-mmw-tools/cordis.patch.yml` so they can
be enforced without parsing Markdown. That duplication is deliberate and documented:
see [`docs/OPERATIONS-SYNC.md`](dsh-mmw-tools/docs/OPERATIONS-SYNC.md).

## Layout

| Path | What |
|---|---|
| `AGENTS.md` | Agent procedure: run the document-impact check and update documents in the same change. |
| `docs/doc-map.json` | Document-to-source map used by the impact check. |
| `dsh-mmw-tools/` | The plugin: DSH bundle, stdio MCP server, Settings panel, tests. |
| `mmw-tools-auth/` | Feishu H5 authorization core: OAuth, members, roles, plugin tokens, route table. See [`mmw-tools-auth/README.md`](mmw-tools-auth/README.md). |
| `mmw-tools-auth/deploy/` | systemd/nginx/TLS install, verified SQLite snapshots, health timer, rollback. See [`deploy/README.md`](mmw-tools-auth/deploy/README.md). |
| `dsh-mmw-tools/README.md` | Plugin README — install, configure, tools, security model. |
| `dsh-mmw-tools/CHANGELOG.md` | Per-increment history. |
| `dsh-mmw-tools/docs/` | OAuth walkthrough, operations sync, per-increment design records, release checklist. |
| `dsh-mmw-tools-design.md` | Architecture and business-logic design (v2, aligned to the `ffxiv-race-ops` `AGENTS.md`). |
| `contracts/` | Shared tool catalog, roles, route-table schema, and golden examples. See [`contracts/README.md`](contracts/README.md). Current role/operation matrix: [`contracts/REFERENCE.md`](contracts/REFERENCE.md) (generated). |
| `scripts/check-contracts.mjs` | Validates the catalog, regenerates the golden route tables and `contracts/REFERENCE.md`. |
| `scripts/check-docs.mjs` | Rejects stale identifiers in living docs and missing status labels on long-lived docs. See [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md). |
| `scripts/doc-impact.mjs` | Maps changed source files to the documents that define them; fails when the document was not updated. |
| `docs/OBSERVABILITY.md` | Run ids, audit events, and why trace storage is a bounded JSONL file rather than a collector. |
| `scripts/prune-merged-branches.mjs` | Deletes remote branches only after every dependency and retention check passes. |
| `mmw-tools-routing-layer-plan.md` | Feature-routing plan centered on Feishu H5 auth: the auth core owns the catalog and policy; the DSH plugin registers tools statically and authorizes each call. |
| `mmw-tools-routing-state-machine.md` | Auth, policy, transport, and tool-call state machines for static registration plus call-time authorization. |
| `dsh-plugin-api-cheatsheet.md` | DSH 0.1.5 plugin API reference, distilled from `zhengjy01/dsh-feishu-mcp` and checked against DSH source. |
| `github-oauth-app-checklist.md` | GitHub OAuth App registration with Device Flow enabled. |
| `lark-vs-dsh.md` | Research notes: DSH's Feishu-related plugins vs. the official `lark-cli`. |

## Tool contract

`contracts/tools.json` is the shared tool catalog between the Feishu authorization
core and the DSH plugin. It defines each tool's `roles`, `requiredPermissions`,
operations, and `risk`. The core owns the catalog; the plugin implements every
operation statically and checks the core's `allowed` / `allowedOperations` on each
call.

There is no role → permission table: roles decide who may consume a tool;
`requiredPermissions` describes what the tool itself needs.

```sh
node scripts/check-contracts.mjs
node scripts/check-contracts.mjs --update   # after an intentional catalog change
node scripts/check-docs.mjs
```

The golden route tables live in `contracts/examples/`; the human-readable matrix
is `contracts/REFERENCE.md`, both generated. Do not hand-edit either. See
[`contracts/README.md`](contracts/README.md) for the v2 model, the
[`ERRORS.md`](contracts/ERRORS.md) for stable error codes, and
[`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md) for which document is
authoritative.

## Documentation

[`AGENTS.md`](AGENTS.md) is the operating procedure; [`docs/doc-map.json`](docs/doc-map.json)
says what each document defines and which source changes require touching it.
Before committing:

```sh
node scripts/doc-impact.mjs --base origin/main --worktree
```

CI runs the same check against the pull request base, so a source change whose
document is untouched fails the build. Regenerate the table in `AGENTS.md` after
editing the map:

```sh
node scripts/doc-impact.mjs --write-agents
```

## Branch cleanup

`scripts/prune-merged-branches.mjs` deletes a remote branch only when all of these
are true: its PR is merged, it has no commits outside the base branch, no open PR
uses it as head or base, it is unprotected, no workflow/config references it, and
the merge is older than the retention window (7 days by default). The script is a
dry run unless `--apply` is passed, and unknown/unreadable signals keep the branch.

```sh
GITHUB_TOKEN="$(gh auth token)" node scripts/prune-merged-branches.mjs
GITHUB_TOKEN="$(gh auth token)" node scripts/prune-merged-branches.mjs --apply
node --test scripts/prune-merged-branches.test.mjs
```

`.github/workflows/branch-cleanup.yml` runs weekly with `--apply`; manual runs
default to a dry run. Add long-lived exceptions with `--keep <pattern>`.

## Verify

```sh
node scripts/check-contracts.mjs
node scripts/check-docs.mjs
node scripts/doc-impact.mjs --base origin/main
node --test scripts/doc-impact.test.mjs
node mmw-tools-auth/tests/run.mjs
node --test scripts/prune-merged-branches.test.mjs
cd dsh-mmw-tools
pnpm check                    # typecheck, namespace, and the full test suite
cd mcp-server && pnpm test    # MCP guard and schema suites
```

## License

MIT © 2026 mmw-devs. See [`dsh-mmw-tools/LICENSE`](dsh-mmw-tools/LICENSE).
