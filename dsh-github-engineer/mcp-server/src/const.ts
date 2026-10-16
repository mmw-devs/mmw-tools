/**
 * MCP-server-local copy of the plugin's display name.
 *
 * The MCP server is in its own package (separate node_modules tree,
 * separate tsc invocation), so it cannot import from
 * `../../src/const.ts`. To keep both copies in sync, the consistency
 * check script verifies that the values agree. Edit BOTH when
 * renaming.
 */
export const PLUGIN_DISPLAY_NAME = "dsh-github-engineer";
export const PLUGIN_VERSION = "0.1.0";