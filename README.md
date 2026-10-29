# mmw-tools

Tooling for the mmw-devs operation repos. Currently one deliverable: a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets a
DSH agent work inside a single configured GitHub repository under the rules that
repository publishes in its own `AGENTS.md` — read, edit only allowlisted paths, pass a
pre-flight check before every commit, open a **draft** PR. No auto-merge.

```
dsh-mmw-tools/     the plugin (bundle + stdio MCP server)
```

## The plugin

**`dsh-mmw-tools` v0.6.0** — personal OAuth Device Flow, eight MCP tools, a
Settings panel, and a hardened tool boundary. Full description, configuration, and
security model: [`dsh-mmw-tools/README.md`](dsh-mmw-tools/README.md).

```sh
cd dsh-mmw-tools
pnpm install
pnpm --filter dsh-mmw-tools-mcp build
pnpm build:all
dsh plugin --profile web add link:$PWD
# restart `dsh web`
```

Then open **Settings → MMW Tools** and press **Connect GitHub**.

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
| `dsh-mmw-tools/README.md` | Plugin README — install, configure, tools, security model. |
| `dsh-mmw-tools/CHANGELOG.md` | Per-increment history. |
| `dsh-mmw-tools/docs/` | OAuth walkthrough, operations sync, per-increment design records, release checklist. |
| `dsh-mmw-tools-design.md` | Architecture and business-logic design (v2, aligned to the `ffxiv-race-ops` `AGENTS.md`). |
| `dsh-plugin-api-cheatsheet.md` | DSH 0.1.5 plugin API reference, distilled from `zhengjy01/dsh-feishu-mcp` and checked against DSH source. |
| `github-oauth-app-checklist.md` | GitHub OAuth App registration with Device Flow enabled. |
| `lark-vs-dsh.md` | Research notes: DSH's Feishu-related plugins vs. the official `lark-cli`. |

## Verify

```sh
cd dsh-mmw-tools
pnpm check                    # typecheck + namespace + 177 assertions
cd mcp-server && pnpm test    # 44 guard + 11 schema assertions
```

## License

MIT © 2026 mmw-devs. See [`dsh-mmw-tools/LICENSE`](dsh-mmw-tools/LICENSE).
