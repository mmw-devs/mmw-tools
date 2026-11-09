# AGENTS.md — working agreement

Status: living

This repository treats documentation as part of the change, not as a follow-up.
`docs/DOCUMENTATION.md` defines the authority order; this file is the short
operating procedure for an agent.

## Before committing a source change

1. Run the impact check against the branch point and include uncommitted work:

   ```sh
   node scripts/doc-impact.mjs --base origin/main --worktree
   ```

   If the sandbox blocks git subprocesses, pass the changed paths explicitly:

   ```sh
   node scripts/doc-impact.mjs --changed "src/a.ts,README.md"
   ```

2. If it lists a document, update that document in the same change. Do not
   leave the update for a later PR.
3. If the document no longer defines the changed fact, change
   `docs/doc-map.json` instead of editing the document into a false statement.
4. Regenerate contract facts with
   `node scripts/check-contracts.mjs --update`, then review the generated diff.
5. Run the verification commands in the root [`README.md`](README.md#verify).

## Hard rules

- `contracts/tools.json` and `contracts/roles.json` are the contract source.
  `contracts/REFERENCE.md` and `contracts/examples/` are generated; never
  hand-edit them.
- Narrative documents link to the source of a volatile fact (counts, endpoint
  tables, role matrices, TTLs, hostnames, deployment status) instead of copying
  it. A vague sentence that stays true is better than a precise stale one.
- A document marked `historical` is a snapshot. Add a dated correction note; do
  not rewrite it to look current. A `target design` document must say what is
  not implemented.
- CI runs `node scripts/doc-impact.mjs` against the pull request base. A
  changed source whose document is untouched fails the build; so does a stale
  generated table in this file.

## Document map

<!-- doc-map:start -->
<!-- Generated from docs/doc-map.json. Do not edit by hand. -->
<!-- Regenerate with: node scripts/doc-impact.mjs --write-agents -->

| Document | Status | Defines | Update when these change |
|---|---|---|---|
| [`README.md`](README.md) | living | Repository entry point: deliverables, layout, and verification commands. | `.github/workflows/ci.yml`<br>`scripts/check-contracts.mjs`<br>`scripts/check-docs.mjs`<br>`scripts/doc-impact.mjs`<br>`mmw-tools-auth/deploy/backup.mjs`<br>`mmw-tools-auth/deploy/restore.mjs`<br>`mmw-tools-auth/deploy/healthcheck.sh`<br>`mmw-tools-auth/deploy/install-ops.sh`<br>`mmw-tools-auth/deploy/server-install.sh`<br>`mmw-tools-auth/deploy/nginx-mmw-tools.conf`<br>`mmw-tools-auth/deploy/systemd/**` |
| [`AGENTS.md`](AGENTS.md) | living | Agent operating rules and the generated document-impact map. | `docs/doc-map.json`<br>`scripts/doc-impact.mjs`<br>`scripts/check-docs.mjs`<br>`.github/workflows/ci.yml` |
| [`contracts/ERRORS.md`](contracts/ERRORS.md) | living | Stable error codes and the response envelope. | — (manual; no automatic trigger) |
| [`contracts/FIELDS.zh-CN.md`](contracts/FIELDS.zh-CN.md) | living | Field-by-field explanation of the v2 tool-centric contract. | `contracts/tools.json`<br>`contracts/roles.json`<br>`contracts/tools.schema.json`<br>`contracts/routes.schema.json` |
| [`contracts/REFERENCE.md`](contracts/REFERENCE.md) | generated | Generated snapshot of the role catalog, tool catalog, and role-to-operation matrix. | `contracts/tools.json`<br>`contracts/roles.json`<br>`mmw-tools-auth/src/policy.mjs` |
| [`contracts/README.md`](contracts/README.md) | living | The v2 contract model: tool roles, operation overrides, permissions, and generated artifacts. | `contracts/tools.json`<br>`contracts/roles.json`<br>`contracts/tools.schema.json`<br>`mmw-tools-auth/src/policy.mjs`<br>`scripts/check-contracts.mjs` |
| [`dsh-mmw-tools-design.md`](dsh-mmw-tools-design.md) | historical | Architecture and business-logic design (v2, aligned to the race-ops AGENTS.md). | — (snapshot; no automatic trigger) |
| [`docs/DEPLOYMENTS.md`](docs/DEPLOYMENTS.md) | historical | Append-only record of verified deployments. | — (snapshot; no automatic trigger) |
| [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md) | living | Documentation authority, status labels, generation rules, and impact checks. | `docs/doc-map.json`<br>`scripts/check-docs.mjs`<br>`scripts/doc-impact.mjs`<br>`.github/workflows/ci.yml` |
| [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md) | living | Run-id propagation, audit events, and the trace-storage decision. | `dsh-mmw-tools/src/util/run-context.ts`<br>`dsh-mmw-tools/src/util/audit.ts`<br>`dsh-mmw-tools/src/gate/gate.ts`<br>`dsh-mmw-tools/src/index.ts`<br>`dsh-mmw-tools/mcp-server/src/index.ts` |
| [`dsh-plugin-api-cheatsheet.md`](dsh-plugin-api-cheatsheet.md) | historical | Distilled DSH 0.1.5 plugin API reference. | — (snapshot; no automatic trigger) |
| [`github-oauth-app-checklist.md`](github-oauth-app-checklist.md) | historical | GitHub OAuth App registration checklist. | — (snapshot; no automatic trigger) |
| [`lark-vs-dsh.md`](lark-vs-dsh.md) | historical | Research notes comparing DSH Feishu plugins with lark-cli. | — (snapshot; no automatic trigger) |
| [`mmw-tools-routing-layer-plan.md`](mmw-tools-routing-layer-plan.md) | living | Why the authorization layer is shaped this way: decisions, boundaries, and known gaps. | `mmw-tools-auth/src/policy.mjs`<br>`dsh-mmw-tools/src/gate/gate.ts`<br>`dsh-mmw-tools/src/auth/feishu-auth.ts`<br>`dsh-mmw-tools/src/index.ts` |
| [`mmw-tools-routing-state-machine.md`](mmw-tools-routing-state-machine.md) | target design | Target state machines for auth, policy, and transport; not shipped behaviour. | `dsh-mmw-tools/src/gate/gate.ts`<br>`dsh-mmw-tools/src/auth/feishu-auth.ts`<br>`dsh-mmw-tools/src/index.ts`<br>`dsh-mmw-tools/src/util/run-context.ts` |
| [`dsh-mmw-tools/CHANGELOG.md`](dsh-mmw-tools/CHANGELOG.md) | historical | Per-increment history of the plugin. | — (snapshot; no automatic trigger) |
| [`dsh-mmw-tools/README.md`](dsh-mmw-tools/README.md) | living | Plugin install, configuration, tool behavior, security model, and tests. | `dsh-mmw-tools/src/**`<br>`dsh-mmw-tools/package.json`<br>`dsh-mmw-tools/cordis.patch.yml` |
| [`dsh-mmw-tools/docs/AUTH-BROKER.md`](dsh-mmw-tools/docs/AUTH-BROKER.md) | historical | Design record for the GitHub App + token broker topology. | — (snapshot; no automatic trigger) |
| [`dsh-mmw-tools/docs/INCREMENT-2-VERIFICATION.md`](dsh-mmw-tools/docs/INCREMENT-2-VERIFICATION.md) | historical | Client-bundle build decisions verified against DSH source. | — (snapshot; no automatic trigger) |
| [`dsh-mmw-tools/docs/INCREMENT-3-CHECKLIST.md`](dsh-mmw-tools/docs/INCREMENT-3-CHECKLIST.md) | historical | Per-tool hardening checklist. | — (snapshot; no automatic trigger) |
| [`dsh-mmw-tools/docs/INCREMENT-3-DESIGN.md`](dsh-mmw-tools/docs/INCREMENT-3-DESIGN.md) | historical | Design of the eight MCP tools. | — (snapshot; no automatic trigger) |
| [`dsh-mmw-tools/docs/INCREMENT-4-CHECKLIST.md`](dsh-mmw-tools/docs/INCREMENT-4-CHECKLIST.md) | historical | The mmw_tools_run contract and its non-LLM boundary. | — (snapshot; no automatic trigger) |
| [`dsh-mmw-tools/docs/INCREMENT-5-DESIGN.md`](dsh-mmw-tools/docs/INCREMENT-5-DESIGN.md) | historical | Audit events and storage decisions. | — (snapshot; no automatic trigger) |
| [`dsh-mmw-tools/docs/NEXT-STEPS.md`](dsh-mmw-tools/docs/NEXT-STEPS.md) | historical | Frozen v0.6.0 list of deliberately absent capabilities. | — (snapshot; no automatic trigger) |
| [`dsh-mmw-tools/docs/OPERATIONS-SYNC.md`](dsh-mmw-tools/docs/OPERATIONS-SYNC.md) | living | Who keeps race-ops AGENTS.md and cordis.patch.yml in sync. | `dsh-mmw-tools/cordis.patch.yml`<br>`dsh-mmw-tools/src/agents-md-check.ts` |
| [`dsh-mmw-tools/docs/PANEL-CONTRACT.md`](dsh-mmw-tools/docs/PANEL-CONTRACT.md) | living | Settings-panel state machine and action matrix. | `dsh-mmw-tools/src/client/**`<br>`dsh-mmw-tools/src/shared/api-paths.ts` |
| [`dsh-mmw-tools/docs/PUBLISHING.md`](dsh-mmw-tools/docs/PUBLISHING.md) | living | Release checklist and distribution channels. | `dsh-mmw-tools/package.json` |
| [`dsh-mmw-tools/docs/SETTINGS-PANEL-DESIGN.md`](dsh-mmw-tools/docs/SETTINGS-PANEL-DESIGN.md) | historical | Settings-panel design record. | — (snapshot; no automatic trigger) |
| [`dsh-mmw-tools/docs/T5-RUNBOOK.md`](dsh-mmw-tools/docs/T5-RUNBOOK.md) | living | Step-by-step real round-trip runbook and stop conditions. | — (manual; no automatic trigger) |
| [`dsh-mmw-tools/docs/TESTING.md`](dsh-mmw-tools/docs/TESTING.md) | living | Test layers, what each needs, and how to add a case. | `dsh-mmw-tools/package.json`<br>`dsh-mmw-tools/tests/**`<br>`dsh-mmw-tools/mcp-server/tests/**` |
| [`dsh-mmw-tools/skills/race-ops-ops/SKILL.md`](dsh-mmw-tools/skills/race-ops-ops/SKILL.md) | living | The race-ops-ops skill instructions. | — (manual; no automatic trigger) |
| [`mmw-tools-auth/README.md`](mmw-tools-auth/README.md) | living | Auth-core setup, endpoints, security properties, and limitations. | `mmw-tools-auth/src/server.mjs`<br>`mmw-tools-auth/src/main.mjs`<br>`mmw-tools-auth/src/auth.mjs`<br>`mmw-tools-auth/src/feishu.mjs`<br>`mmw-tools-auth/src/store.mjs` |
| [`mmw-tools-auth/deploy/README.md`](mmw-tools-auth/deploy/README.md) | living | Production deployment, resource budget, backup/restore, and rollback. | `mmw-tools-auth/deploy/backup.mjs`<br>`mmw-tools-auth/deploy/restore.mjs`<br>`mmw-tools-auth/deploy/healthcheck.sh`<br>`mmw-tools-auth/deploy/install-ops.sh`<br>`mmw-tools-auth/deploy/server-install.sh`<br>`mmw-tools-auth/deploy/nginx-mmw-tools.conf`<br>`mmw-tools-auth/deploy/systemd/**` |
<!-- doc-map:end -->

## Changing the map

Edit `docs/doc-map.json`, then run:

```sh
node scripts/doc-impact.mjs --write-agents
```

Commit both files. `scripts/doc-impact.mjs` validates that every document
exists, every status is known, and every source glob is repository-relative.
The table above is generated; do not edit it by hand.
