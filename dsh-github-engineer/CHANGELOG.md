# Changelog

## 0.8.1 — commit messages sized for the op-log, and a browser that never waits

A login could end in nginx's `504 Gateway Time-out` instead of a session.
The callback handler exchanged the code, read `/user`, and checked org
membership *before* answering the browser; those calls had no timeout, so
when the cross-border path to github.com stalled the handler outlived
nginx's 20s `proxy_read_timeout` and the user saw a 504. Reproduced from
outside the server on 2026-10-29: `/health` 121 ms, `/session/start` 200,
`/auth/github/start` 302 in 81 ms, callback **504 at 20.03 s**.

Separately, `repo_edit` refused the operation the target repository
requires: `COMMIT_MESSAGE_MAX_BYTES` was 500, while an op-log that declares
a **new top-level object** must spell out `from: null → to: { ... }` in
full. The reported message for one such object was 2179 bytes, so the only
ways through were to fabricate the log or to stop — the right answer was
neither. The cap is now 64 KiB, which covers any single top-level object in
`public/data.json` (the largest today is ~10 KB) and matches
`PR_BODY_MAX_BYTES`; the 72-character subject limit, which is what actually
keeps a message readable, is unchanged.

### Fixed

- `mcp-server/src/guard.ts` — `COMMIT_MESSAGE_MAX_BYTES` 500 → 64 KiB.
  `mcp-server/dist/**` is rebuilt in the same commit.
- `broker/server.mjs` — the callback gives GitHub 5 s, then answers with
  "正在确认身份" and lets the poller collect the result. The 5 s covers the
  ordinary case, so the page still names the account; a stalled GitHub
  can no longer produce a gateway error.
- `broker/core.mjs` — every GitHub call is bounded (`githubTimeoutMs`,
  8 s) and retried once on a network failure; a stalled connection now
  ends as `github-unreachable` instead of hanging.
- `broker/core.mjs` — a failed exchange used to leave the state
  `consumed`, which the poller reads as `pending`, so the panel waited out
  the full 5-minute TTL. The state is now terminal (`failed` → `denied` +
  reason) and the panel shows why.
- `broker/server.mjs` — a stale or replayed link answers 400 with an
  explanation instead of starting an exchange that cannot succeed.
- `broker/server.mjs` — the rate limiter used `req.socket.remoteAddress`,
  which is `127.0.0.1` for every request behind nginx, so all users shared
  one 60/min bucket. It now uses `X-Forwarded-For`, which nginx sets.

### Operational

- `/opt/race-ops-broker/.env` now routes egress through the host's mihomo
  HTTP listener (`NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY=http://127.0.0.1:7890`).
  Direct cross-border connections were the source of the stall; the
  timeout handling above only turns a stall into a reportable error. Proven
  rather than assumed: point `HTTPS_PROXY` at a closed port and the same
  Node call fails `ECONNREFUSED`; the configured listener answers 200.
  See docs/AUTH-BROKER.md §9. Requires Node ≥ 24 for `NODE_USE_ENV_PROXY`
  (the host runs v24.22.1).

No nginx change is needed: the slow path is answered at ~5 s, inside the
existing 20 s read timeout.

## 0.8.0 — broker auth

Authentication is no longer performed by the plugin. It holds a 12-hour
broker session and exchanges it for a 1-hour installation token issued to
the GitHub App `race-ops-tool` (docs/AUTH-BROKER.md).

### Removed

- `src/auth/device-flow.ts` (362 lines) and `src/auth/token-store.ts`
  (166 lines), plus `tests/token-store.test.mjs` and
  `docs/OAUTH-FLOW.md`. The plugin no longer talks OAuth to GitHub at all,
  so keeping a second auth path would have meant two implementations of
  the same job.

### Added

- `src/auth/broker-auth.ts` — the single implementation. It exposes the
  method surface the routes and status tool were already written against
  (`begin` / `poll` / `refresh` / `clearAll` / `status` / `view`), so the
  swap did not need a schema migration.
- `src/auth/session-store.ts`, `src/auth/broker-client.ts` — session
  persistence and the broker contract, 66 assertions between them.
- `broker/` — the token broker: core (59 assertions), HTTP layer
  (42 assertions), deployment scripts.

### Notes

- The installation token is written to
  `~/.dsh/dsh-github-engineer-installation.json` (0600) because the MCP
  child reads `accessToken` from `GHOST_TOKEN_FILE` on every call.
  Deliberate trade-off: the alternative is restarting the MCP bridge on
  every login and every hourly refresh. Follow-up: have the child ask the
  broker itself.
- `view()` still returns `accessTokenMasked` / `accessTokenExpiresAt`;
  under the broker these describe the session token. Renaming them is a
  schema migration and is deferred.

## 0.7.0 — real mounting

Everything below was found by installing the plugin into a real DSH
profile and running it against the real bound repository. None of it was
reachable by the offline suites, which stub the host context.

### Fixed

- **The plugin never activated.** `inject` listed `logger`, which the
  shipped web profile does not provide, so cordis left the entry
  `pending` forever: no tools, no routes, no panel, one line of boot
  warning. `inject` is now `["tools"]`, and the other services are
  reached through `ctx.get(name)` with bounded retries and a warning on
  timeout. (`optional`/`required` object form is not supported by this
  cordis: it reads the object's keys as service names.)
- **The panel never loaded with `link:` installs.** pnpm does not
  resolve a linked package's peer dependencies, so the browser module was
  listed in the boot payload and then never served. Docs now use
  `file:`.
- **The panel registered nothing, silently.** `apply()` demanded a React
  runtime from `opts.runtime` or `ctx.__githubEngineerRuntime`; the DSH
  client loader passes neither, so it threw, and the `catch` downgraded
  that to a `console.warn`. The result was a settings entry that showed
  the plugin's name and no controls. React comes from the bundle wrapper
  (`require("react")`) and is in scope — it is now used directly, and a
  registration failure throws instead of hiding.
- **The access token was written to `.git/config`.** `git clone` stores
  the credentialed URL as `origin`. `repo_clone` now resets it
  immediately; `pr_create` pushes to an explicit URL and no longer uses
  `-u`.
- **Every npm-based preflight and bootstrap failed on Windows** with
  `spawn npm ENOENT`: `npm` is `npm.cmd` and `execFile` ignores
  `PATHEXT`. Preflight now runs through the shell on Windows, using the
  string form of `exec` to avoid DEP0190.

### Added

- `repoBinding.bootstrap` — one-time setup (e.g. `npm ci`) before the
  first edit, because a fresh clone has no devDependencies and every
  commit was refused by its own pre-flight.
- `mcpBindingEnv()` — the host now actually passes the binding and the
  token-store path to the MCP child. Before this the child saw an empty
  working directory and no repository.
- `scripts/t5-readonly.mjs` / `scripts/t5-write.mjs` — the real-repo
  check, repeatable.

### Verified

- Live profile: `/api/github-engineer/status` → 200 with the
  secret-free JSON; unknown paths → 404; the client bundle is served and
  registers `settings.section`.
- Real repo, read path 19/19; write path 8/8 (bootstrap, preflight,
  commit, draft PR #16, verified with `gh`, then closed).


All notable changes to this plugin are documented here.

The plugin follows a `0.x` line: the surface may change between minor
versions until the first stable release. Every entry below names the
increment it shipped as, so a reader can map a version to the design
documents under [`docs/`](docs/).

## [0.6.0] — 2026-10-23 · increment 5: audit + safety rails

### Added

- `src/util/audit.ts` — append-only JSONL audit trail at
  `~/.dsh/dsh-github-engineer-audit.jsonl` (mode 0600, 1 MiB
  rotation to `.1`).
  - `createAuditLogger()` records `engineer_run_start`,
    `engineer_run_created`, and `refused` events.
  - `redactDeep()` walks objects and arrays (depth ≤ 8) so a caller
    cannot leak a token into the log even by accident.
  - `createRedactingLogger()` wraps a `ctx.logger`-shaped object and
    redacts every message on the way out.
  - Write failures never throw: one warning through `ctx.logger`, then
    the logger goes silent so the plugin keeps working.
- `tests/audit.test.mjs` — 29 cases (path resolution, deep
  redaction, rotation, failure handling, redacting logger).
- `docs/INCREMENT-5-DESIGN.md` — what is audited, what is
  deliberately not, and why.

### Changed

- `engineer_run` now records a start event (request **byte length**
  only — never the request text), an outcome event, and a refusal
  event carrying the typed error code.

## [0.5.0] — 2026-10-19 · increment 4: `engineer_run` bootstrap wrapper

### Added

- `src/agent/engineer-run.ts` — prepares a project context for the
  DSH agent: reads `AGENTS.md` (4 KiB cap) and `README.md` (2 KiB cap),
  computes a `content/<date>-<slug>` branch suggestion, and returns a
  plain-text operating guide covering allowlist, denylist, branch
  prefix, preflight command, tool inventory, workflow, and hard rules.
- `src/util/redaction.ts` — host-side `detectTokens` / `redactTokens` /
  `assertNoTokens` / `assertInsideRepo`. Duplicated from the MCP
  server because the two live in separate packages; both copies are
  kept in sync.
- `tests/engineer-run.test.mjs` — 37 cases.
- `docs/INCREMENT-4-CHECKLIST.md` — the input/output contract, the
  scope correction (plugins do not drive the LLM), and the guards.

### Changed

- `engineer_run` registered as a sixth high-level agent tool.
- `BundleConfig` gained `workingDir` (falls back to
  `GHOST_WORKING_DIR`).

### Fixed

- **Token blacklist missed `Bearer <token>`** — the v0.4.0 patterns
  only matched `key=value` and `key: value`, so an
  `Authorization: Bearer ghp_…` header passed straight through
  redaction. Added a whitespace-separated pattern to both copies.
  This was a real leak in v0.4.0.

## [0.4.0] — 2026-10-17 · increment 3: real MCP tools

### Added

- Eight MCP tools under `mcp-server/src/tools/`: `repo_status`,
  `repo_clone`, `repo_pull`, `repo_read`, `repo_search`, `repo_edit`,
  `pr_create`, `pr_list`.
- `mcp-server/src/guard.ts` — cross-cutting guards applied before any
  I/O: path traversal + symlink escape, allowlist/denylist with
  deny-over-allow precedence, branch-prefix validation, token-shaped
  string detection, preflight runner (via `execFile`, no shell), and
  size limits.
- `repo_edit` is a nine-step state machine (validate → checkout →
  atomic per-edit writes → preflight → stage → commit) that rolls the
  working tree back with `git checkout --` on any post-edit failure.
- `tests/guard.test.mjs` (44 cases) and
  `tests/tools-list-schema.test.mjs` (11 cases).
- `docs/INCREMENT-3-CHECKLIST.md` and
  `docs/INCREMENT-3-DESIGN.md`.

## [0.3.0] — 2026-10-16 · increment 2: settings web panel

### Added

- `src/client/api.ts`, `src/client/index.js`, and
  `scripts/build-client.mjs` — a React panel registered into
  `settings.section` through the DSH web `__ModuleLoader__` factory
  contract, with **Connect GitHub / Refresh / Revoke / I already
  authorized** actions.
- `tests/client-bundle.test.mjs` — 16 shape checks against the built
  `lib/client.js`.
- `docs/INCREMENT-2-VERIFICATION.md` — an audit of the four build
  decisions against DSH's own source rather than against another
  plugin's output.

### Notes

- The client bundle is assembled by a hand-rolled ~80-line script
  rather than `tsdown`: tsdown 0.22.x and 0.23.x both fail ESM
  resolution under Node 24 + pnpm, and `child_process.spawn` is
  blocked in the development sandbox, so no bundler could run.
  The output is byte-shape-compatible with the `__ModuleLoader__`
  contract.

## [0.2.0] — 2026-10-16 · increment 1: OAuth device flow

### Added

- `src/auth/token-store.ts` — `~/.dsh/dsh-github-engineer.json`
  (mode 0600), secret-masking `view()`, atomic `save()`.
- `src/auth/device-flow.ts` — RFC 8628 device authorization grant:
  `begin()` → `poll()` → `refresh()`, with `no_token` /
  `device_pending` / `authorized` / `reauth_needed` states.
- `src/routes.ts` — five loopback-only HTTP routes
  (`status`, `oauth/start`, `oauth/finish`, `oauth/refresh`,
  `revoke`), rejecting non-loopback peers, wrong methods, and
  malformed JSON bodies.
- Four OAuth agent tools plus a 60-second refresh watchdog.
- `tests/token-store.test.mjs` — 25 cases.
- `docs/OAUTH-FLOW.md` — the end-user guide.

## [0.1.0] — 2026-10-16 · skeleton

### Added

- DSH bundle manifest, `cordis.patch.yml`, MCP stdio child with a
  single `echo` probe tool, and the namespace-consistency check
  (`scripts/check-namespace-consistency.mjs`) that keeps the plugin id
  in sync across the cordis patch, both `package.json` files, both
  `const.ts` files, and the built client bundle.
- `tests/bundle-apply.test.mjs` and `tests/routes-integration.test.mjs`
  arrived slightly later, in the end-to-end verification pass before
  increment 4.
