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

- `race-ops` is one atomic tool consumed by `operator` and `admin`. Its
  `requiredPermissions` are the tool's technical needs, not user grants.
- `mmw-tools-status` is available to every authenticated member.
- `viewer` and `editor` are reserved roles with no tools yet. Because `race-ops`
  is atomic in v2, granting them access would also grant edit/merge. Product
  confirmed on 2026-11-05 to keep them without race-ops access for now.
- `pr_merge` is an operation of `race-ops`. Under the current tool-level model,
  any role that can consume `race-ops` can reach it; the final protection is host
  confirmation + GitHub branch protection, not a separate Feishu permission.

## Operation-level roles

`tools.json` operations accept an optional `roles` array. When present, it
overrides the tool's roles for that operation. The gate and auth core both
resolve `operation.roles ?? tool.roles`, so introducing a narrower operation is
a data change, not a gate rewrite. The route table includes both `allowed` tool
IDs and `allowedOperations` full IDs for that reason.

The field is supported but **currently unpopulated**. Whether to split
`viewer`/`editor` onto read-only operations is an open product decision; see
[`docs/DOCUMENTATION.md`](../docs/DOCUMENTATION.md) and the routing design.

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

- End-to-end verification from a reloaded desktop profile (the host still runs
  the previous module until it is restarted).
- Operation-level role splits for `viewer` / `editor`; the contract supports
  them, but the role composition is waiting on a business decision.
- A contract-drift check between the deployed `catalogRevision` and the plugin's
  local tool map.
