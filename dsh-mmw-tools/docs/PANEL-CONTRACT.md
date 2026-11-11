# Panel contract — the plugin's user-visible state machine

Status: agreed 2026-10-26; amended 2026-11-11 for the Feishu credential path.
This is the acceptance standard for the panel and tool surface. If an
implementation disagrees with this document, the document wins.

The reason this exists: the panel accumulated controls from two auth
models (personal Device Flow, then broker) and was never redesigned. The
result was four to five buttons, most of them inert in most states, one
"tell me you finished" pseudo-step, and a status field that answered an
implementation question instead of the user's. Every one of those
symptoms traces back to the missing statement below.

---

## 1. What the plugin is for

A member of `mmw-devs`, or a Feishu member whose role covers this
repository, on their own machine, points the DSH agent at
`public/data.json` of `mmw-devs/ffxiv-race-ops` so it can make one change
and open a draft PR for a human to review. The Feishu path needs no
GitHub account. No auto-merge. No multi-editor collaboration.

## 2. Three credentials, and why conflating them caused the confusion

| Credential | Proves | Lifetime | Visible to the user |
|---|---|---|---|
| **GitHub session** | this plugin instance is acting for <login> | 12 h | **yes** — it decides whether the plugin works |
| **Feishu plugin token** | this plugin instance is acting for a Feishu member with a role | token TTL | **yes** — it also decides whether the plugin works |
| **repo access** (App installation token) | git may push a branch and open a PR | 1 h | **no**, only "ready / not ready" |

The session and the Feishu token cannot write to a repository. The
installation token is derived from either of them, on demand, and stays
in memory plus a 0600 file that the MCP child reads. "Signed in" and
"can write" are therefore different questions and must be reported
separately; "signed in" now has a `mode` (`github` or `feishu`).

## 3. States — exactly four

```
 ① signed_out
      │  [登录 GitHub（可选）] → open broker login URL in the browser
      │  (or the separate 飞书授权 section completes)
      ▼
 ② authorizing                    (GitHub browser round trip, ≤5 min)
      │  broker reports authorized, or Feishu login completes
      ▼
 ③ signed_in                      (mode ∈ {github, feishu}; repoAccess ∈ {ready, unavailable})
      │  credential expires
      ▼
 ④ expired  ──→ behaves as ① for actions, but says why
```

The predicates are exact:

- `①`: no valid GitHub session and no valid Feishu plugin token.
- `②`: a GitHub sign-in was started by this process and has not been resolved.
- `③`: a valid GitHub session OR a valid Feishu plugin token exists.
- `④`: a GitHub session existed and expired, and there is no valid Feishu token.

There is no fifth state. In particular, "the installation token file is
missing" is **not** a state — it is `repoAccess = unavailable` inside ③.
The Feishu panel has its own substates, but it does not add a phase to
this state machine.

## 4. Actions — at most two on screen at any time

| Action | ① | ② | ③ | ④ |
|---|---|---|---|---|
| 登录 GitHub（可选） | ✅ | — | — | ✅ |
| 取消 | — | ✅ | — | — |
| 重新获取仓库权限 | — | — | only if `repoAccess ≠ ready` and `mode ≠ feishu` | — |
| 退出登录 | — | ✅ | ✅ (`mode = github` only) | — |

Anything not marked ✅ must not be rendered. "Rendered but inert" is the
specific failure this table exists to prevent. In `mode = feishu` the
panel renders no actions at all: the Feishu section owns its own login
and logout, and the GitHub credential does not exist to refresh or
revoke.

## 5. Three things the plugin does by itself

1. **Authorization polling.** On entering ②, poll the broker every 2 s
   for at most 5 min. Success → ③. Denied or timed out → ① (or ④) with
   the reason shown. The user never has to confirm that they finished in
   the browser, so there is no "I have authorized" control.
2. **Repo access.** On entering ③, obtain an installation token
   immediately; re-obtain it when less than 10 min remain. Failure sets
   `repoAccess = unavailable` with the reason, and offers 重新获取.
3. **Expiry.** When the session lapses, transition to ④ on the next tick.

## 6. Panel rendering, per state

```
① / ④   MMW Tools
        未登录 · <原因如「会话已过期」>
        优先在下方「飞书授权」登录；GitHub 账号不是必需的。
        [ 登录 GitHub（可选） ]

②       MMW Tools
        等待浏览器授权 · 剩余 4:37
        请在浏览器完成授权，完成后会自动继续。
        [ 取消 ]

③ ready MMW Tools
        已登录 · weunimix · 会话剩余 11h 32m
        仓库权限：就绪
        [ 退出登录 ]

③ feishu MMW Tools
        已登录（飞书）· 张三 · 令牌剩余 9h 12m
        仓库权限：就绪
        (no actions; 飞书授权 section shows its own logout)

③ unavail MMW Tools
        已登录 · weunimix · 会话剩余 11h 32m
        仓库权限：不可用 · <原因>
        [ 重新获取 ]  [ 退出登录 ]
```

No `Connect GitHub`, no `我已完成授权`, no `刷新`, no empty status row.

## 7. Agent tools — two

| Tool | Returns |
|---|---|
| `mmw_tools_status` | the same state the panel shows, in text |
| `mmw_tools_run` | AGENTS.md + README excerpts, branch suggestion, binding |

Signing in is a human action. The agent must not be able to start, poll,
refresh or revoke a sign-in, so none of those is exposed as a tool. This
replaces the former four `engineer_oauth_*` tools.

## 8. Status payload contract

The route and `mmw_tools_status` return one shape:

```json
{
  "phase": "signed_out" | "authorizing" | "signed_in" | "expired",
  "mode": "none" | "github" | "feishu",
  "session": { "login": "weunimix", "expiresAt": 0, "secondsRemaining": 0 },
  "repoAccess": { "state": "ready" | "unavailable", "reason": "" },
  "binding": { "owner": "mmw-devs", "name": "ffxiv-race-ops",
               "baseBranch": "main", "allowlistPaths": ["public/data.json"] },
  "brokerUrl": "https://…",
  "sessionPath": "…"
}
```

`session.login` and `session.expiresAt` describe whichever credential is
active: the GitHub login/session for `mode = github`, the Feishu display
name/plugin-token expiry for `mode = feishu`.

Explicitly **not** in this payload: `accessTokenMasked`,
`accessTokenExpiresAt`, `refreshTokenExpiresAt`, `scope`, `configured`.
Those were OAuth-era fields that described the wrong thing once the
session and the repo token split; keeping them is what let the panel show
"configured: true" beside "status: no_token".

## 9. Acceptance checks

These are the assertions the rewrite must satisfy — no others.

1. From ①, `mmw_tools_status` reports `phase = signed_out` and the panel
   renders exactly one action.
2. Starting a sign-in moves to `authorizing`; the panel renders 取消 and a
   countdown, and no confirm button.
3. Completing authorization without any further user action moves to
   `signed_in` and shows the login. A Feishu login with no GitHub session
   does the same and reports `mode = feishu`.
4. From ③, `repoAccess` is `ready` within one token exchange of entering
   the state.
5. Revoking the GitHub session from ③ (`mode = github`) returns to ① and
   deletes both local files. In `mode = feishu` the GitHub panel offers no
   revoke; the Feishu section revokes its own credential.
6. A session past `expiresAt` reports `expired`, never `signed_in` —
   unless a valid Feishu credential also exists, in which case ③ holds
   with `mode = feishu`.
7. The panel never renders an action that this document does not permit
   in the current state.
8. `mmw_tools_status` and `mmw_tools_run` are the only agent tools.
9. In `mode = feishu`, `mmw_tools_status` and the route report
   `mode = feishu`, and the GitHub panel renders no action buttons.

## 10. Removed by this contract

- Panel: `Connect GitHub` (device-flow wording), `我已完成授权`,
  `刷新`, the user-code box, the copy-code button, the
  `verificationUri` open button as a separate control.
- Agent: `engineer_oauth_start`, `engineer_oauth_finish`,
  `engineer_oauth_refresh`, `engineer_oauth_revoke`.
- Status fields listed in §8.

## 11. Open, deliberately not covered

- **ICP filing.** Until `mmw-team.icu` clears review, public HTTPS is
  intercepted. The plugin logic is independent of that; the transport is
  not. Documented in `AUTH-BROKER.md`.
- **Allowlist mode.** `org` mode needs the App's *Members: Read*
  permission; until it is added, `list` mode is used.
- **The MCP child's credential file.** It stays a 0600 file refreshed by
  the host (see AUTH-BROKER.md). This contract only requires that its
  failure surface as `repoAccess = unavailable`.
