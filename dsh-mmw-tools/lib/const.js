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
 */
import { fileURLToPath } from "node:url";
/*
 *   - package.json  (the top-level `name` field)
 */
export const PLUGIN_ID = "mmw-tools";
export const PLUGIN_DISPLAY_NAME = "dsh-mmw-tools";
/**
 * MCP tool name prefix. Tools exposed by the MCP server become
 * `<PLUGIN_NAMESPACE><rawToolName>` from the agent's perspective.
 * The trailing double-underscore is part of the MCP convention
 * (serverName + "__" + toolName).
 */
export const PLUGIN_NAMESPACE = "mcp__mmw-tools__";
/** Working directory under the DSH profile where repos are cloned. */
export const WORKING_DIR_SUFFIX = "workspaces";
/** Cordis services this plugin depends on. */
/**
 * Services this plugin needs from the host context.
 *
 * Only `tools` is listed, and only because without it there is nothing
 * to do. Everything else is reached defensively at the call site:
 *
 *  - A *required* service that a profile does not provide leaves the
 *    whole entry `pending` forever, with a single boot warning and no
 *    tools, routes or panel. That is exactly what happened: `logger` is
 *    not provided by the shipped web profile, so the plugin never
 *    activated at all.
 *  - Declaring them here at all is not help either: the host's cordis
 *    version reads a `{ required, optional }` object as a list of
 *    service names, so it waited for services literally called
 *    "required" and "optional".
 *
 * So: declare the one thing that is genuinely mandatory, and tolerate
 * the rest missing.
 */
export const CORDIS_INJECT = ["tools"];
/** System-prompt section order (lower renders earlier). */
export const SYSTEM_PROMPT_SECTION_ORDER = 210;
/**
 * Where the MCP server lives relative to the bundle dist.
 *
 * `fileURLToPath`, not `.pathname`: on Windows the latter yields
 * `/C:/Users/...` with a leading slash, and `spawn` cannot resolve it — the
 * MCP child never started and the agent had no repository tools at all,
 * while everything else about the plugin looked healthy.
 */
export function mcpServerEntryPath(importMetaUrl) {
    return fileURLToPath(new URL("../mcp-server/dist/index.js", importMetaUrl));
}
