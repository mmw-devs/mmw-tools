# Operations Sync — AGENTS.md ↔ cordis.patch.yml

> **TL;DR:** `ffxiv-race-ops/AGENTS.md` is the human-readable
> **authority** for repository operation rules. Since 2026-11-13 each
> registered repo's root `.dsh-mmw-tools.yaml` is the machine-readable
> runtime authority, read by the broker at selection/write time.
> `cordis.patch.yml` remains a bootstrap/fallback copy. The copies must
> agree; this document spells out who keeps them in sync and how.

---

## Why this document exists

`repoBinding` is the **default** entry. A profile may also list
`config.repos`; each session binds one with `select_repo`, and the broker
reads that repository's own `.dsh-mmw-tools.yaml`. The comments in
`cordis.patch.yml` are bootstrap documentation, not a second rule source.
The unused `repoBinding.pr` block was removed on 2026-11-14.

The default entry mirrors four rules that also live in
`mmw-devs/ffxiv-race-ops/AGENTS.md`:

| cordis.patch.yml field | AGENTS.md source rule |
|---|---|
| `allowlistPaths` | "唯一允许修改：`public/data.json`" |
| `denylistPaths` | derived from "不可改动" list |
| `branchPrefix` | "`content/*` 分支前缀" |
| `preflight.cmd` | "本地校验：`npm run validate`" |

This mirror was the v1 compromise (2026-11-10): the plugin reads these
fields at runtime to enforce guards, because parsing free-form
`AGENTS.md` is unsafe. On 2026-11-13 the machine-readable YAML rule
file landed, so the mirror is now **bootstrap/fallback**, not the
authority. The tradeoff is:

- ✅ Plugin runs without LLM-assisted parsing.
- ✅ Rules live next to the repo they describe.
- ⚠️ When `AGENTS.md` changes, the YAML and `cordis.patch.yml` do
  **not** update automatically. A mismatch logs a warning at
  `mmw_tools_run` startup.

`repoBinding` is the default entry, not the only repository. A profile
can add `config.repos` entries; the session binds one with
`select_repo`, and the broker reads that repository's own
`.dsh-mmw-tools.yaml` from its base branch. Comments in
`cordis.patch.yml` describe the default/fallback; they are not a second
rule source. The unused `repoBinding.pr` block was removed on
2026-11-14 rather than left as dead configuration.

---

## Who maintains what

| Change type | Owner | Action |
|---|---|---|
| `ffxiv-race-ops/AGENTS.md` rules change (e.g. "now `public/teams.json` is also editable") | The team that owns the ops repo (`mmw-devs` maintainers of `ffxiv-race-ops`) | Update the repo's `.dsh-mmw-tools.yaml`. For A (ops repo) the editable source is `mmw-devs/ffxiv-race-stats` `agent-src/.dsh-mmw-tools.yaml`; `sync-agent-src` copies it to the ops repo root. No `mmw-tools` PR is needed. |
| YAML rule file missing or invalid | Broker / plugin maintainer | Selection fails closed with `[mmw_policy_unavailable]`; fix the YAML, do not relax the loader. |
| `cordis.patch.yml` mirror diverges from `AGENTS.md` | Plugin maintainer (`mmw-tools` repo) | YAML wins at runtime; bring the mirror back in line only as a fallback for offline/status. |
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

## Machine-readable rule file (implemented 2026-11-13)

Each registered repo has a root `.dsh-mmw-tools.yaml`:

```yaml
version: 1
allowlistPaths: [public/data.json]
denylistPaths: [.github/workflows/**, schema/**, scripts/**, AGENTS.md, .pi/**]
branchPrefix: content/
preflight:
  cmd: npm run validate
  timeoutSeconds: 60
bootstrap:
  cmd: ""
  whenMissing: node_modules
  timeoutSeconds: 300
prDefaultDraft: true
```

Runtime behavior:

1. The **broker** fetches the YAML from the repo's base branch via the
   GitHub Contents API when a session selects a repo and when a write
   path needs the rules. It validates the file and caches it briefly
   (60s).
2. Missing/invalid/unreachable YAML fails closed:
   `repo-policy-missing` / `repo-policy-invalid` /
   `repo-policy-unavailable`; `select_repo` surfaces
   `[mmw_policy_unavailable]` and does not fall back to profile rules.
3. The plugin writes the merged result into
   `~/.dsh/mmw-tools-repos.json`; the MCP server reads that cache so
   preflight/bootstrap/allow/deny match the file.
4. The profile `repos`/`repoBinding` block still supplies
   `workingDir`, `tokenFile`, `repoUrl`, and serves as the bootstrap
   default before the first selection. It is no longer the authority
   for rule fields.

Remaining cleanup:

- Drop rule fields from `cordis.patch.yml` once the plugin can
  bootstrap from the registry cache alone.
- Add drift detection/status for "profile mirror ≠ YAML" (the AGENTS
  fingerprint warning is still the only drift signal).
- `contracts/` remains repo-agnostic; no per-repo contract files.

---

## What you do not need to do today

If you are running the plugin and the local config matches the
current `AGENTS.md`, **nothing**. The runtime check is silent.

If you see the warning in the logs, **stop and fix the mirror**.