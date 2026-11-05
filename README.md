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

**`dsh-mmw-tools` v0.10.0** — broker-backed GitHub App auth, ten MCP tools plus two
native tools (`mmw_tools_status`, `mmw_tools_run`), a Settings panel, and a
hardened tool boundary. Full description, configuration, and security model:
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
node tests/run.mjs                  # 13 mock-Feishu tests
```

Configuration, bootstrap-admin flow, endpoints, and limitations:
[`mmw-tools-auth/README.md`](mmw-tools-auth/README.md). Deployment steps are in
[`mmw-tools-auth/deploy/README.md`](mmw-tools-auth/deploy/README.md).

**Deployed:** `https://mmw-tools.mmw-team.icu` — `/health` returns
`{"ok":true,"contractVersion":2,...}`; `api/me` and `/v1/agent/routes` return 401
without a token. The initial admin (`weunimix`) is configured; the one-time
bootstrap token has been removed.

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
| `dsh-mmw-tools/` | The plugin: DSH bundle, stdio MCP server, Settings panel, tests. |
| `mmw-tools-auth/` | Feishu H5 authorization core: OAuth, members, roles, plugin tokens, route table. See [`mmw-tools-auth/README.md`](mmw-tools-auth/README.md). |
| `dsh-mmw-tools/README.md` | Plugin README — install, configure, tools, security model. |
| `dsh-mmw-tools/CHANGELOG.md` | Per-increment history. |
| `dsh-mmw-tools/docs/` | OAuth walkthrough, operations sync, per-increment design records, release checklist. |
| `dsh-mmw-tools-design.md` | Architecture and business-logic design (v2, aligned to the `ffxiv-race-ops` `AGENTS.md`). |
| `contracts/` | Shared tool catalog, roles, route-table schema, and golden examples. See [`contracts/README.md`](contracts/README.md). |
| `scripts/check-contracts.mjs` | Validates the catalog and regenerates the golden route tables. |
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
```

The golden route tables live in `contracts/examples/`. See
[`contracts/README.md`](contracts/README.md) for the v2 model and the
[`ERRORS.md`](contracts/ERRORS.md) for stable error codes.

## Verify

```sh
node scripts/check-contracts.mjs
node mmw-tools-auth/tests/run.mjs   # 13 auth-core assertions
cd dsh-mmw-tools
pnpm check                    # typecheck + namespace + 177 assertions
cd mcp-server && pnpm test    # 44 guard + 11 schema assertions
```

## License

MIT © 2026 mmw-devs. See [`dsh-mmw-tools/LICENSE`](dsh-mmw-tools/LICENSE).
