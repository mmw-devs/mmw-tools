# mmw-tools contracts (v2, tool-centric)

This directory is the **shared contract** between the Feishu authorization core
and the DSH plugin. The model has two read-only views:

```
permission view:  tool -> requiredPermissions   (what the tool needs)
tool view:        tool -> roles                  (who may consume the tool)
```

There is **no role → permission table**. A role is a member label; a tool
declares which roles may consume it and which technical permissions it needs.

## Files

| File | Purpose |
|---|---|
| `tools.json` | Tool catalog: roles, requiredPermissions, operations, risk. |
| `tools.schema.json` | JSON Schema for `tools.json`. |
| `roles.json` | Member roles only; no permissions. |
| `roles.schema.json` | JSON Schema for `roles.json`. |
| `routes.schema.json` | JSON Schema for `GET /v1/agent/routes`. |
| `FIELDS.zh-CN.md` | Chinese field reference. |
| `examples/routes.<role>.json` | Golden route tables generated from tools + roles. |
| `ERRORS.md` | Stable error codes. |

## Current scope

- `race-ops`: one atomic tool. Roles: `operator`, `admin`.
  - 11 operations: `repo_status`, `repo_clone`, `repo_pull`, `repo_read`,
    `repo_search`, `repo_edit`, `pr_create`, `pr_list`, `pr_preview`,
    `pr_merge`, `mmw_tools_run`.
  - `requiredPermissions`: `github:contents:write`, `github:pull_requests:write`.
    These are the tool's technical needs, not user grants.
- `mmw-tools-status`: `always: true`; one operation `mmw_tools_status`.
- `viewer` and `editor` are reserved roles with no tools yet. `race-ops` is
  atomic in v2, so they cannot consume it without also getting edit/merge.
- `pr_merge` is an operation of `race-ops`. Under model A, any role that can
  consume `race-ops` can reach it; the final protection is host confirmation +
  GitHub branch protection, not a separate Feishu permission.

## Future: operation-level roles

`tools.json` operations accept an optional `roles` array:

```json
"operations": [
  {
    "id": "pr_merge",
    "publicName": "mcp__mmw-tools__pr_merge",
    "risk": "write",
    "roles": ["admin"]
  }
]
```

When present, it overrides the tool's roles for that operation. The gate already
resolves `operation.roles ?? tool.roles`, so moving from model A to model B is a
data change, not a gate rewrite. The route table includes both `allowed` tool IDs
and `allowedOperations` full IDs for that reason.

## Route table semantics

`GET /v1/agent/routes` is an authorization table:

- `allowed`: tool IDs the member may consume.
- `allowedOperations`: operation full IDs (`toolId.operationId`) the member may
  call; the gate checks this first.
- `denied`: tools the member cannot consume, with `requiredRoles`.
- `catalogRevision`: SHA-256 of `tools.json`.
- `policyRevision`: increments when member roles change.
- `ttlSeconds`: 60.

## Verify

```sh
node scripts/check-contracts.mjs
node scripts/check-contracts.mjs --update   # after an intentional change
```

## Can I put comments in the JSON?

No. `tools.json` and `roles.json` are strict JSON; `JSON.parse` rejects comments.
Use the schema `description` fields and [`FIELDS.zh-CN.md`](FIELDS.zh-CN.md)
instead.

## What v2 does not include yet

- The plugin's Feishu gate (static registration already exists; the gate is the
  next increment).
- Real Feishu plugin login verification.
- Operation-level role splits for `viewer` / `editor`.
