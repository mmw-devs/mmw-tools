/**
 * Single source of truth for the plugin's identifiers.
 *
 * IMPORTANT — when renaming the plugin, edit ONLY this file. Then run
 *   node scripts/check-namespace-consistency.mjs
 * to verify cordis.patch.yml + bundle entry + MCP server entry all
 * agree. The CI check exists because the cordis patch lives in a YAML
 * file and cannot import a TS constant directly.
 *
 * The strings MUST agree with the corresponding entries in
 *   - cordis.patch.yml  (the `- id:` and `name:` fields)
 *   - mcp-server/src/index.ts  (Server.serverInfo.name)
 *   - package.json  (the top-level `name` field)
 */
export const PLUGIN_ID = "github-engineer";
export const PLUGIN_DISPLAY_NAME = "dsh-github-engineer";

/**
 * MCP tool name prefix. Tools exposed by the MCP server become
 * `<PLUGIN_NAMESPACE><rawToolName>` from the agent's perspective.
 * The trailing double-underscore is part of the MCP convention
 * (serverName + "__" + toolName).
 */
export const PLUGIN_NAMESPACE = "mcp__github-engineer__";

/** Working directory under the DSH profile where repos are cloned. */
export const WORKING_DIR_SUFFIX = "workspaces";

/** Cordis services this plugin depends on. */
export const CORDIS_INJECT = ["tools", "systemPrompt", "logger"];

/** System-prompt section order (lower renders earlier). */
export const SYSTEM_PROMPT_SECTION_ORDER = 210;

/** Where the MCP server lives relative to the bundle dist. */
export function mcpServerEntryPath(importMetaUrl: string): string {
  return new URL("../mcp-server/dist/index.js", importMetaUrl).pathname;
}