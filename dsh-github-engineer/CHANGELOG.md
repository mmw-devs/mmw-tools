# Changelog

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
