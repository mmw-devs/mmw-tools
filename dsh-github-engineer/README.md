# dsh-github-engineer

> **Skeleton status: v0.1.0**. The bundle mounts, exposes one agent
> tool (`engineer_status`) and one MCP probe tool
> (`mcp__github_engineer__echo`). Real OAuth, repo access, AGENTS.md
> auto-load, and the `engineer_run` wrapper land in subsequent
> increments per [`docs/dsh-github-engineer-design.md`](../dsh-github-engineer-design.md).

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
- ✅ Re-publishes MCP `tools/list` as `mcp__github_engineer__*` agents tools
- ✅ `engineer_status` reports plugin state
- 🚧 OAuth Device Flow state machine
- 🚧 Token store (OS keychain / DSH encrypted storage)
- 🚧 Web settings panel
- 🚧 `repo_clone` / `repo_read` / `repo_search` / `repo_edit` / `pr_create` / `pr_list`
- 🚧 `engineer_run` high-level wrapper
- 🚧 AGENTS.md auto-load + allowlist/denylist hard guards
- 🚧 `npm run validate` pre-flight

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
The MCP probe tool `mcp__github_engineer__echo` should also appear.

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

## Smoke test

```sh
pnpm exec node tests/smoke.mjs
```

Spawns the MCP server directly, lists its tools, calls `echo`, and
checks the response.

## License

MIT