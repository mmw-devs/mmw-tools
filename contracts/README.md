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
| `REFERENCE.md` | Generated human-readable roles, tools, and role-to-operation matrix. Do not hand-edit. |
| `ERRORS.md` | Stable error codes. |

## Current scope

The authoritative tool list, role list, and role-to-operation matrix are generated
in [`REFERENCE.md`](REFERENCE.md). This section only records the decisions behind
the current shape:

- `race-ops` is one tool. Its `tool.roles` is the conservative default
  (`operator`, `admin`) used by any operation that does not declare roles.
- `mmw-tools-status` is available to every authenticated member.
- The operation-level ladder is data, not code: `viewer` gets the read-only
  operations, `editor` adds worktree/pull/edit/PR creation, and `operator` /
  `admin` get everything, including `pr_merge` and `mmw_tools_run`. The exact
  matrix is generated in [`REFERENCE.md`](REFERENCE.md).
- `pr_merge` still has host confirmation and GitHub branch protection behind it.
  The Feishu role is the first of several gates, not the last one.

This is a guard against mistakes and accidental scope creep, not a boundary
against a malicious local user. The security boundary is the broker-issued
credential, the GitHub App permissions, branch protection, and CI validation.

## Operation-level roles

`tools.json` operations accept an optional `roles` array. When present, it
overrides the tool's roles for that operation. The gate and auth core both
resolve `operation.roles ?? tool.roles`, so changing the ladder is a data change,
not a gate rewrite. The route table includes both `allowed` tool IDs and
`allowedOperations` full IDs for that reason.

Every `race-ops` operation declares roles explicitly. The tool-level default
stays narrow (`operator`, `admin`) so a newly added operation is restricted
until someone deliberately widens it.

To change the ladder: edit `tools.json`, run
`node scripts/check-contracts.mjs --update`, review the generated route tables
and `REFERENCE.md`, then run the auth and plugin tests.

## Route table semantics

`GET /v1/agent/routes` is an authorization table:

- `allowed`: tool IDs for which **at least one** operation is available to the
  member. This is a coarse summary, not a per-call grant: a viewer sees
  `race-ops` here while `allowedOperations` contains only the read operations.
  The gate decides on `allowedOperations`.
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

- End-to-end verification from a reloaded desktop profile (the host still runs
  the previous module until it is restarted).
- A contract-drift check between the deployed `catalogRevision` and the plugin's
  local tool map.
