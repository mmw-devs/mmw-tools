# Next Steps

Nothing is blocked. Everything below is deliberately out of scope for
`v0.6.0`, not unfinished work.

## Shipped

| Version | Increment | What landed |
|---|---|---|
| 0.1.0 | skeleton | bundle + `cordis.patch.yml` + MCP probe + namespace check |
| 0.2.0 | 1 | OAuth Device Flow, token store, five loopback routes |
| 0.3.0 | 2 | Settings web panel (`__ModuleLoader__` client bundle) |
| 0.4.0 | 3 | eight MCP tools + cross-cutting guards |
| 0.5.0 | 4 | `engineer_run` bootstrap wrapper |
| 0.6.0 | 5 | JSONL audit trail + redacting logger |
| 0.6.0 | 6 | LICENSE, CHANGELOG, publishing docs, v0.6.0 tag |

## Deliberately absent

### `repo_edit` patch mode

The schema accepts `mode: "patch"` but the implementation refuses it
with `patch-not-implemented-v1`. Supporting it means writing the diff
to a temp file and running `git apply --3way`, then reconciling the
result with the allowlist. `replace` and `insert` cover the
`public/data.json` workflow the plugin was built for.

### Rate limiting

A per-tool token bucket (e.g. 10 calls / 10 s / process) would stop a
runaway agent loop. It is in-process only, so it cannot bound several
DSH instances hitting the same repository. Deferred until there is a
reason to expect that.

### A merge tool

Intentional. `ffxiv-race-ops` requires CI plus human review before
`main`, and the whole point of the guard set is that the agent cannot
skip that. Adding `pr_merge` would mean re-implementing the policy it
is supposed to respect.

### Multiple repositories

One binding per install. A second repository means a second install
with its own `cordis.patch.yml`. A multi-repo binding would need a
per-repository guard table, and the current `repoBinding` was shaped
to be a single object on purpose.

### GitHub App authentication

`race-ops-bot`-style App credentials were explicitly out of scope:
they existed to filter access on the old server-hosted deployment,
and a plugin that runs on the user's own machine does not need them.

### Domain skills

`update-team` / `add-news` / `add-broadcaster` from the old `.pi/`
agent were also out of scope. The agent plus `AGENTS.md` plus the
guarded tools cover those flows without shipping repository-specific
code.

### DSH session-log integration

The audit trail writes its own JSONL file because there is no stable
plugin-facing API for the DSH session log. If one appears, the events
in `src/util/audit.ts` are already structured for it.

### `git+https://` install

`dsh plugin add git+…` does not run a build, and `lib/` plus
`mcp-server/dist/` are gitignored. npm and `link:` installs work
today. See [`PUBLISHING.md`](PUBLISHING.md) for the trade-off and the
one-line change that enables git installs.

## If you extend this

1. Read the increment document for the area you are touching
   (`INCREMENT-3-*` for MCP tools, `INCREMENT-4-*` for `engineer_run`,
   `INCREMENT-5-DESIGN.md` for audit).
2. Add the guard before the tool. Every tool in `mcp-server/src/tools/`
   runs its guards before any I/O, and `guard.test.mjs` is the spec
   for what those guards promise.
3. Run `pnpm check` and `cd mcp-server && pnpm test`. Neither needs
   network access.
4. If you rename the plugin, edit `src/const.ts` first, then
   `cordis.patch.yml`, both `package.json` files, and
   `mcp-server/src/const.ts`, then run
   `node scripts/check-namespace-consistency.mjs`.
