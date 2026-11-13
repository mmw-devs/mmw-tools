# Observability: run ids and audit events

Status: living

This document describes what the system records today and why the trace store is
deliberately small. It does not list every event field; the field list lives next
to the code in [`src/util/run-context.ts`](../dsh-mmw-tools/src/util/run-context.ts),
[`src/gate/gate.ts`](../dsh-mmw-tools/src/gate/gate.ts) and
[`src/util/audit.ts`](../dsh-mmw-tools/src/util/audit.ts).

## One id per governed call

A **run id** is created when the gate is about to decide a call to an
`mcp__mmw-tools__*` or `mmw_tools_*` tool. It is carried in three directions:

1. **In process** — an `AsyncLocalStorage` context surrounds the policy check and
   the tool's `next()`, so anything executed inside the call can ask for the
   current id without threading a parameter through every function.
2. **Into the MCP child** — the plugin adds `_meta.mmwRunId` to the `tools/call`
   request; since the multi-repo change it also adds `_meta.mmwRepo` with the
   session's selected `owner/name`. The MCP server validates the shape, resolves
   that repository's config, and appends ` [runId]` to error results and stderr
   lines, which is what makes a failing tool call traceable to the decision that
   allowed it and to the workspace it touched.
3. **Into the local audit log** — the gate emits one `gate_decision` event per
   decision (`allow`, `deny` or `ask`), including the id, the public tool name and
   a short reason. Since the O1.2 change, a denial reason starts with its stable
   code in brackets (`[mmw_route_denied]`, `[mmw_policy_unavailable]`, and so on),
   so the audit log can be grouped by code without parsing prose; see
   [`contracts/ERRORS.md`](../contracts/ERRORS.md). `ask` currently covers
   `pr_merge` and `pr_close`. Arguments and results are never written.
   `select_repo` is decided from local session state before the route table is
   fetched (the table may lag a deployment); it still emits one
   `gate_decision`, and business tools continue to require the table.
   Before binding, `select_repo` also refreshes the auth-core repository
   registry (`GET /v1/agent/repos`), reads the member's grant for that
   repository (`GET /v1/agent/routes?repo=…`) and refuses a repository with no
   grant. It then reads the repository's own `.dsh-mmw-tools.yaml` through the
   broker (`GET /repo-policy?repo=…`); a missing or invalid rule file fails the
   selection closed instead of falling back to the profile copy. The broker
   logs `repo_policy_read` with the repository and file sha, never the file
   body. Business calls fetch the same repository-scoped table, so a denial
   reflects the selected repository's grants, not global roles. The last good
   registry answer, including the rule-file overlay, is written to
   `~/.dsh/mmw-tools-repos.json` (0600). That cache holds repository
   coordinates and path rules, never a credential, and it is not an audit
   sink; a failed refresh is reported in the tool error, not appended as an
   event. The auth core records member-role and repository-grant changes in
   its own audit table (`member-update`), not in this file.

The id is not a security token. It is generated locally, is not signed, and the
MCP server trusts the plugin that spawned it. Its job is correlation, not
authentication.

## Why the audit log is a file, not a collector

The production host has a tight memory budget. A tracing stack (OpenTelemetry
collector, Jaeger, Elasticsearch, or even a Prometheus server with retention)
would cost more memory than the service it observes. The current design keeps the
cost proportional to the number of governed calls:

- one JSON object per decision, appended to a mode-`0600` JSONL file;
- rotation at 1 MiB, keeping the previous file as `.1`, so disk use is bounded
  without a daemon;
- writes are best-effort: a full disk or a permission error disables auditing
  with one warning, never blocks a tool call;
- no background process, no listening port, no schema migration.

That is enough to answer the questions this layer is responsible for: *was this
call allowed, by which run, and why not?* It is not a general tracing system.

## Reading a trace

Every line is self-contained. To follow one call:

```sh
jq -c 'select(.runId == "run_…")' ~/.dsh/dsh-mmw-tools-audit.jsonl
```

For a tool failure, search the MCP server's stderr for the same bracketed id.
Because the id also travels in `_meta`, a proxy or a future broker hop can log it
without parsing tool arguments.

## What is not covered yet

- The `gate_decision` event identifies the tool and decision but does not record
  the session's selected repository; that value travels in `_meta.mmwRepo` and in
  the broker write audit for routed writes. Joining the two requires the run id,
  which the broker does not receive yet (point above).
- The broker (GitHub App token mint, installation tokens, the Feishu
  `/v1/me` + `/v1/agent/routes` checks, and the `/v1/write/*` proxy) does not
  receive the run id, so broker-side events cannot be joined to a gate decision.
  The write proxy appends its own JSONL audit with a broker-generated request id;
  that id is a separate correlation key, not the gate's run id. Adding the run id
  means changing the broker protocol; it is not a logging change.
- The auth core records member and role changes in its own audit table, but not
  per-call route-table reads. Those are policy inputs, not execution events.
- There is no sampling, no span tree, and no latency histogram. The gate records
  decisions, not durations.
- The `pr_merge` operations-contract check runs inside the broker before approval
  and again before merge (the legacy in-MCP path is used only when no broker write
  credential is present). A broker refusal is a tool error carrying the run id
  (`agent-merge-denied`, `contract-changed`), not a second `gate_decision` event;
  the audit log still shows only the decision that allowed the call.
- Workspace relevance is decided by the guard before the policy gate. Its refusal
  is not a `gate_decision` event: the call never reaches the route table. The
  current mode and reason are reported by `mmw_tools_status` (`workspace`), not by
  the audit log.
- Credential lifecycle is not a governed tool call and emits no `gate_decision`
  event: `/installation-token`, the write-auth refresh, and the Feishu token
  refresh are visible to the user through `mmw_tools_status` and the panel, not
  through the audit log.
- The local JSONL file is per plugin host. Two hosts do not share a trace store.

## If central storage becomes necessary

Do it in this order, and only after measuring:

1. **Ship the JSONL.** A small log shipper or a periodic `scp` is enough for a
   single host and adds no resident service.
2. **SQLite on the auth core.** If queries across hosts are needed, add a
   `trace_events` table to the existing SQLite database and post batches from the
   plugin. This reuses the database that already exists, its backup story and its
   single-writer model.
3. **OTLP only with a measured budget.** A collector makes sense when there are
   multiple services and a real query need. On a 2 GB host it is a deliberate
   capacity decision, not a default.

The decision to stay on JSONL is recorded here so that “we forgot to add tracing”
is distinguishable from “we chose not to run a collector”.
