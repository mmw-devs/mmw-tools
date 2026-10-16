# dsh-github-engineer

> **Status: v0.2.0 (OAuth complete)**. Bundle mounts, exposes six
> agent tools (`engineer_status` + 4 OAuth tools + the MCP probe
> `mcp__github-engineer__echo`). Repo access, AGENTS.md auto-load,
> and the `engineer_run` wrapper land in subsequent increments per
> [`docs/NEXT-STEPS.md`](docs/NEXT-STEPS.md).

DeepSeek Harness plugin: connects the DSH agent to a **single configured
GitHub repository** via personal OAuth Device Flow, lets it read
`AGENTS.md` and the project tree, apply changes under an allowlist,
run a pre-flight `npm run validate`, push to a `content/*` branch, and
open a **draft** PR (no auto-merge).

## Status

- ✅ Bundle mounts under DSH 0.1.5+
- ✅ `cordis.patch.yml` injects `repoBinding` + `githubOAuthClientId`
- ✅ GitHub OAuth App registered (Device Flow enabled, Client ID pre-filled)
- ✅ Spawns MCP server as a stdio child
- ✅ Re-publishes MCP `tools/list` as `mcp__github-engineer__*` agents tools
- ✅ OAuth Device Flow state machine + token store (incremental `v0.2.0`)
- ✅ 4 loopback HTTP routes (`/api/github-engineer/{status,oauth/start,oauth/finish,oauth/refresh,revoke}`)
- ✅ AGENTS.md drift detection at bundle apply
- ✅ Plugin-namespace consistency CI check (`pnpm check`)
- 🚧 Web settings panel (React UI)
- 🚧 `repo_clone` / `repo_read` / `repo_search` / `repo_edit` / `pr_create` / `pr_list`
- 🚧 `engineer_run` high-level wrapper
- 🚧 Real pre-flight enforcement (`npm run validate`)

## Agent tools

| Tool | Purpose |
|---|---|
| `engineer_status` | Public state: auth status, repo binding, AGENTS.md drift |
| `engineer_oauth_start` | Begin Device Flow, return user_code + verification_uri |
| `engineer_oauth_finish` | Poll once for the user's authorization result |
| `engineer_oauth_refresh` | Force-refresh the access token (auto-refresh runs every 60s) |
| `engineer_oauth_revoke` | Wipe local credentials (revoke on GitHub side is separate) |
| `mcp__github-engineer__echo` | Probe tool; replaced by real repo tools in the next increment |

## Install (development)

```sh
git clone <this-repo>
pnpm install
pnpm --filter mcp-server build
pnpm --filter . build
dsh plugin --profile web add link:/path/to/dsh-github-engineer
# restart dsh web
```

In a DSH conversation, ask the agent to call `engineer_status` — it
should report `dsh-github-engineer 已挂载` and the bound repository.
Then drive the OAuth flow per [`docs/OAUTH-FLOW.md`](docs/OAUTH-FLOW.md).

## Configure

The bundled [`cordis.patch.yml`](cordis.patch.yml) ships with:

- `githubOAuthClientId` pre-filled with this repo's OAuth App
  (Device Flow enabled). Reuse it as-is, or replace with your own
  per [`docs/github-oauth-app-checklist.md`](../github-oauth-app-checklist.md).
- `repoBinding` hard-bound to `mmw-devs/ffxiv-race-ops`. Adjust
  `owner`/`name` and the `allowlistPaths`/`denylistPaths` to point at
  a different repo.
- `defaultScopes: [repo, workflow, offline_access]` — the minimum
  scopes the plugin needs.

## Tests

```sh
pnpm exec node tests/smoke.mjs          # MCP server end-to-end
pnpm exec node tests/token-store.test.mjs  # token store unit tests
pnpm check                              # typecheck + namespace consistency
```

## License

MIT