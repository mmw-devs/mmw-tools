# Operations Sync — AGENTS.md ↔ cordis.patch.yml

> **TL;DR:** `ffxiv-race-ops/AGENTS.md` is the **authority** for
> repository operation rules. `cordis.patch.yml` is a **read-time
> cache**. The two must agree; this document spells out who keeps them
> in sync and how.

---

## Why this document exists

The plugin's `repoBinding` section in `cordis.patch.yml` mirrors four
rules that also live in `mmw-devs/ffxiv-race-ops/AGENTS.md`:

| cordis.patch.yml field | AGENTS.md source rule |
|---|---|
| `allowlistPaths` | "唯一允许修改：`public/data.json`" |
| `denylistPaths` | derived from "不可改动" list |
| `branchPrefix` | "`content/*` 分支前缀" |
| `preflight.cmd` | "本地校验：`npm run validate`" |

This is a deliberate, temporary **SSOT violation**. The plugin reads
these fields at runtime to enforce guards; without a mirror it would
have to parse `AGENTS.md` (free-form Markdown), which is unsafe. The
tradeoff is:

- ✅ Plugin runs without LLM-assisted parsing.
- ✅ One human-readable, machine-checkable config file.
- ⚠️ When `AGENTS.md` changes, `cordis.patch.yml` does **not** update
  automatically. A mismatch logs a warning at `mmw_tools_run` startup.

---

## Who maintains what

| Change type | Owner | Action |
|---|---|---|
| `ffxiv-race-ops/AGENTS.md` rules change (e.g. "now `public/teams.json` is also editable") | The team that owns the ops repo (`mmw-devs` maintainers of `ffxiv-race-ops`) | Open a PR against `mmw-tools` updating the matching field in `cordis.patch.yml`. The plugin author cannot auto-detect the change. |
| `cordis.patch.yml` mirror diverges from `AGENTS.md` | Plugin maintainer (`mmw-tools` repo) | Either bring `cordis.patch.yml` back in line, or revert the `AGENTS.md` change. The runtime warning will tell you which is stale. |
| Runtime warning "AGENTS.md drift detected" | Whoever is running `mmw_tools_run` | Stop pushing PRs until the mirror is updated. The plugin will still let you push (warning only), but doing so may violate `AGENTS.md`. |

---

## What the plugin actually checks at runtime

When `mmw_tools_run` starts (post-OAuth), the plugin:

1. Fetches `AGENTS.md` from the bound repo's `main` branch via the
   GitHub Contents API (`GET /repos/{owner}/{repo}/contents/AGENTS.md`).
2. Compares a few **keyword fingerprints** against the local config:
   - Does `AGENTS.md` mention `public/data.json` as the only allowed
     file? → matches `allowlistPaths`.
   - Does it mention `content/*` as the branch prefix? → matches
     `branchPrefix`.
   - Does it mention `npm run validate` (or `npm ci && npm run validate`)
     as a required pre-flight? → matches `preflight.cmd`.
3. On mismatch: emits a `ctx.logger.warn` line. **Does not block.**
4. Caches the fetched `AGENTS.md` to the plugin's local working dir
   for `mmw_tools_run`'s own use.

The fingerprints are intentionally dumb (substring matching). They will
not catch every edit, but they catch the big ones — renaming
`public/data.json`, changing the branch prefix, or removing the
pre-flight requirement.

---

## Long-term plan (v2+)

This v1 approach is the **least-bad option for a single-customer
plugin**. The full SSOT fix is in v2 and requires cooperation from the
`ffxiv-race-ops` maintainers:

1. Add a **machine-readable** rule file to `ffxiv-race-ops`, e.g.
   `.dsh-mmw-tools.yaml`:
   ```yaml
   version: 1
   allowlist: [public/data.json]
   denylist: [.github/workflows/**, schema/**, scripts/**, AGENTS.md, .pi/**]
   branchPrefix: content/
   preflight: npm run validate
   prDefaultDraft: true
   ```
2. The plugin fetches this YAML at `mmw_tools_run` startup and uses it
   as the **runtime authority** — `cordis.patch.yml` only stores the
   YAML's path (default `.dsh-mmw-tools.yaml`).
3. `cordis.patch.yml` no longer holds any rule fields; it only stores
   OAuth config and the repo coordinates.

This is the **proper SSOT fix**. It requires:

- One file added to `ffxiv-race-ops` (`.dsh-mmw-tools.yaml`).
- A coordinating PR that updates `cordis.patch.yml` in `mmw-tools` to
  drop the rule fields.
- Probably some renaming for clarity.

Until that lands, **this document is the maintenance contract**.

---

## What you do not need to do today

If you are running the plugin and the local config matches the
current `AGENTS.md`, **nothing**. The runtime check is silent.

If you see the warning in the logs, **stop and fix the mirror**.