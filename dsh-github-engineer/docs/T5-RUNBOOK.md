# T5 Runbook — one real round trip against `mmw-devs/ffxiv-race-ops`

This is the only test that proves the plugin works against the **real**
target repository with a **real** GitHub token. Everything else is
offline: the unit and integration suites build throwaway repos, and
`pr_create` is only exercised up to its guards.

**Read the whole page before starting.** Steps 1–4 are reversible
environment setup. Step 5 is a gate. Steps 6–9 write to the real repo.

---

## What this proves

| Claim | Proven by |
|---|---|
| The binding survives installation into a real DSH profile | step 3 |
| Device Flow works end to end (browser → token → store) | step 6 |
| The token is actually delivered to the MCP child | step 7 |
| `preflight` and `bootstrap` work on the real checkout | step 8 |
| `repo_edit` rollback holds on the real repo | step 8b |
| `pr_create` produces a **draft** PR touching only the allowlist | step 9 |

## What it does not prove

- The agent's own multi-step judgement (`engineer_run` returns context;
  you still drive the tools).
- The Settings panel rendering in a browser.
- Behaviour after 8 hours of token life.

## Risks, stated plainly

- A **draft PR appears in the operations repo** and is closed within
  minutes. It is never merged. Merging is what triggers deployment, so
  production is not touched.
- A short-lived `content/e2e-<date>` branch is pushed and then deleted.
- The audit log gains a few lines. It never contains a token.

## Stop conditions — abort immediately if any occur

1. `engineer_status` shows an **empty or wrong** `owner`/`name`.
2. `engineer_status` shows `allowlistPaths` other than exactly
   `public/data.json`.
3. `preflight.cmd` is anything other than `npm run validate`.
4. `repo_edit` reports success but `git status` in the working
   directory is not clean.
5. The PR is **not** marked draft, or touches any path besides
   `public/data.json`.

---

## 1. Build

The profile links to this checkout, so the bundles must be current.

```powershell
cd <path-to>\mmw-tools\dsh-github-engineer
pnpm install --frozen-lockfile
cd mcp-server; pnpm install --frozen-lockfile; pnpm build; cd ..
pnpm build:all
```

Expect `lib\index.js`, `lib\client.js`, and `mcp-server\dist\index.js`.

## 2. Create an isolated profile

Do **not** install into `desktop` — that is the profile you are using
right now, and a half-loaded plugin would spoil it. `t5` is disposable.

```powershell
$dsh = "C:\Users\weunimix\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh --profile t5 --from-default-profile web --dump-config
```

`--dump-config` prints and exits, which is enough to lay the profile
down without booting anything.

## 3. Install the plugin

```powershell
& $dsh plugin --profile t5 add link:C:\Users\weunimix\Desktop\WorkLibrary\ffxivStrategy\mmw-tools\dsh-github-engineer
```

Then confirm the row is in the composed profile:

```powershell
& $dsh --profile t5 --dump-config | Select-String -Context 0,6 "github-engineer"
```

Expect `id: github-engineer`, `name: dsh-github-engineer`, and the
`repoBinding` block from the plugin's `cordis.patch.yml`.

## 4. Point it at a working directory

The plugin deliberately does **not** ship a `workingDir` — it is
machine-specific. Supply it one of two ways.

Quickest (per session):

```powershell
$env:GHOST_WORKING_DIR = "C:\Users\weunimix\.dsh\workspaces\mmw-devs\ffxiv-race-ops"
```

Durable (survives restarts): create `t5-overlay.yml` anywhere outside
the profile:

```yaml
- insert:
    - id: github-engineer
      name: dsh-github-engineer
      config:
        workingDir: C:\Users\weunimix\.dsh\workspaces\mmw-devs\ffxiv-race-ops
```

and boot with `& $dsh web --profile t5 --patch .\t5-overlay.yml`.

## 5. Gate — boot and check the binding before any write

```powershell
& $dsh web --profile t5
```

Open the URL it prints. The Settings panel for `dsh-github-engineer`
appears inside DSH. Then ask the agent:

> Call `engineer_status` and show me the full result.

**Do not continue unless all of these hold:**

- `owner` = `mmw-devs`, `name` = `ffxiv-race-ops`
- `baseBranch` = `main`, `branchPrefix` = `content/`
- `allowlistPaths` = `["public/data.json"]` exactly
- `preflightCmd` = `npm run validate`
- `workingDir` = the path from step 4, **not empty**
- `auth` = `no_token`

An empty `workingDir` or empty `owner` means step 4 did not take — stop
and fix it. That is precisely the failure this gate exists for.

## 6. Authorize

Ask the agent:

> Call `engineer_oauth_start`, then tell me the code and the URL.

Open the URL, enter the code, approve. Then:

> Call `engineer_oauth_finish` and keep polling until it stops saying
> pending, then call `engineer_status`.

Expect `auth` = `authorized`, a `login` that matches your GitHub
account, and scopes containing `repo`.

## 7. Clone and read

> Call `repo_clone`, then `repo_read` on `public/data.json`, and show me
> the first 20 lines.

Expect a clean clone and real content. If `repo_clone` fails with an
auth error here, the token did not reach the child — stop.

## 8. The edit

Ask the agent to change exactly one field and commit:

> Use `repo_edit` on branch `content/e2e-<today's date>` to change the
> value of `updated` in `public/data.json` to today's date as
> `YYYY-MM-DD`, commit message `content: e2e check <date>`. Use
> `replace` mode and read the file first so the `find` string matches
> byte for byte — this checkout may use CRLF.

Expected on the first edit: `bootstrap.ran` = `true`, `preflight.exit_code`
= `0`, a new commit, and a clean tree.

### 8b. The rollback

> Now use `repo_edit` again on the same branch to replace `"teams": [`
> with `"teams": {`, commit message `content: e2e invalid`.

Expect refusal with `preflight-failed`. Then verify from PowerShell:

```powershell
cd C:\Users\weunimix\.dsh\workspaces\mmw-devs\ffxiv-race-ops
git status --porcelain      # expect empty
git log --oneline -1        # expect the step-8 commit, not a new one
```

A dirty tree or an extra commit means rollback is broken — stop and
send me the output.

## 9. The draft PR

> Use `pr_create` with head branch `content/e2e-<date>`, a title
> starting with `[e2e-test]`, and a short Chinese body. Draft only.

Verify from PowerShell:

```powershell
gh pr list --repo mmw-devs/ffxiv-race-ops --head "content/e2e-<date>" --json number,isDraft,files,title
```

Expect `isDraft: true` and `files` = `[public/data.json]` only.

## 10. Clean up — do this even if step 9 failed

```powershell
gh pr close <number> --repo mmw-devs/ffxiv-race-ops --delete-branch
```

Then revoke authorization: GitHub → Settings → Applications →
the OAuth app → Revoke. Finally, in the DSH panel, click **Revoke** so
the local store is cleared.

## 11. Hand back

Send me:

- the `engineer_status` output from step 5 (redact the token if it ever
  appears — it should not),
- the `repo_edit` result JSON from steps 8 and 8b,
- the `gh pr list` output from step 9,
- any refusal message verbatim.

I will then check the audit trail:

```powershell
Get-Content $env:USERPROFILE\.dsh\dsh-github-engineer-audit.jsonl -Tail 20
```

and confirm no token material appears in it, and that
`~\.dsh\dsh-github-engineer.json` is mode 0600.

## Cleaning up the profile afterwards

```powershell
& $dsh plugin --profile t5 remove dsh-github-engineer
Remove-Item -Recurse -Force $env:USERPROFILE\.dsh\profiles\t5
```
