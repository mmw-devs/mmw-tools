# Panel contract — the plugin's user-visible state machine

Status: agreed 2026-10-26; amended 2026-11-11 for the Feishu credential path;
amended 2026-11-13 to remove the GitHub user login. This is the acceptance
standard for the panel and tool surface. If an implementation disagrees with
this document, the document wins.

The panel exists to answer one question: **is this plugin able to act on the
selected repository right now, and if not, what should the user do?** It has
exactly one login method — Feishu — because the broker holds the GitHub App
identity. The user never supplies a GitHub account, token, or OAuth grant.

---

## 1. What the plugin is for

A Feishu member whose role covers this repository, on their own machine, points
the DSH agent at the repository so it can make one change and open a draft PR
for a human to review. No GitHub account is needed. No auto-merge. No
multi-editor collaboration.

## 2. Two credentials, and why they must be reported separately

| Credential | Proves | Lifetime | Visible to the user |
|---|---|---|---|
| **Feishu plugin token** | this plugin instance is acting for a Feishu member with a role | 7 days | **yes** — it decides whether the plugin works |
| **repo access** (App installation token) | the broker may read the repository and push a branch | 1 h | **no**, only "ready / not ready" |

The Feishu token is not a repository credential. The broker exchanges it for a
short-lived, **read-only** installation token; writes go through the broker's
`/v1/write/*` proxy, which keeps the write token in memory. "Signed in" and
"can write" are different questions and are reported separately.

There is no GitHub session, no GitHub OAuth round trip, and no second settings
section.

## 3. States — one phase, plus the panel's local sign-in substate

```
 ① signed_out
      │  [ 使用飞书登录 ] → open the auth core in the browser
      ▼
 ② authorizing                    (panel-local; the status route stays signed_out)
      │  browser completes, the plugin polls the auth core
      ▼
 ③ signed_in                      (mode = feishu; repoAccess ∈ {ready, unavailable})
```

The status route has exactly two phases:

- `signed_out`: no valid Feishu plugin token.
- `signed_in`: a valid Feishu plugin token exists. `mode` is `feishu`.

`authorizing` is a substate of the Feishu panel, not a route phase. **There is no
`expired` phase**: an expired token is `signed_out`, and the panel says the
credential expired. "The installation token file is missing" is not a state
either — it is `repoAccess = unavailable` inside ③.

## 4. Actions

| Action | ① signed_out | ② authorizing | ③ signed_in |
|---|---|---|---|
| 使用飞书登录 | ✅ | — | — |
| 等待浏览器授权 | — | ✅ (status only) | — |
| 退出飞书 | — | — | ✅ |

Anything not marked ✅ must not be rendered. "Rendered but inert" is the
failure this table prevents. There is no GitHub login, refresh, revoke, or
"重新获取仓库权限" control; repo access recovers automatically on the next
token exchange.

## 5. Three things the plugin does by itself

1. **Authorization polling.** On entering ②, poll the auth core until the
   browser completes or the attempt expires. Success → ③. Failure → ① with the
   reason shown. The user never has to confirm that they finished in the
   browser, so there is no "I have authorized" control.
2. **Repo access.** On entering ③, obtain an installation token immediately;
   re-obtain it when less than 10 minutes remain. Failure sets
   `repoAccess = unavailable` with the reason; the next successful exchange
   clears it.
3. **Token rotation.** A watchdog refreshes the Feishu plugin token before it
   expires and replaces the local record. A rotation never deletes a newer
   token written by a concurrent request.

## 6. Panel rendering, per state

```
①  MMW Tools
    未登录 · <原因，例如「飞书授权已过期」>
    使用飞书登录即可开始；GitHub 账号不是必需的。
    [ 使用飞书登录 ]

②  MMW Tools
    等待浏览器授权 · 剩余 4:37
    请在浏览器完成授权，完成后会自动继续。

③ ready  MMW Tools
    已登录（飞书）· weunimix · 仓库令牌剩余 53 分钟
    仓库权限：就绪
    [ 退出飞书 ]

③ unavail  MMW Tools
    已登录（飞书）· weunimix · 仓库令牌剩余 53 分钟
    仓库权限：不可用 · <原因>
    [ 退出飞书 ]
```

`仓库令牌剩余` is the broker-issued installation token (1 hour, renewed
automatically). The Feishu authorization itself (default 7 days) is shown in the
same panel as `飞书授权剩余`.

## 7. Agent tools

| Tool | Returns |
|---|---|
| `mmw_tools_status` | the same state the panel shows, in text, plus `workspace` |
| `mmw_tools_run` | AGENTS.md + README excerpts, branch suggestion, binding |
| `select_repo` | binds this session to one registered repository |

Signing in is a human action. The agent must not be able to start, poll, refresh
or revoke a sign-in, so none of those is exposed as a tool.

## 8. Status payload contract

The route and `mmw_tools_status` return one shape:

```json
{
  "phase": "signed_out" | "signed_in",
  "mode": "none" | "feishu",
  "session": { "login": "weunimix", "expiresAt": 0, "secondsRemaining": 0 },
  "repoAccess": { "state": "ready" | "unavailable", "reason": "" },
  "binding": { "owner": "mmw-devs", "name": "ffxiv-race-ops",
               "baseBranch": "main", "allowlistPaths": ["public/data.json"] },
  "brokerUrl": "https://…"
}
```

`session.login` is the Feishu display name; `session.expiresAt` and
`secondsRemaining` describe the Feishu plugin token. The installation token is
reported only through `repoAccess`.

Explicitly **not** in this payload: `sessionPath`, `accessTokenMasked`,
`accessTokenExpiresAt`, `refreshTokenExpiresAt`, `scope`, `configured`.

## 9. Acceptance checks

1. From ①, `mmw_tools_status` reports `phase = signed_out`, `mode = none`, and
   the panel renders exactly one action: 使用飞书登录.
2. Starting a Feishu login moves the panel to `authorizing`; it renders the
   waiting state and no confirm button.
3. Completing authorization without any further user action moves to
   `signed_in`, reports `mode = feishu`, and shows the Feishu login.
4. From ③, `repoAccess` is `ready` within one token exchange of entering the
   state.
5. 退出飞书 returns to ①, deletes the local Feishu/write-auth/installation
   files, and tells the auth core to drop the session.
6. An expired Feishu token reports `signed_out`, never `signed_in`.
7. The panel never renders an action that this document does not permit in the
   current state.
8. The status route exposes exactly `phase`, `mode`, `session`, `repoAccess`,
   `binding`, and `brokerUrl`; no token material.
9. There is exactly one settings section, `id = mmw-tools`; no
   `mmw-tools-feishu` section and no GitHub controls.

## 10. Removed by this contract

- The GitHub settings section and the `MMW Tools 授权` duplicate.
- Panel: `登录 GitHub`, `重新获取仓库权限`, `退出登录` (GitHub), and all
  Device-Flow wording.
- Routes: `/api/mmw-tools/oauth/start`, `/finish`, `/refresh`, `/revoke`.
- Agent: `engineer_oauth_start`, `engineer_oauth_finish`,
  `engineer_oauth_refresh`, `engineer_oauth_revoke`.
- Status fields listed in §8.

## 11. Open, deliberately not covered

- **ICP filing.** Until `mmw-team.icu` clears review, public HTTPS is
  intercepted. The plugin logic is independent of that; the transport is not.
  Documented in `AUTH-BROKER.md`.
- **GitHub App permissions.** The broker's App must retain the repository
  contents and pull-request permissions; that is broker configuration, not a
  panel concern.
- **The MCP child's credential files.** They stay 0600 files refreshed by the
  host. This contract only requires that a failure surface as
  `repoAccess = unavailable`.
