# Next Steps (After the Skeleton Boots)

The skeleton (`v0.1.0`) proves:
- The bundle mounts under DSH 0.1.5+.
- `cordis.patch.yml` injects the config the bundle reads.
- `apply(ctx, config)` registers an agent tool and a system-prompt section.
- The MCP server spawns via stdio and its `tools/list` is re-published.

The next increments, in priority:

## 1. OAuth Device Flow + token store

- Files to add: `src/auth/device-flow.ts`, `src/auth/token-store.ts`, `src/auth/oauth.ts`.
- Persistence path: `~/.dsh/dsh-github-engineer.json` mode 0600 (mirror
  dsh-feishu-mcp `src/store.ts`).
- Routes to add (loopback-only):
  - `POST /api/github-engineer/oauth/start` → returns `user_code` + `verification_uri`
  - `GET  /api/github-engineer/oauth/callback` → browser redirect target
  - `POST /api/github-engineer/oauth/finish` → exchange code → tokens
  - `POST /api/github-engineer/oauth/refresh` → use refresh_token
- High-level tools: `engineer_oauth_start`, `engineer_oauth_finish`, `engineer_oauth_refresh`.
- Watchdog: refresh 5 min before expiry; reconnect MCP with new `GHOST_TOKEN`.

## 2. Settings web panel

- Add a React component for the Settings → GitHub Engineer page.
- Wire it through `@deepseek-ai/dsh-client-ui-settings` slots
  (inspect dsh-feishu-mcp's `src/settings.tsx` for the exact hook).
- Surface: `[Connect GitHub]` button, login info, expiry, repo binding,
  working dir, preflight cmd.

## 3. Real MCP tools (6 → 7)

Add `repo_status`, `repo_clone`, `repo_pull`, `repo_read`,
`repo_search`, `repo_edit`, `pr_create` to `mcp-server/src/tools/`.

For each:
- Validate input strictly (path not absolute / no `..`).
- Apply allowlist/denylist before every file write.
- Apply branch-prefix check before every push.
- Run `preflight.cmd` before every commit.
- Surface errors as `isError: true` MCP responses with informative
  text — the bundle's `extractText` will preserve them.

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
- Tag `v0.1.0` once `engineer_run` lands against a real OAuth App.
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