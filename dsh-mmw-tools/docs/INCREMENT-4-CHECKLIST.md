# Increment 4 — mmw_tools_run Wrapper (v0.5.0) — Implementation Checklist

> **Scope correction (vs. INCREMENT-3-CHECKLIST §4).**
>
> The original v2 design specified a 30-step LLM loop with `{ack}`
> termination. After investigating `@deepseek-ai/dsh-llm@0.1.5-rc.1` it
> became clear that **DSH plugins do NOT drive the LLM** — they
> register tools, system-prompt sections, and routing. The LLM loop
> belongs to DSH agent itself, not the plugin.
>
> So v0.5.0's `mmw_tools_run` is a **lightweight bootstrap tool**: it
> prepares a complete project context for the agent, lists available
> tools, and returns. The agent then drives the actual workflow.
> This is the architecture-compatible design.

## What `mmw_tools_run` does

### Input

```ts
interface EngineerRunInput {
  user_request: string;        // user's natural-language ask
  branch_name?: string;        // default: content/<ts>-<slug>
  draft?: boolean;             // default true (per design §6.3)
}
```

### Behavior

1. **Resolve working_dir + repo info** from the host binding.
2. **Read AGENTS.md** (truncated to 4096 bytes) from working_dir via
   the existing `repo_read` MCP server (or directly via `fs.readFile`
   if the bundle wants to skip the MCP layer for read-only access).
3. **Read README.md** (truncated to 2048 bytes).
4. **Check repo state** (cloned? current branch? dirty?).
5. **Compute suggested branch name** from input + timestamp:
   - If `branch_name` is provided, use it (validated).
   - Else `content/<ISO date>-<slug>` where slug is a lowercase +
     dashes version of the first 5 words of `user_request`.
6. **Build system-prompt snippet** that tells the agent:
   - Which repo + branch it operates on
   - What files it may edit (allowlist)
   - What it may NOT edit (denylist)
   - Which tools to use (the 8 MCP tools + the 4 OAuth/status tools)
   - That it must NOT push or merge without explicit user request
   - That commit messages + PR titles are checked for token leaks
7. **Return everything to the agent**. Agent then drives the loop.

### Output

```ts
interface EngineerRunOutput {
  branch_suggestion: string;
  working_dir: string;
  repo: { owner: string; name: string; base_branch: string };
  agents_md_excerpt: string;
  readme_excerpt: string;
  allowlist: string[];
  denylist: string[];
  branch_prefix: string;
  preflight_cmd: string;
  tool_inventory: string[];   // ["mcp__mmw-tools__repo_read", ...]
  instructions: string;        // plain-text guide for the agent
}
```

## What `mmw_tools_run` does NOT do

- ❌ Call the LLM (DSH agent does that).
- ❌ Loop with step counter / `{ack}` termination (DSH agent does that).
- ❌ Auto-push, auto-merge (CI + human review per design §6.3).
- ❌ Persist long-lived system-prompt sections across calls.

## Cross-cutting guards (apply)

1. **Path safety**: every `fs.readFile` on AGENTS.md / README.md goes
   through `assertSafeRepoPath` (from `mcp-server/src/guard.ts`,
   re-exported).
2. **Token redaction**: AGENTS.md / README.md content passes through
   `redactTokens` before returning to the agent. (Defence-in-depth —
   AGENTS.md / README.md shouldn't contain tokens, but if the user
   pasted one in, we don't leak it to the LLM.)
3. **Size limits**: 4 KiB / 2 KiB caps; refusal if exceeded.
4. **Branch name**: `assertBranchPrefix` on the suggested branch.
5. **No session-log persistence**: `mmw_tools_run` itself doesn't
   audit; the agent's downstream calls to `repo_edit` / `pr_create`
   are already audited by their own guards + log through the bundle
   logger. `mmw_tools_run` adds a **run-start marker** to ctx.logger so
   the session log shows "mmw_tools_run started at <ts>".

## Test requirements

- Unit tests (mock `fs`):
  - reads AGENTS.md + README.md
  - truncates at the limit
  - suggests a branch name with proper slug
  - rejects user_request containing token-shaped substrings (we
    refuse to start an mmw_tools_run with a request that itself has
    a token — fail-closed)
  - redaction is applied to excerpts
- Integration test (use the stub ctx from bundle-apply.test.mjs):
  - tool is registered on ctx.tools
  - tool returns the expected shape
  - tool's execute() handles missing AGENTS.md / README.md gracefully
    (returns excerpt empty, instructions note "no AGENTS.md")

## Out of scope for v0.5.0

- Real LLM loop driver.
- Persistent session-prompt section lifecycle.
- Webhook receiver for agent step callbacks.

---

## How I'll work against this checklist

`mmw_tools_run` is implemented in two places:

1. `src/agent/mmw-tools-run.ts` — pure function (input → output), no
   DSH types. Easy to test.
2. `src/index.ts` (host) — wraps the pure function with the cordis
   `defineTool()` + `ctx.tools.register()` glue.

The pure function is the testable surface; the cordis glue is
covered by `bundle-apply.test.mjs` (already exists).