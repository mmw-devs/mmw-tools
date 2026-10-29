# Testing

The suite is layered by *what it needs to run*, not by what it tests.
That distinction matters here: the most valuable layer needs a real
subprocess, which not every sandbox permits.

## The layers

| Layer | Command | Needs | Runs where |
|---|---|---|---|
| Pure logic and shape | `pnpm check` | nothing | anywhere |
| MCP server handshake | `pnpm test:smoke` | `child_process.spawn` with piped stdio | CI, normal terminal |
| Real git | `pnpm test:integration` | `git` on `PATH`, spawn with piped stdio | CI, normal terminal |
| Real GitHub | none | a scratch repository + a device-flow authorization | manual, see below |

### `pnpm check`

Typecheck, namespace consistency, six in-process suites, and a pack-contents
assertion. No subprocess, no network, no repository. Safe to run anywhere,
and it is what a contributor should run before every commit.

| Suite | Asserts |
|---|---|
| `tests/token-store.test.mjs` | credential persistence, masking, clearing |
| `tests/client-bundle.test.mjs` | the `__ModuleLoader__` shape of `lib/client.js` |
| `tests/bundle-apply.test.mjs` | `apply()` registers 6 tools, 5 routes, 1 prompt section; disposers; idempotence |
| `tests/routes-integration.test.mjs` | real HTTP against the five loopback routes (loopback fence, method, malformed body) |
| `tests/mmw-tools-run.test.mjs` | input validation, branch slug, excerpts, redaction, truncation |
| `tests/audit.test.mjs` | deep redaction, rotation, write-failure handling |
| `scripts/check-namespace-consistency.mjs` | the plugin id agrees across 7 files and the built client bundle |
| `scripts/check-pack-contents.mjs` | the npm tarball contains `lib/`, `mcp-server/dist/`, and `LICENSE`, and excludes `src/`, `tests/` |

### `pnpm test:smoke`

Starts `mcp-server/dist/index.js` as a real stdio child, performs the JSON-RPC
handshake, and asserts `tools/list` advertises eight tools with object input
schemas. It is the only suite that exercises `StdioServerTransport`.

### `pnpm test:integration`

The one suite that runs the tool bodies. It builds a throwaway repository in a
temp directory — a bare `origin.git`, a `seed` clone that pushes commits, and a
`work` clone the tools operate on — then calls `repo_clone`, `repo_status`,
`repo_read`, `repo_search`, `repo_edit`, `repo_pull`, and the `pr_create` guards
directly. It covers, among other things:

- `repo_edit` preflight failure: HEAD, `git status`, and the file bytes must all
  match their pre-edit values afterwards. That is the rollback proof.
- refusals that must not leave a commit or a dirty tree (allowlist, denylist,
  base branch, branch prefix, missing `find`, ambiguous `find`, token in the
  commit message, too many edits, unimplemented `patch` mode).
- `repo_search` glob handling, which pins a v0.4.0 argument-order bug.

`pr_create` is only exercised up to its guards: the suite never pushes and never
calls `gh`, so it needs no network and no credentials.

### Real GitHub

Not automated. A full round trip needs a scratch repository and a human to
complete the Device Flow in a browser. The manual procedure is in
[`PUBLISHING.md`](PUBLISHING.md) under "After release" — install into a clean
profile, run `mmw_tools_status`, then one `mmw_tools_run`, and confirm a draft PR
appears.

## Why two suites self-skip

Both `test:smoke` and `test:integration` need `child_process.spawn` with piped
stdio. Some DSH sandboxes deny that with `EPERM`. Rather than fail — or, worse,
silently pass — each suite probes for the capability first and prints a loud
`SKIP` naming what was **not** verified:

```
  SKIP  child_process.spawn denied (EPERM) in this sandbox
        The MCP server was NOT started; stdio transport is unverified.
```

A skip exits `0`. That is deliberate: the suite cannot distinguish "broken" from
"cannot run here", and a red signal for an environment limitation trains people
to ignore red. CI runs both suites on `ubuntu-latest` and `windows-latest`, so a
skip in a developer sandbox never means a gap in the project.

Windows is in the matrix on purpose: path handling differs (this repository has
already tripped over backslashes in a `configPath` assertion), and `git` behaves
differently around line endings.

## Adding a test

1. If the code under test shells out, put the test in
   `tests/integration-git.test.mjs` and reuse `makeFixture()`. Do not fake `git`
   output in that suite — the point is the real thing.
2. If it does not shell out, prefer `pnpm check`: something that runs on every
   commit is worth more than something that runs on release.
3. Assertions that cannot run in the current environment must skip loudly and
   say what was skipped. Never turn an environment limitation into a silent pass.
4. Every refusal in `mcp-server/src/tools/` should have a case in
   `tests/integration-git.test.mjs` (for ordering and side effects) or in
   `mcp-server/tests/guard.test.mjs` (for the guard itself).
