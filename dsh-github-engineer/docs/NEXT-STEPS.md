# Next Steps

## Current state (v0.4.0)

✅ Real MCP tools complete:

- `mcp-server/src/guard.ts` — cross-cutting hard guards (path safety,
  allowlist/denylist, branch prefix, token redaction, preflight,
  size limits). 44 unit tests in `tests/guard.test.mjs`.
- 8 MCP tools in `mcp-server/src/tools/`:
  `repo_status` / `repo_clone` / `repo_pull` / `repo_read` /
  `repo_search` / `repo_edit` / `pr_create` / `pr_list`.
- Each tool runs through every relevant guard before any I/O.
- `mcp-server/src/index.ts` — dispatcher mapping `tools/list` +
  `tools/call` JSON-RPC to the tools; refusal errors go through
  `isError: true` with `[code] message` text.
- 11 schema checks in `tests/tools-list-schema.test.mjs` (no spawn
  needed; static source grep).

See [`docs/INCREMENT-3-CHECKLIST.md`](INCREMENT-3-CHECKLIST.md) for
the per-tool hardening spec, and
[`docs/INCREMENT-3-DESIGN.md`](INCREMENT-3-DESIGN.md) for what was
actually built.

### What v0.4.0 still doesn't do

- No `engineer_run` wrapper: the agent can call MCP tools directly,
  but no top-level wrapper drives AGENTS.md auto-load + LLM loop yet.
- No audit rails: no session log entries, no token filter in the
  bundle logger. The guards above prevent the *content* from leaking,
  but the *act* of an MCP call isn't logged.
- No rate limiting (deferred to v2).
- `repo_edit` patch mode is not implemented (only `replace` + `insert`).

## Upcoming increments

## 4. `engineer_run` wrapper

- File: `src/agent/run-pipeline.ts`.
- Reads `AGENTS.md` + `README.md` from `working_dir`, concatenates
  into the system prompt the agent sees when this tool is called.
- Drives the LLM in a loop until either `{ack}` or 30 steps.
- At the end, calls `repo_pull --rebase`, then loops with
  `repo_read` / `repo_search` / `repo_edit` / `pr_create`.
- Spawns the MCP server as a child process from the host, passing
  config via `GHOST_*` env vars (see `mcp-server/src/index.ts:config()`).

## 5. Audit + safety rails

- DSH session log entries per `engineer_run`: timestamp, login, PR
  number, changed paths, pre-flight exit, LLM step count. **Never**
  the PR body or commit message.
- Token filter in the bundle's `src/util/logger.ts` (regex blacklist
  reused from `mcp-server/src/guard.ts`).
- Per-MCP-call audit hook in the bundle entry that records
  tool name + ref-id + outcome into the DSH session log.

## 6. Publish

- README.md + CHANGELOG.md + LICENSE (MIT).
- Tag `v0.4.0` once `engineer_run` lands against a real OAuth App.
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