/**
 * Per-call correlation for the MMW Tools request path.
 *
 * The gate creates one run id before policy evaluation and runs the rest of
 * the tool call inside this AsyncLocalStorage context. The MCP bridge reads
 * it when forwarding `tools/call`, so the MCP child can attach the same id to
 * its own diagnostics. Without this, gate decisions and MCP errors are
 * separate log lines with no way to join them.
 *
 * Keep this file dependency-free and process-local: it is imported by both
 * the plugin entry and tests, and the MCP child is a separate process.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
const storage = new AsyncLocalStorage();
export function newRunId() {
    return `run_${randomUUID()}`;
}
export function runWithRunId(runId, fn, tool) {
    return storage.run({ runId, tool }, fn);
}
export function currentRunContext() {
    return storage.getStore();
}
export function currentRunId() {
    return storage.getStore()?.runId;
}
