# Next Steps

## Current state (v0.2.0)

✅ OAuth Device Flow state machine + token store complete:

- `src/auth/token-store.ts` — mode 0600 JSON persistence
- `src/auth/device-flow.ts` — Device Flow state machine + GitHub HTTP
- `src/routes.ts` — 5 loopback routes (status, oauth/start, oauth/finish, oauth/refresh, revoke)
- 4 agent tools: `engineer_oauth_start` / `_finish` / `_refresh` / `_revoke`
- 60-second refresh watchdog
- 25 unit tests pass for the token store
- `pnpm check` (typecheck + namespace consistency) passes
- See [`docs/OAUTH-FLOW.md`](OAUTH-FLOW.md) for end-user flow

## Upcoming increments, in priority order

## 2. Settings web panel

- Add a React component for the Settings → GitHub Engineer page.
- Wire it through `@deepseek-ai/dsh-client-ui-settings` slots
  (inspect dsh-feishu-mcp's `src/settings.tsx` for the exact hook).
- Surface: `[Connect GitHub]` button, login info, expiry, repo binding,
  working dir, preflight cmd.
- Calls the loopback routes added in v0.2.0.

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
- Tag `v0.2.0` once settings panel lands.
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