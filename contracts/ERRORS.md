# mmw-tools error codes

All JSON responses that fail use one envelope:

```json
{
  "error": "mmw_route_denied",
  "message": "调用 race-ops 需要 operator 或 admin 角色",
  "requestId": "optional"
}
```

- `error` is a stable machine-readable code.
- `message` is safe to show to the user/agent; it must not contain tokens,
  cookies, Feishu codes, file contents, or upstream error bodies.
- `requestId` is optional; the core/plugin may include it for correlation.

## Agent-facing codes

| Code | HTTP | When | Suggested message |
|---|---|---|---|
| `mmw_auth_required` | 401 | No plugin token / not logged in | 请先在 Settings → MMW Tools 使用飞书登录 |
| `mmw_session_expired` | 401 | Plugin token expired or revoked | 登录已过期，请重新登录 |
| `mmw_route_denied` | 403 | The operation is not in `allowedOperations` (v2), or the tool is not in `allowed` (v1) | 当前账号的角色不能消费该工具 |
| `mmw_policy_unavailable` | 503 | No usable authorization table, a malformed response, or an unreachable core | 暂时无法确认工具授权，请稍后重试 |
| `mmw_tool_unavailable` | 503 | Transport failed to start or crashed | 工具暂时不可用，请稍后重试 |
| `mmw_contract_mismatch` | 500 | Local implementation and catalog disagree (`publicName`, roles, or risk) | 插件与功能契约不一致，请升级插件 |

## How a refusal reaches the agent

HTTP clients get the JSON envelope above. MCP tool calls do not: the plugin
returns the refusal as an error message. Since the O1.2 change that message
starts with the code in brackets, followed by the human explanation:

```text
[mmw_route_denied] 当前账号的角色不能消费 race-ops；需要 operator / admin 角色
```

The bracketed prefix is the stable part; agents may branch on it. The prose after
it is not stable and may be translated. The gate can emit `mmw_auth_required`,
`mmw_session_expired`, `mmw_route_denied`, `mmw_policy_unavailable`, and
`mmw_contract_mismatch`.

`mmw_tool_unavailable` is transport-level. The gate does not emit it because the
policy decision runs before the MCP child starts, and the transport bridge does
not yet wrap its own failures with this code. Do not rely on it until that gap
is closed; see [`docs/CONFORMANCE.md`](../docs/CONFORMANCE.md).

## Internal / admin codes

| Code | HTTP | Meaning |
|---|---|---|
| `mmw_login_pending` | 202 | Browser authorization not completed yet. |
| `mmw_login_denied` | 403 | Feishu user is not allowed (tenant mismatch, disabled member, etc.). |
| `mmw_login_expired` | 410 | Login transaction expired or was already consumed. |
| `mmw_rate_limited` | 429 | Too many login/refresh attempts. |

## Rules

1. The plugin checks **Auth → Policy → Transport** in that order.
2. `mmw_route_denied` must never start an MCP child process.
3. `mmw_policy_unavailable` is the default for write tools when the policy is
   stale or the core is unreachable.
4. `mmw_tool_unavailable` leaves the tool registered; a later call may retry the
   transport.
5. Error messages never include the `pluginToken`, `pollSecret`, GitHub
   installation token, or Feishu authorization code.
