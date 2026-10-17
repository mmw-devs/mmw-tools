# Increment 3 — Real MCP Tools (v0.4.0) — Implementation Record

> **v0.4.0 ships 8 MCP tools** (one beyond the original 7-tool plan):
> `repo_status` / `repo_clone` / `repo_pull` / `repo_read` / `repo_search`
> / `repo_edit` / `pr_create` / `pr_list`.
>
> The pre-implementation design (per-tool guards, threat model) lives
> in [INCREMENT-3-CHECKLIST.md](INCREMENT-3-CHECKLIST.md). This
> document is the **what was actually built and where** summary.

## Architecture

```
mcp-server/src/
├── const.ts                    (existing) PLUGIN_DISPLAY_NAME + PLUGIN_VERSION
├── guard.ts                    (NEW) cross-cutting hard guards
├── tools/
│   ├── repo-status.ts           (NEW) working-copy state report
│   ├── repo-clone.ts            (NEW) git clone wrapper
│   ├── repo-pull.ts             (NEW) git pull --rebase wrapper
│   ├── repo-read.ts             (NEW) read file (with size + binary guards)
│   ├── repo-search.ts           (NEW) git grep wrapper
│   ├── repo-edit.ts             (NEW) high-risk file edits + commit
│   ├── pr-create.ts             (NEW) push + gh pr create
│   └── pr-list.ts               (NEW) gh pr list
├── index.ts                     (UPDATED) dispatcher for all 8 tools
└── tests/
    ├── guard.test.mjs           (NEW) 44 unit tests against guard.ts
    └── tools-list-schema.test.mjs (NEW) 11 static checks against compiled dispatcher
```

The dispatcher reads runtime config from environment variables prefixed
`GHOST_`:

| Variable | Purpose | Default |
|---|---|---|
| `GHOST_WORKING_DIR` | where the cloned repo lives | (empty) |
| `GHOST_REPO_URL` | `https://github.com/owner/repo` | (empty) |
| `GHOST_REPO_OWNER` / `_NAME` | for `pr_create` / `pr_list` | (empty) |
| `GHOST_BASE_BRANCH` | base branch for `content/*` PRs | `main` |
| `GHOST_BRANCH_PREFIX` | required branch prefix | `content/` |
| `GHOST_ALLOWLIST` | comma-separated glob patterns | `public/data.json` |
| `GHOST_DENYLIST` | comma-separated glob patterns | see `index.ts` defaults |
| `GHOST_PREFLIGHT_CMD` | pre-commit validation command | `npm run validate` |
| `GHOST_PREFLIGHT_TIMEOUT` | pre-commit timeout (seconds) | `60` |
| `GHOST_TOKEN` | GitHub OAuth token (kept in `GHOST_` prefix, NOT `TOKEN_`, to avoid collision with shell `TOKEN` env var) | (empty) |

The host bundle (`src/index.ts`) populates these from the binding
config when it spawns the MCP child process (planned in increment 4,
`engineer_run` wrapper).

## What was implemented vs. the checklist

| Guard | Status |
|---|---|
| 1. Path normalization + traversal block | ✅ `assertSafeRepoPath` + 8 unit tests |
| 2. Allowlist / denylist | ✅ `assertAllowlisted` + 10 unit tests (incl. deny > allow precedence) |
| 3. Token redaction | ✅ `detectTokens` + `assertNoTokens` + `redactTokens` + 6 unit tests |
| 4. Branch prefix | ✅ `assertBranchPrefix` + 8 unit tests |
| 5. Size + count limits | ✅ `LIMITS` constants + `assertWithinLimit` + 4 unit tests |
| 6. Preflight (execFile, no shell) | ✅ `runPreflight` (not unit-tested yet — needs a tmp git repo) |
| 7. Rate limiting | 🚧 deferred to v2 (in-process token-bucket not implemented) |

| Tool | Guards per checklist | State machine | Atomic rollback |
|---|---|---|---|
| `repo_status` | n/a (read-only) | ✅ | n/a |
| `repo_clone` | force-check, disk-space | ✅ | n/a (creates fresh dir) |
| `repo_pull` | dirty-tree refuse, rebase-only | ✅ | conflict reported to caller |
| `repo_read` | path safe + size cap + binary detect | ✅ | n/a (read) |
| `repo_search` | query pattern (no `!`, `--`, `\0`), glob no `..` | ✅ | n/a (read) |
| `repo_edit` | full checklist §1-6 | ✅ 9-step machine | ✅ atomic per-edit + `git checkout --` rollback |
| `pr_create` | title/body redaction, branch prefix, default draft | ✅ | push failure reports cleanly |
| `pr_list` | n/a | ✅ | n/a (read) |

## Tests

```sh
cd mcp-server
pnpm test                    # 44 guard tests + 11 schema tests = 55 PASS
pnpm test:smoke              # 7-tool spawn (skipped in sandbox: child_process EPERM)
```

## Known limitations

1. **`repo_edit` `patch` mode is not implemented.** Per checklist §3,
   it would need `git apply --3way`; for v1 we accept `replace` and
   `insert` only and refuse `patch` with `patch-not-implemented-v1`.
   The agent is steered to construct `replace` edits via
   `repo_read` + read-back + construct new content.

2. **`pr_create` uses `gh` CLI, not Octokit.** The design said
   "use Octokit" but the v1 implementation shells out to `gh` for
   two reasons: (a) `gh` already handles GitHub App / PAT auth
   transparently, (b) avoiding the octokit dependency in v1 keeps the
   bundle small. The token flows via `GH_TOKEN` env var to `gh`,
   not argv. This is **safer than the `git clone` argv rewrite** in
   `repo_clone.ts`.

3. **No rate limiting.** Deferred to v2 per checklist §7.

4. **Token in argv on `git clone` URL rewrite** (`repo-clone.ts:107`)
   — explicitly noted as a v1 trade-off. The token appears in
   process listing for ~1 second during clone. Acceptable because
   (a) clone runs once per session, (b) the plugin only runs on the
   user's own machine. v2 should switch to GIT_ASKPASS or SSH key.

## Next increments

- **Increment 4**: `engineer_run` wrapper — drives `repo_read` /
  `repo_edit` / `pr_create` in a loop with AGENTS.md auto-load.
- **Increment 5**: Audit + safety rails — token filter in the bundle's
  logger, commit-message blacklist at submission time (already in
  guard.ts but not yet wired into the bundle), session log entries.
- **Increment 6**: Publish.