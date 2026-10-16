# mmw-tools

DSH plugin: connect a DeepSeek Harness agent to a single GitHub repo via
OAuth Device Flow, follow `AGENTS.md`, edit only the allowlisted paths,
run a pre-flight `npm run validate`, push to `content/*` branches, and
open **draft** PRs (no auto-merge).

## First customer: [`mmw-devs/ffxiv-race-ops`](https://github.com/mmw-devs/ffxiv-race-ops)

The plugin is built to honor the operation contract documented in that
repository's `AGENTS.md`:

- **Only** `public/data.json` may be modified.
- Branches must use the `content/*` prefix — direct pushes to `main`
  are rejected by the plugin.
- A `npm run validate` pre-flight must pass before any push.
- The PR opens as draft; merging happens on GitHub after CI and human
  review.

## Layout

| Path | What |
|---|---|
| `dsh-github-engineer/` | The DSH bundle + its stdio MCP server (the actual plugin code). |
| `dsh-github-engineer-design.md` | Architecture + business-logic design (v2, aligned to the `ffxiv-race-ops` AGENTS.md). |
| `dsh-plugin-api-cheatsheet.md` | DSH 0.1.5 plugin API quick reference, distilled from `zhengjy01/dsh-feishu-mcp`. |
| `github-oauth-app-checklist.md` | Step-by-step GitHub OAuth App registration with Device Flow enabled. |
| `lark-vs-dsh.md` | Comparative notes on DSH's Feishu-related plugins vs. the official `lark-cli`. |

## Plugin status

**Skeleton v0.1.0** — the bundle mounts, exposes one agent tool
(`engineer_status`) and one MCP probe tool (`mcp__github_engineer__echo`).
Real OAuth, repo access, AGENTS.md auto-load, and the `engineer_run`
wrapper land in subsequent increments per
[`dsh-github-engineer/docs/NEXT-STEPS.md`](dsh-github-engineer/docs/NEXT-STEPS.md).

## Install (development)

```sh
cd dsh-github-engineer
pnpm install
pnpm --filter mcp-server build
pnpm --filter . build

dsh plugin --profile web add link:/path/to/mmw-tools/dsh-github-engineer
# restart dsh web
```

Then in a DSH conversation, ask the agent to call `engineer_status`.

## License

MIT (see each subdirectory for license files).