# Increment 5 — Audit + safety rails (v0.6.0)

> **Scope.** Audit runs from BOTH sides of the boundary:
> - **Host side (`src/util/audit.ts`)**: append-only JSONL log of
>   engineer_run starts + outcomes; redacting logger wrapper for any
>   incidental `ctx.logger` call.
> - **MCP server side (already shipped in v0.4.0)**: every tool runs
>   through cross-cutting guards; refusals land on `isError: true` MCP
>   responses which the bundle surfaces through `extractTokens`.
>
> This document records what the host-side audit adds on top of
> v0.4.0. It does NOT cover a DSH-internal session log — we don't
> have a stable plugin API for that.

## What gets audited

| Event kind | When | Fields |
|---|---|---|
| `engineer_run_start` | Inside `engineer_run` tool, before any work | `repo`, `branch_name` (may be empty), `user_request_bytes`, `draft` |
| `engineer_run_created` | After `engineerRun()` returns | `branch_suggestion`, `agents_md_present`, `readme_present` |
| `refused` | Caught exception | `tool`, `code` (e.g. `user-request-contains-token`, `user-request-too-long`) |

The `user_request` text is **never** logged. We log only its byte
length — the request may contain sensitive intent that should not
land on disk. The actual request text is token-redacted by
`assertNoTokens` upstream (so even if we did log it, tokens would be
removed), but fail-closed is cheaper than fail-redacted.

## How it's stored

- File: `~/.dsh/dsh-github-engineer-audit.jsonl` (mode 0600, append)
- Override via `DSH_GITHUB_ENGINEER_AUDIT` env var (used by tests)
- Format: one JSON object per line, `\n`-terminated
- Rotation: when live file exceeds `MAX_BYTES` (1 MiB), it is renamed
  to `<file>.1` before the next write
- Every string field passes through `redactDeep` → `redactTokens` →
  classic patterns (`gho_…`, `Bearer …`, `key=value`, `key: value`,
  bare `Authorization: <token>`, `key <token>`)
- Failure is **logged once via `ctx.logger.warn`**, then silenced —
  an audit trail is valuable, but refusing to work because the trail
  is unwritable would be worse.

## How it's invoked

`createAuditLogger()` is constructed once in `apply()` and shared:

- passed to `makeEngineerRunTool` as `deps.audit`
- NOT passed to other tools — they don't audit (the MCP-server
  refusal path already returns informative errors; further audit
  would be redundant for v0.6.0)

## Redacting logger

`createRedactingLogger(base)` wraps a `ctx.logger`-shaped object so
every message is token-redacted on the way out. The host side
constructs one and the `engineer_run` tool receives it as `deps.log`,
so any `deps.log.warn(...)` from the tool can't leak a token.

The MCP server's `guard.ts::redactTokens` and the host's
`util/redaction.ts::redactTokens` are kept in sync (same regex set
since the v0.4.0 Bearer-patch landed).

## Test requirements (met)

`tests/audit.test.mjs` covers:
- `auditPath()` default + override
- `redactDeep()` for strings, numbers, booleans, null, arrays,
  nested objects, depth limit, the new `Bearer xxx` form (post-patch)
- `createAuditLogger()`: write to disk, file mode (0600 implied by
  create flags), rotation on `MAX_BYTES`, write failures do not
  throw, warn-once on repeated failures
- `createRedactingLogger()`: clean messages pass through, token
  messages are redacted at all three levels (info / warn / error)

## Out of scope for v0.6.0

- DSH session log integration (no stable plugin API yet).
- Cross-process audit log shipping (would require HTTPS).
- Webhook notification on every audit line.
- Per-MCP-call audit hooks for non-engineer-run tools.