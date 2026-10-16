# Next Steps

## Current state (v0.3.0)

✅ Settings web panel complete:

- `src/client/api.ts` — fetch wrapper around the loopback routes
- `src/client/index.js` — plain-JS panel + `apply()` (no TSX; the
  factory supplies React via `require`)
- `scripts/build-client.mjs` — post-processor that wraps tsc's
  `api.js` + the panel source in the `__ModuleLoader__` IIFE shape
- `tsconfig.client.json` — separate tsc config for the client
- `tests/client-bundle.test.mjs` — 16 shape checks against `lib/client.js`
- `lib/client.js` registers a "GitHub Engineer" tab into the DSH
  Settings page via `ctx.slots.inject("settings.section", …)`

The panel currently surfaces:
- Current auth status (login, scope, masked access_token expiry)
- `[Connect GitHub]` button → starts Device Flow, shows user_code +
  verification_uri inline
- `[Refresh]` / `[Revoke]` / `[我已完成授权]` (polls for the user's
  authorization result)

### How the client bundle is built

```
src/client/api.ts ───┐
                    ├─► pnpm exec tsc -p tsconfig.client.json
                    │   outputs client-build/api.js
                    │
src/client/index.js ─┘   (plain JS, kept untouched by tsc)
                         scripts/build-client.mjs
                         strips imports + the trailing `export { … }`,
                         prepends api.js (export keywords stripped),
                         wraps in window.__ModuleLoader__.load({ factory })
                         → lib/client.js
```

The factory body receives React + react/jsx-runtime from the DSH
web loader via `require()` — this matches dsh-feishu-mcp's compiled
client.js shape exactly.

### Why we don't use tsdown

`tsdown` 0.22.x and 0.23.x have ESM resolution bugs under Node 24 +
pnpm (rolldown / ansis can't be resolved). Since `tsc -p
tsconfig.client.json` produces clean ESM and the only bundler-shaped
output we need is a small IIFE wrapper, `scripts/build-client.mjs`
hand-rolls that step (~80 lines).

## Upcoming increments, in priority order

## 3. Real MCP tools (1 → 7)

Add `repo_status`, `repo_clone`, `repo_pull`, `repo_read`,
`repo_search`, `repo_edit`, `pr_create` to `mcp-server/src/tools/`.

For each:
- Validate input strictly (path not absolute / no `..`).
- Apply allowlist/denylist before every file write.
- Apply branch-prefix check before every push.
- Run `preflight.cmd` before every commit.
- Surface errors as `isError: true` MCP responses with informative
  text — the bundle's `extractText` will preserve them.
- Use Octokit (`@octokit/rest`) for `pr_create` (no `gh` subprocess).

## 4. `engineer_run` wrapper

- File: `src/agent/run-pipeline.ts`.
- Reads `AGENTS.md` + `README.md` from `working_dir`, concatenates into
  the system prompt the agent sees when this tool is called.
- Drives the LLM in a loop until either `{ack}` or 30 steps.
- At the end, runs `repo_pull --rebase`, the pre-flight, `git push`,
  and `pr_create` (default `draft: true`).

## 5. Audit + safety rails

- DSH session log entries per `engineer_run`: timestamp, login, PR
  number, changed paths, pre-flight exit, LLM step count. **Never**
  the PR body or commit message.
- Token filter in `src/util/logger.ts` (regex: `(?i)(access_token=|bearer\s)`).
- Commit-message / PR-body filter at submission time.

## 6. Publish

- README.md + CHANGELOG.md + LICENSE (MIT).
- Tag `v0.3.0` once `engineer_run` lands against a real OAuth App.
- PR to `awesome-dsh-plugin/awesome-dsh-plugin`.
- (Optional) publish to npm as `dsh-github-engineer`.

---

## Out of scope for v1

- Multiple repos
- GitHub App mode (race-ops-bot-style)
- Domain-specific skills (update-team / add-news / add-broadcaster)
- Lark / Feishu IM bridge
- Auto-merge tool (intentionally missing — CI + human review only)
- Webhook receiver
- GitHub Enterprise Server