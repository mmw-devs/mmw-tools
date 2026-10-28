# Increment 3 — Per-tool Hardening Checklist

> **Pre-implementation checklist for v0.4.0 "Real MCP tools".**
>
> Each tool below lists the guards it must enforce **at the MCP server
> boundary**, before any I/O. None of these are "best effort" — they
> are mandatory; the MCP server should refuse to call the underlying
> function when a guard rejects.

## Cross-cutting guards (apply to every tool)

These run **before** the per-tool logic. They live in `src/guard/` and
are imported by every `tools/*.ts`.

1. **Path normalization + traversal block** (`assertSafeRepoPath`):
   - Reject absolute paths (`/foo`, `C:\foo`).
   - Reject any path containing `..` after normalization.
   - Reject symlink targets that escape the repo root.
   - Test cases: empty string, `./`, `../`, `foo/../../bar`,
     `foo/./bar`, `foo//bar`, trailing slash, `\0` (null byte).
   - Implementation: `path.resolve(repoRoot, input)`, ensure
     `result.startsWith(repoRoot + path.sep)`.

2. **Allowlist enforcement** (`assertAllowlisted`):
   - If `repoBinding.allowlistPaths` is non-empty, **only paths under it**
     are writable. Reads from `denylistPaths` are always forbidden
     (regardless of allowlist).
   - Allowlist uses forward-slash glob (minimatch-compatible): `**` for
     any depth, `*` for one segment. Match against POSIX-style
     relative path.
   - **Default**: empty allowlist = nothing is writable (closed by
     default, not open by default).
   - **Deny > allow** precedence: if a path matches both, deny wins.

3. **Token redaction** (`redactTokens`):
   - Logger: strip lines matching `(?i)(access_token=|bearer\s+gh[a-z]_|token=[A-Za-z0-9]{20,})`.
   - Commit message / PR body / commit author: regex blacklist:
     `(?i)(api[-_]?key|secret|password|token|bearer|gh[oprsu]_[A-Za-z0-9]{20,})`.
   - Redaction happens **before** any string leaves the MCP server
     (logger, error returned to LLM, commit message, PR body).
   - Blacklist matches → refuse operation with `GithubRefusedError`,
     not just redact.

4. **Branch-prefix guard** (`assertBranchPrefix`):
   - Branch name must start with `repoBinding.branchPrefix` (default
     `content/`).
   - Branch name must NOT equal or be a parent of `repoBinding.baseBranch` (default `main`).
   - Branch name must match `^[A-Za-z0-9._/-]+$` (no spaces, no `..`, no `~`).
   - Reject `HEAD`, `refs/heads/`, or any `refs/` prefix.

5. **Size + count limits**:
   - Single file: ≤ 200 KiB for read, ≤ 500 KiB for write (data.json is small).
   - PR body: ≤ 65 KiB.
   - Single commit: ≤ 5 files (we only ever touch `public/data.json`).
   - Single search result: ≤ 200 hits.

6. **Preflight** (`runPreflight`):
   - Before every commit (in `repo_edit`), run `repoBinding.preflight.cmd`.
   - cmd is executed with `cwd = working_dir`, no shell interpolation
     beyond `execFile` (no `exec`).
   - Hard cap 60s, default exit code = 0 means proceed.
   - Non-zero exit → refuse commit, return stderr to LLM as MCP error.

7. **Rate limiting (best-effort, v1)**:
   - Token-bucket per tool: 10 calls / 10 s / process. Refuses excess.
   - Implemented in-process only; cross-process limit is deferred.

## Per-tool hardening

### `repo_status`

| Input | Guard |
|---|---|
| (none) | — |

| Output | Assertion |
|---|---|
| `cloned`, `current_branch`, `dirty`, `uncommitted_files` | All values derived from `git status` + branch query; no command output redaction needed (git doesn't echo tokens). |

**No high-risk surface.**

### `repo_clone`

| Input | Guard |
|---|---|
| `force?: boolean` | Default false. `force = true` removes `working_dir` first — refuses if path-traversal would point outside the configured `working_dir`. |

| Output | Assertion |
|---|---|
| `cloned_to` | Absolute path, redaction: if `working_dir` happens to contain a secret path (unlikely but possible), mask it. |
| `branch` | Already vetted by `assertBranchPrefix` if user passed one. |

**Execution**:
- `git clone --depth 1 --branch <baseBranch>` (no `--bare`, no `--mirror`).
- Refuse if `working_dir` already contains a `.git` and `force != true`.
- Refuse if disk has < 100 MiB free.

### `repo_pull`

| Input | Guard |
|---|---|
| `branch?: string` | `assertBranchPrefix` + reject base branch. |
| `rebase?: boolean` | Default true; `--rebase` (not `--ff-only`, not `--merge`). |

**Execution**: `git pull --rebase origin <branch>`. Refuse on conflict.

### `repo_read`

| Input | Guard |
|---|---|
| `path: string` | `assertSafeRepoPath`. |
| `max_bytes?: number` | Default 100 KiB. Hard cap 500 KiB. |

| Output | Assertion |
|---|---|
| `content` | Already max-bounded. Binary content → truncate at first NUL. |
| `sha` | Git blob SHA, no leak concern. |
| `truncated` | Always present in output. |

**No high-risk surface.**

### `repo_search`

| Input | Guard |
|---|---|
| `query: string` | Reject queries containing `\0`, `--` (git option injection), or starting with `!`. |
| `glob?: string` | `assertSafeRepoPath`. Reject `**/../**` patterns. |
| `max_results?: number` | Default 50. Hard cap 200. |

**Execution**: `git grep --line-number --no-color` (no `-I` binary mode confusion; no `-O` open). Sanitize each result row's line content through `redactTokens`.

### `repo_edit`

This is the highest-risk tool. Every guard below is mandatory.

| Input | Guard |
|---|---|
| `branch: string` | `assertBranchPrefix` + reject base branch. If branch doesn't exist locally, refuse (we don't auto-create on main). |
| `edits: Edit[]` | Each edit: |
| ↳ `edits[].path` | `assertSafeRepoPath` + `assertAllowlisted`. |
| ↳ `edits[].mode` | `'replace'`, `'insert'`, `'patch'` only. |
| ↳ `edits[].find` (replace mode) | Non-empty string. Length ≤ 100 KiB. |
| ↳ `edits[].replace` (replace mode) | Non-empty string. Length ≤ 100 KiB. |
| ↳ `edits[].content` (insert mode) | Non-empty string. Length ≤ 100 KiB. |
| ↳ `edits[].patch` (patch mode) | Non-empty string. Diff-format. Length ≤ 100 KiB. |
| `commit_message: string` | Non-empty. Length ≤ 64 KiB (raised from 500 bytes in 0.8.1: the target repo's op-log must declare a new top-level object in full, which does not fit in 500). **redactTokens blacklist** (regex matches token-shaped strings → refuse). No newlines in subject (use multi-line commit_message only if first line ≤ 72 chars). |

**Execution order** (state machine — abort on first failure):

```
1. assertSafeRepoPath × every path
2. assertAllowlisted × every path
3. validate edits content (length, mode-specific shape)
4. validate commit_message (length, redaction)
5. git checkout -b <branch> (if not exists)
6. apply each edit (write file via fs.writeFile, atomic via tmp+rename)
7. runPreflight
8. git add <paths>
9. git commit -m <message>
10. (push happens in `pr_create`, not here — explicit boundary)
```

**Failure modes**:
- Step 1/2/3/4 fail → no filesystem mutation.
- Step 5 fails → no filesystem mutation.
- Step 6 fails → atomic per-edit; partial state possible if edit 3 succeeds and edit 4 fails. Recovery: `git checkout -- <paths>` (refuse if preflight fails).
- Step 7 fails → `git checkout -- <paths>` and refuse commit.
- Step 8/9 fails → `git reset HEAD <paths>` then `git checkout -- <paths>`. Then refuse.

**Atomicity contract**: after a refusal, `git status --porcelain` must be empty
on the user's previous commit (no stray working tree state).

### `pr_create`

| Input | Guard |
|---|---|
| `head_branch: string` | `assertBranchPrefix`. |
| `title: string` | Non-empty. Length ≤ 200 chars. **redactTokens blacklist**. |
| `body: string` | Length ≤ 65 KiB. **redactTokens blacklist**. |
| `draft?: boolean` | Default true (per design §6.3). |
| `base?: string` | Default `repoBinding.baseBranch`. Reject anything else. |

| Output | Assertion |
|---|---|
| `number, url, head_sha` | Sanitize URL: reject if it doesn't match `^https://github.com/{owner}/{repo}/pull/\\d+$`. |

**Execution**:
- `gh pr create` — but **we agreed in v2 §6.3 to use Octokit, not gh subprocess**.
- `octokit.pulls.create({ owner, repo, head, base, body, title, draft })`.
- After success: log PR number + URL to session log (already in v2 §10.4).

**Refusal**:
- 422 "No commits between X and Y" → branch has no commits ahead of base. Suggest push.
- 401/403 → refresh token. If still failing → set `reauth_needed` and refuse.

### `pr_list` (lower priority; can defer to v2)

| Input | Guard |
|---|---|
| `state?: 'open' \| 'closed' \| 'all'` | Default `open`. |
| `base?: string` | Default `repoBinding.baseBranch`. |

**Execution**: `octokit.pulls.list`. Output is structured JSON, no redaction needed (PR titles don't usually contain tokens; but apply `redactTokens` to title + body strings).

## Host-side guards (apply at the bundle layer, not MCP server)

These live in `src/index.ts` (host) and run before MCP tools are even
invoked by the agent.

1. **Allowlist at apply-time**: at `apply()`, re-validate
   `repoBinding.allowlistPaths` / `denylistPaths` against an empty test
   write (e.g. write to `/tmp/dsh-github-engineer-allowlist-test` then
   delete). If the path allows writes outside the test scope, log a
   loud warning and disable the bundle.

2. **AGENTS.md drift**: the existing drift check at apply. If drift
   detected, log warning but **still allow execution** (AGENTS.md is
   authority, but plugin should not block on a known SSOT violation).

3. **Engineer-run wrapper**: this lives in increment 4, but the
   per-tool guards here must compose with the wrapper's LLM-loop
   termination conditions.

## Test requirements (must pass before merge)

- Unit tests for each cross-cutting guard:
  - `assertSafeRepoPath`: 8+ cases (incl. `..`, symlink, null byte).
  - `assertAllowlisted`: 10+ cases (incl. allowlist-denylist overlap).
  - `redactTokens`: 6+ cases (incl. multi-pattern match).
  - `assertBranchPrefix`: 5+ cases (incl. base-branch rejection).
- Integration tests for each tool (against a `git init --bare` test repo):
  - `repo_status`: works on empty repo.
  - `repo_clone`: clones from local file:// URL, refuses non-existent.
  - `repo_read`: refuses path-traversal, refuses oversized.
  - `repo_edit`: applies all 3 modes, refuses allowlist-violating path,
    refuses redact-violating message, atomic rollback on preflight fail.
  - `pr_create`: refuses when no commits ahead, refuses redaction.

## Out of scope for v1

- Cross-process rate limiting.
- Audit log persistence (session log only).
- Webhook receiver.
- GitHub Enterprise Server.

---

## How I'll work against this checklist

Each tool's implementation in `mcp-server/src/tools/<name>.ts` starts
with the guard table above as comments at the top of the file. When
all guards are implemented and the corresponding test passes, that
tool is considered complete. Tests are written **before** the tool
body (the guard test cases double as the implementation spec).