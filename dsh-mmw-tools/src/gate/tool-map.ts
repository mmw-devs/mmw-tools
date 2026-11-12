/**
 * Operation -> parent tool map, kept in sync with contracts/tools.json.
 *
 * The gate authorizes the parent tool (model A). The operation id is still
 * used for audit and for the future operation-level `roles` override, where
 * `allowedOperations` becomes authoritative.
 */
export type Risk = "read" | "write";

export interface OperationRef {
  toolId: string;
  operationId: string;
  risk: Risk;
  always?: boolean;
}

/**
 * Namespace of every tool this plugin owns.
 *
 * The gate is installed as a global `tools/pre-execute` hook, so it sees
 * every tool call in the session — including the host's own standard tools
 * (`read`, `pwsh`, `glob`, ...). Those are NOT part of the MMW Tools
 * contract and are not the plugin's to police, so the gate must scope
 * itself to this namespace and pass everything else through untouched.
 */
export const TOOL_NAMESPACE = "mcp__mmw-tools__";

/** The plugin's own non-MCP tools (status / run) share this prefix. */
export const TOOL_OWN_PREFIX = "mmw_tools_";

/**
 * True when `publicName` belongs to the MMW Tools contract namespace.
 *
 * Used to tell two apart cases that both miss TOOL_MAP:
 *   - an unknown tool of THIS plugin → denied (the contract is authoritative)
 *   - any host/tooling tool → not ours, passed through
 */
export function isMmwTool(publicName: string): boolean {
  return (
    publicName.startsWith(TOOL_NAMESPACE) || publicName.startsWith(TOOL_OWN_PREFIX)
  );
}

export const TOOL_MAP: Record<string, OperationRef> = {
  "mcp__mmw-tools__select_repo": { toolId: "race-ops", operationId: "race-ops.select_repo", risk: "read" },
  "mcp__mmw-tools__repo_status": { toolId: "race-ops", operationId: "race-ops.repo_status", risk: "read" },
  "mcp__mmw-tools__repo_clone": { toolId: "race-ops", operationId: "race-ops.repo_clone", risk: "read" },
  "mcp__mmw-tools__repo_pull": { toolId: "race-ops", operationId: "race-ops.repo_pull", risk: "read" },
  "mcp__mmw-tools__repo_read": { toolId: "race-ops", operationId: "race-ops.repo_read", risk: "read" },
  "mcp__mmw-tools__repo_search": { toolId: "race-ops", operationId: "race-ops.repo_search", risk: "read" },
  "mcp__mmw-tools__repo_edit": { toolId: "race-ops", operationId: "race-ops.repo_edit", risk: "write" },
  "mcp__mmw-tools__pr_create": { toolId: "race-ops", operationId: "race-ops.pr_create", risk: "write" },
  "mcp__mmw-tools__pr_close": { toolId: "race-ops", operationId: "race-ops.pr_close", risk: "write" },
  "mcp__mmw-tools__pr_list": { toolId: "race-ops", operationId: "race-ops.pr_list", risk: "read" },
  "mcp__mmw-tools__pr_preview": { toolId: "race-ops", operationId: "race-ops.pr_preview", risk: "read" },
  "mcp__mmw-tools__pr_merge": { toolId: "race-ops", operationId: "race-ops.pr_merge", risk: "write" },
  mmw_tools_run: { toolId: "race-ops", operationId: "race-ops.mmw_tools_run", risk: "read" },
  mmw_tools_status: {
    toolId: "mmw-tools-status",
    operationId: "mmw-tools-status.status",
    risk: "read",
    always: true,
  },
};
