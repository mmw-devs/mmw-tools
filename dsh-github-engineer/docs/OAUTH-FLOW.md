# OAuth Device Flow — User Guide

> **For end users.** What happens when you click "Connect GitHub" in
> the DSH settings panel, and how to drive it from the agent.

---

## What this plugin does to authenticate

The plugin uses **GitHub's Device Authorization Grant** (RFC 8628).
You will, exactly once:

1. Tell the plugin to start an authorization (`engineer_oauth_start`).
2. Open `https://github.com/login/device` in **any** browser.
3. Type the 8-character `user_code` the plugin printed.
4. Click **Authorize**.

After that, the plugin holds an OAuth token for **8 hours**. When the
token is about to expire, the plugin transparently refreshes it using a
**refresh token** that lives for **6 months**. You don't need to do
anything — until you revoke the app on GitHub or the refresh token
expires (whichever comes first).

---

## The two ways to drive it

### A. Via the agent (most common)

In any DSH conversation, ask the agent to call:

```
engineer_oauth_start
```

The agent will print something like:

```
user_code: ABCD-1234
verification_uri: https://github.com/login/device
expires_at: 2026-05-12T14:22:00Z
```

You then:

1. Open <https://github.com/login/device> in a browser.
2. Type `ABCD-1234`, click **Authorize**.
3. Tell the agent: "done" / "authorized" / anything.

The agent will then call `engineer_oauth_finish` to poll GitHub.
GitHub returns the access token, the plugin persists it to
`~/.dsh/dsh-github-engineer.json` (mode 0600), and you're done.

### B. Via the loopback HTTP API

If you have a custom UI / debugging tool, the plugin exposes the same
flow as plain HTTP. All endpoints are loopback-only.

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET`  | `/api/github-engineer/status` | — | Public, secret-free state |
| `POST` | `/api/github-engineer/oauth/start` | — | Start a Device Flow |
| `POST` | `/api/github-engineer/oauth/finish` | (empty) | Poll once |
| `POST` | `/api/github-engineer/oauth/refresh` | (empty) | Force a refresh |
| `POST` | `/api/github-engineer/revoke` | (empty) | Wipe local credentials |

Example (with `curl`):

```bash
# 1. start
curl -X POST http://127.0.0.1:3080/api/github-engineer/oauth/start

# 2. user authorizes in their browser

# 3. poll (run repeatedly until ok=true)
curl -X POST http://127.0.0.1:3080/api/github-engineer/oauth/finish
```

The DSH web server's port is whatever `ctx.webServer.port` reports;
the default is `3080`. The `127.0.0.1` host is enforced — any request
from a non-loopback address gets `403 forbidden`.

---

## What gets stored where

| Path | Contents | Mode | Notes |
|---|---|---|---|
| `~/.dsh/dsh-github-engineer.json` | `accessToken`, `refreshToken`, expiries, `scope`, `login` | `0600` | Created on first successful Device Flow. Wiped by `engineer_oauth_revoke`. |
| (in memory) | `pending` flow (device_code + user_code + interval + expiresAt) | — | Lost when DSH restarts mid-flow. |

The token is **never** written to:
- Logs (logger filters tokens)
- Commit messages / PR bodies (regex blacklist in `pr_create`)
- Session log (only metadata — timestamps, PR numbers)
- Cloud storage

---

## Common error states

| Agent tool output | Meaning | What to do |
|---|---|---|
| `authorization_pending` | User hasn't typed the code yet | Wait, then call `engineer_oauth_finish` again |
| `slow_down` | You're polling too fast | The plugin auto-extends the interval by 5s. Just retry. |
| `expired_token` | 5 min passed without authorization | Call `engineer_oauth_start` again to get a fresh code |
| `access_denied` | User clicked "Cancel" on GitHub | Call `engineer_oauth_start` to retry |
| `invalid_grant` (from refresh) | refresh_token is dead/expired (>6 months no use) | Call `engineer_oauth_start` to fully re-authorize |
| `engineer_status` reports `reauth_needed` | Token is invalid; refresh failed | Call `engineer_oauth_start` |

---

## How to revoke (and what revocation does)

| Action | Effect |
|---|---|
| `engineer_oauth_revoke` (in agent) | Wipes `~/.dsh/dsh-github-engineer.json`. The token is still valid on GitHub's side until you also revoke it there. |
| GitHub → Settings → Applications → "dsh-github-engineer" → Revoke | GitHub invalidates the token and the refresh_token. The plugin will see 401 on the next API call and switch to `reauth_needed`. |
| Delete the OAuth App on GitHub | Same effect as above, plus no future authorizations are possible. **Don't do this** while the plugin is the only thing keeping your DSH agent authenticated. |

Recommended cleanup: revoke **both** ways when retiring a host.

---

## What happens when something goes wrong silently

The plugin's refresh watchdog runs every 60 seconds. If the access
token is within 5 minutes of expiry, the watchdog calls
`ensureFresh()` which uses the refresh token to get a new one. The
process is invisible unless you read the DSH log:

```
github-engineer: access_token auto-refreshed
```

If `ensureFresh()` fails (refresh_token revoked, network down, etc.),
the watchdog logs an `error` and `engineer_status` will report
`reauth_needed`.

---

## FAQ

**Q: Can I use this OAuth App on multiple machines?**
A: Yes. Each machine runs its own Device Flow and stores its own
`~/.dsh/dsh-github-engineer.json`. GitHub issues one token per
authorization, so they don't share tokens. If you want to share
credentials between machines, use `gh auth login` on each — the
plugin does not export or import tokens.

**Q: Why don't we just use my existing `gh auth login` token?**
A: `gh` stores its token in `~/.config/gh/hosts.yml`. Reading it would
require a custom parser for `gh`'s config format, plus `gh` uses a
different OAuth flow (web flow with localhost callback). The Device
Flow token is independent and lives in the plugin's own file.

**Q: Can I delete `~/.dsh/dsh-github-engineer.json` and start fresh?**
A: Yes. The next `engineer_oauth_start` will overwrite it. No
permanent state is lost on GitHub's side.

**Q: Will the agent see my token in `engineer_status` output?**
A: No. The agent-facing view masks tokens (`gho_****abcd`). Only the
internal `getAccessToken()` accessor hands out the raw token, and it is
never logged.