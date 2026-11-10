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
   request. The MCP server validates its shape and appends ` [runId]` to error
   results and stderr lines, which is what makes a failing tool call traceable to
   the decision that allowed it.
3. **Into the local audit log** — the gate emits one `gate_decision` event per
   decision (`allow`, `deny` or `ask`), including the id, the public tool name and
   a short reason. Arguments and results are never written. Since the O1.2
   change, a denial reason starts with its stable code in brackets
   (`[mmw_route_denied]`, `[mmw_policy_unavailable]`, and so on), so the audit log
   can be grouped by code without parsing prose; see
   [`contracts/ERRORS.md`](../contracts/ERRORS.md).

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

- The broker (GitHub App session exchange, installation tokens) does not receive
  the run id, so broker-side events cannot be joined to a gate decision. Adding
  that means changing the broker protocol; it is not a logging change.
- The auth core records member and role changes in its own audit table, but not
  per-call route-table reads. Those are policy inputs, not execution events.
- There is no sampling, no span tree, and no latency histogram. The gate records
  decisions, not durations.
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
