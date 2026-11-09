# Documentation rules (SSOT)

This repository has repeatedly accumulated documentation that copied facts from
code and then drifted. The rule is now: **a document may be incomplete, but it
must not state a current fact it cannot keep true.** Vague and linked beats
specific and stale.

## Authority order

When two documents disagree, the higher entry wins:

| Fact | Source of truth |
|---|---|
| Tools, operations, roles, permission requirements | [`contracts/tools.json`](../contracts/tools.json), [`contracts/roles.json`](../contracts/roles.json) |
| Human-readable contract tables | [`contracts/REFERENCE.md`](../contracts/REFERENCE.md) — generated, never hand-edited |
| Route table semantics | [`mmw-tools-auth/src/policy.mjs`](../mmw-tools-auth/src/policy.mjs) |
| Auth-core endpoints and HTTP behaviour | [`mmw-tools-auth/src/server.mjs`](../mmw-tools-auth/src/server.mjs) |
| Plugin tool map and gate | [`dsh-mmw-tools/src/gate/`](../dsh-mmw-tools/src/gate/) |
| Plugin version and scripts | [`dsh-mmw-tools/package.json`](../dsh-mmw-tools/package.json) |
| Deployment layout and host operations | [`mmw-tools-auth/deploy/`](../mmw-tools-auth/deploy/) |
| Documentation ownership and impact triggers | [`docs/doc-map.json`](doc-map.json) |
| Documentation checks | [`scripts/check-docs.mjs`](../scripts/check-docs.mjs), [`scripts/doc-impact.mjs`](../scripts/doc-impact.mjs) |
| CI gates | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |

If a narrative document needs one of these facts, it should link to the source
instead of restating it. If a human-readable table is genuinely useful, it must
be generated.

## Document status labels

Every document that is not a live source starts with one of:

- `Status: living` — describes the current design; must link to sources for
  volatile facts.
- `Status: target design` — describes intended behaviour that may not be
  implemented. It must say which parts are not implemented.
- `Status: historical` — a snapshot from a named version. It is not updated and
  must not be cited as current. Corrections are append-only notes, not rewrites.

The absence of a label on a long-lived document is a documentation bug.

## What must be generated

`node scripts/check-contracts.mjs` generates and verifies:

- `contracts/REFERENCE.md` — role table, tool table, role-to-operation matrix.
- `contracts/examples/routes.<role>.json` — golden route tables.

`--update` rewrites them; without it the command fails when either is stale.
CI runs the check, so a contract change that forgets the generated files turns
the build red.

`node scripts/doc-impact.mjs --write-agents` generates the document table in
`AGENTS.md` from `docs/doc-map.json`. Do not edit that table by hand.

Do not add a second generator for the same fact. Extend the existing one.

## What not to write by hand

Avoid these in narrative docs unless they are generated:

- counts of tools, operations, roles, or tests;
- endpoint tables and their auth requirements;
- role-to-operation matrices;
- exact TTLs, retry counts, and timeouts that are constants in code;
- hostnames, ports, certificate paths, and deployment users;
- “currently deployed” status.

Use a link plus a stable description instead: “the auth core exposes the route
table; see `policy.mjs` for the shape” rather than a copied JSON example.

## Changing the contract

1. Edit `contracts/tools.json` or `contracts/roles.json`.
2. Run `node scripts/check-contracts.mjs --update`.
3. Review the generated diff, especially `contracts/REFERENCE.md` and the
   golden route tables.
4. Run the auth-core tests and the plugin checks from the root
   [`README.md`](../README.md#verify).
5. Do not hand-edit generated files.

## Document impact

`docs/doc-map.json` is the machine-readable answer to “what does this document
define, and which source changes make it stale?” Each entry has a `defines`
sentence and a list of source globs. The check is deliberately narrow: it
proves that the document was touched, not that the update is good. Review still
has to judge the prose.

```sh
node scripts/doc-impact.mjs --base origin/main --worktree  # before committing
node scripts/doc-impact.mjs --list                          # inspect the map
node scripts/doc-impact.mjs --write-agents                  # after editing the map
```

CI runs the check against the pull request base commit. If a changed source
matches a document's globs and the document itself is not in the diff, the job
fails with the document and the triggering file. A `historical` snapshot or a
living procedure may list no sources; that opts it out of the automatic trigger,
not out of review.

When a document no longer owns a fact, change the map. Do not weaken the
document until the check passes.

## Map

| Document | Status | Purpose |
|---|---|---|
| [`README.md`](../README.md) | living | Entry point, verification commands, repository layout. |
| [`AGENTS.md`](../AGENTS.md) | living | Agent procedure and the generated document-impact map. |
| [`contracts/REFERENCE.md`](../contracts/REFERENCE.md) | generated | Current roles, tools, and role-to-operation matrix. |
| [`docs/OBSERVABILITY.md`](OBSERVABILITY.md) | living | Run ids, audit events, and the trace-storage decision. |
| [`mmw-tools-routing-layer-plan.md`](../mmw-tools-routing-layer-plan.md) | living design | Why the authorization layer is shaped this way; boundaries and gaps. |
| [`mmw-tools-routing-state-machine.md`](../mmw-tools-routing-state-machine.md) | target design | Intended state machines; not a description of shipped behaviour. |
| [`dsh-mmw-tools/docs/NEXT-STEPS.md`](../dsh-mmw-tools/docs/NEXT-STEPS.md) | historical | v0.6.0 snapshot. Do not use for current capabilities. |
| [`mmw-tools-auth/README.md`](../mmw-tools-auth/README.md) | living | Auth-core setup and operator-facing behaviour. |
| [`mmw-tools-auth/deploy/README.md`](../mmw-tools-auth/deploy/README.md) | living | Deployment procedure and host facts. |
| [`docs/DEPLOYMENTS.md`](DEPLOYMENTS.md) | historical | Append-only record of what each deploy changed and verified. |
| [`docs/doc-map.json`](doc-map.json) | manifest | Document-to-source map used by the impact check. |

## When in doubt

Write less. A sentence like “the plugin authorizes each call against the route
table issued by the auth core” stays true across refactors; a copied table does
not. Put the precise fact in the generated reference or in code comments next to
the constant, and link to it.
