#!/usr/bin/env node
/**
 * Validate the tool-centric mmw-tools contracts and regenerate the golden
 * route tables under contracts/examples/.
 *
 * Usage:
 *   node scripts/check-contracts.mjs            # check
 *   node scripts/check-contracts.mjs --update   # rewrite golden files
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Policy } from "../mmw-tools-auth/src/policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = path.join(ROOT, "contracts");
const EXAMPLES = path.join(CONTRACTS, "examples");
const REFERENCE = path.join(CONTRACTS, "REFERENCE.md");
const UPDATE = process.argv.includes("--update");

const TOOL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROLE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPERATION_ID_RE = /^[a-z0-9_]+$/;
const PUBLIC_NAME_RE = /^(?:mcp__[a-z0-9-]+__(?:[a-z0-9_]+__)?[A-Za-z0-9_-]+|[A-Za-z0-9_]+)$/;
const PERMISSION_RE = /^[a-z0-9-]+:[a-z0-9_:-]+$/;

const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, "/");
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${rel(file)}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, label, { min = 1, max = Infinity, pattern } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail(`${label}: expected a string of length ${min}..${max}`);
    return false;
  }
  if (pattern && !pattern.test(value)) {
    fail(`${label}: invalid format: ${JSON.stringify(value)}`);
    return false;
  }
  return true;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

const tools = readJson(path.join(CONTRACTS, "tools.json"));
const roles = readJson(path.join(CONTRACTS, "roles.json"));

for (const name of ["tools.schema.json", "roles.schema.json", "routes.schema.json"]) {
  const schema = readJson(path.join(CONTRACTS, name));
  if (schema && typeof schema.$schema !== "string") fail(`${rel(path.join(CONTRACTS, name))}: missing $schema`);
}

if (tools && roles && errors.length === 0) validate(tools, roles);

function validate(toolsDoc, rolesDoc) {
  if (toolsDoc.contractVersion !== 2) fail("tools.json: contractVersion must be 2");
  if (rolesDoc.contractVersion !== 2) fail("roles.json: contractVersion must be 2");

  if (!Array.isArray(rolesDoc.roles) || rolesDoc.roles.length === 0) {
    fail("roles.json: roles must be a non-empty array");
    return;
  }

  const knownRoles = new Set();
  let adminRoles = 0;
  for (const [index, role] of rolesDoc.roles.entries()) {
    const label = `roles.json: roles[${index}]`;
    if (!isObject(role)) {
      fail(`${label}: expected an object`);
      continue;
    }
    if (!requireString(role.id, `${label}.id`, { pattern: ROLE_ID_RE })) continue;
    if (knownRoles.has(role.id)) fail(`${label}.id: duplicate ${role.id}`);
    knownRoles.add(role.id);
    requireString(role.title, `${label}.title`, { max: 100 });
    if (role.description !== undefined) requireString(role.description, `${label}.description`, { max: 500 });
    if (role.admin !== undefined && typeof role.admin !== "boolean") {
      fail(`${label}.admin: expected a boolean`);
    }
    if (role.admin === true) adminRoles += 1;
  }
  if (adminRoles === 0) fail("roles.json: at least one role must set admin=true");

  if (!Array.isArray(toolsDoc.tools) || toolsDoc.tools.length === 0) {
    fail("tools.json: tools must be a non-empty array");
    return;
  }

  const toolIds = new Set();
  const publicNames = new Set();
  let operationCount = 0;

  for (const [toolIndex, tool] of toolsDoc.tools.entries()) {
    const label = `tools.json: tools[${toolIndex}]`;
    if (!isObject(tool)) {
      fail(`${label}: expected an object`);
      continue;
    }
    if (requireString(tool.id, `${label}.id`, { pattern: TOOL_ID_RE })) {
      if (toolIds.has(tool.id)) fail(`${label}.id: duplicate ${tool.id}`);
      toolIds.add(tool.id);
    }
    requireString(tool.title, `${label}.title`, { max: 100 });
    if (tool.description !== undefined) requireString(tool.description, `${label}.description`, { max: 1000 });

    const always = tool.always === true;
    if (tool.always !== undefined && typeof tool.always !== "boolean") {
      fail(`${label}.always: expected a boolean`);
    }

    if (!Array.isArray(tool.roles)) {
      fail(`${label}.roles: expected an array`);
    } else {
      const seen = new Set();
      for (const role of tool.roles) {
        if (typeof role !== "string" || !ROLE_ID_RE.test(role)) {
          fail(`${label}.roles: invalid role ${JSON.stringify(role)}`);
          continue;
        }
        if (!knownRoles.has(role)) fail(`${label}.roles: unknown role ${role}`);
        if (seen.has(role)) fail(`${label}.roles: duplicate role ${role}`);
        seen.add(role);
      }
      if (!always && tool.roles.length === 0) {
        fail(`${label}.roles: must not be empty unless always=true`);
      }
    }

    if (!Array.isArray(tool.requiredPermissions)) {
      fail(`${label}.requiredPermissions: expected an array`);
    } else {
      const seen = new Set();
      for (const permission of tool.requiredPermissions) {
        if (typeof permission !== "string" || !PERMISSION_RE.test(permission)) {
          fail(`${label}.requiredPermissions: invalid permission ${JSON.stringify(permission)}`);
          continue;
        }
        if (seen.has(permission)) fail(`${label}.requiredPermissions: duplicate ${permission}`);
        seen.add(permission);
      }
    }

    if (!Array.isArray(tool.operations) || tool.operations.length === 0) {
      fail(`${label}.operations: expected a non-empty array`);
      continue;
    }
    const operationIds = new Set();
    for (const [operationIndex, operation] of tool.operations.entries()) {
      const opLabel = `${label}.operations[${operationIndex}]`;
      if (!isObject(operation)) {
        fail(`${opLabel}: expected an object`);
        continue;
      }
      operationCount += 1;
      if (requireString(operation.id, `${opLabel}.id`, { pattern: OPERATION_ID_RE })) {
        if (operationIds.has(operation.id)) fail(`${opLabel}.id: duplicate ${operation.id}`);
        operationIds.add(operation.id);
      }
      if (requireString(operation.publicName, `${opLabel}.publicName`, { pattern: PUBLIC_NAME_RE })) {
        if (publicNames.has(operation.publicName)) {
          fail(`${opLabel}.publicName: duplicate ${operation.publicName}`);
        }
        publicNames.add(operation.publicName);
        if (operation.publicName.startsWith("mcp__")) {
          // The model-facing MCP name is the server prefix plus exactly the
          // operation id. This keeps repositories out of names: a new repo
          // must not add a segment such as `mcp__mmw-tools__xivstrat-relay__repo_read`.
          // See docs/TOOL-NAMING.md.
          if (!operation.publicName.endsWith(`__${operation.id}`)) {
            fail(
              `${opLabel}.publicName: expected the MCP name to end with "__${operation.id}" ` +
                `(repo-free naming; see docs/TOOL-NAMING.md)`
            );
          }
        } else if (operation.publicName.includes("__")) {
          fail(
            `${opLabel}.publicName: local tool names must not contain "__" ` +
              `(see docs/TOOL-NAMING.md)`
          );
        }
      }
      requireString(operation.description, `${opLabel}.description`, { max: 500 });
      if (operation.risk !== "read" && operation.risk !== "write") {
        fail(`${opLabel}.risk: expected read or write`);
      }
      if (operation.roles !== undefined) {
        if (!Array.isArray(operation.roles)) {
          fail(`${opLabel}.roles: expected an array when present`);
        } else {
          const seen = new Set();
          for (const role of operation.roles) {
            if (typeof role !== "string" || !ROLE_ID_RE.test(role)) {
              fail(`${opLabel}.roles: invalid role ${JSON.stringify(role)}`);
              continue;
            }
            if (!knownRoles.has(role)) fail(`${opLabel}.roles: unknown role ${role}`);
            if (seen.has(role)) fail(`${opLabel}.roles: duplicate role ${role}`);
            seen.add(role);
          }
        }
      }
    }
  }

  if (errors.length > 0) return;

  const adminRole = rolesDoc.roles.find((role) => role.admin === true)?.id;
  for (const tool of toolsDoc.tools) {
    if (tool.always) continue;
    if (!tool.roles.includes(adminRole)) {
      warnings.push(`tool ${tool.id} does not include the admin role ${adminRole}`);
    }
  }

  const catalogRevision =
    "sha256:" + createHash("sha256").update(JSON.stringify(canonicalize(toolsDoc))).digest("hex");

  const roleIds = rolesDoc.roles.map((role) => role.id);
  if (!existsSync(EXAMPLES)) mkdirSync(EXAMPLES, { recursive: true });
  for (const role of roleIds) {
    const route = buildRoute(role, toolsDoc, catalogRevision);
    const file = path.join(EXAMPLES, `routes.${role}.json`);
    const serialized = JSON.stringify(route, null, 2) + "\n";
    if (UPDATE) {
      writeFileSync(file, serialized, "utf8");
      continue;
    }
    if (!existsSync(file)) {
      fail(`${rel(file)}: missing; run node scripts/check-contracts.mjs --update`);
      continue;
    }
    // Git may check these files out with CRLF on Windows (core.autocrlf),
    // while the generator always writes LF. Compare line-ending-neutral
    // text so a clean checkout does not look stale on the Windows runner.
    const current = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    if (current !== serialized) {
      fail(`${rel(file)}: stale; run node scripts/check-contracts.mjs --update`);
    }
  }

  // Single source of truth for human-readable facts: this file is generated
  // from the same contracts the runtime consumes. Narrative docs link here
  // instead of copying counts, roles, or the operation matrix.
  const reference = buildReference(toolsDoc, rolesDoc, catalogRevision);
  if (UPDATE) {
    writeFileSync(REFERENCE, reference, "utf8");
  } else if (!existsSync(REFERENCE)) {
    fail(`${rel(REFERENCE)}: missing; run node scripts/check-contracts.mjs --update`);
  } else {
    const current = readFileSync(REFERENCE, "utf8").replace(/\r\n/g, "\n");
    if (current !== reference) {
      fail(`${rel(REFERENCE)}: stale; run node scripts/check-contracts.mjs --update`);
    }
  }

  console.log(
    `contracts OK: ${toolsDoc.tools.length} tool(s), ${operationCount} operation(s), ` +
      `${roleIds.length} role(s)`
  );
  console.log(`catalogRevision: ${catalogRevision}`);
  if (UPDATE) {
    console.log(
      `updated ${roleIds.length} golden route table(s) under contracts/examples/ ` +
        `and ${rel(REFERENCE)}`
    );
  }
  for (const warning of warnings) console.warn(`warning: ${warning}`);
}

function mdCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function buildReference(toolsDoc, rolesDoc, catalogRevision) {
  const policy = new Policy(toolsDoc, rolesDoc, CONTRACTS);
  const roleIds = rolesDoc.roles.map((role) => role.id);
  const allowed = new Map(
    roleIds.map((role) => [
      role,
      new Set(policy.routeTable({ roles: [role] }, 0, 60).allowedOperations),
    ])
  );

  const lines = [
    "# Contract reference",
    "",
    "<!-- Generated by scripts/check-contracts.mjs. Do not edit by hand. -->",
    "",
    "This file is the human-readable view of the contract that the auth core and",
    "the plugin both consume. It is generated from `contracts/tools.json` and",
    "`contracts/roles.json`; the JSON files remain the source of truth. If this",
    "file and the JSON disagree, the JSON wins and the file is stale.",
    "",
    "Regenerate with:",
    "",
    "```sh",
    "node scripts/check-contracts.mjs --update",
    "```",
    "",
    "## Snapshot",
    "",
    `- Contract version: ${toolsDoc.contractVersion}`,
    `- Catalog revision: \`${catalogRevision}\``,
    `- Tools: ${toolsDoc.tools.length}`,
    `- Operations: ${toolsDoc.tools.reduce((n, tool) => n + tool.operations.length, 0)}`,
    `- Roles: ${rolesDoc.roles.length}`,
    "",
    "## Roles",
    "",
    "| Role | Title | Admin | Description |",
    "|---|---|---|---|",
  ];

  for (const role of rolesDoc.roles) {
    lines.push(
      `| \`${mdCell(role.id)}\` | ${mdCell(role.title)} | ${
        role.admin === true ? "yes" : ""
      } | ${mdCell(role.description)} |`
    );
  }

  lines.push(
    "",
    "## Tools",
    "",
    "| Tool | Roles | Always available | Required permissions |",
    "|---|---|---|---|"
  );
  for (const tool of toolsDoc.tools) {
    const roles = tool.always === true ? "_(all roles)_" : (tool.roles ?? []).map((r) => `\`${r}\``).join(", ");
    const permissions = (tool.requiredPermissions ?? []).map((p) => `\`${p}\``).join(", ");
    lines.push(
      `| \`${mdCell(tool.id)}\` | ${mdCell(roles)} | ${
        tool.always === true ? "yes" : ""
      } | ${mdCell(permissions)} |`
    );
  }

  lines.push(
    "",
    "## Role to operation matrix",
    "",
    "A checkmark means `GET /v1/agent/routes` returns that operation for a member",
    "with only that role. The matrix is produced by `Policy.routeTable`, the same",
    "function the running auth core uses.",
    "",
    `| Tool | Operation | Public name | Risk | ${roleIds.map((r) => `\`${r}\``).join(" | ")} |`,
    `|---|---|---|---|${roleIds.map(() => "---").join("|")}|`
  );

  for (const tool of toolsDoc.tools) {
    for (const operation of tool.operations) {
      const key = `${tool.id}.${operation.id}`;
      const cells = roleIds.map((role) => (allowed.get(role)?.has(key) ? "✓" : ""));
      lines.push(
        `| \`${mdCell(tool.id)}\` | \`${mdCell(operation.id)}\` | \`${mdCell(
          operation.publicName
        )}\` | ${mdCell(operation.risk)} | ${cells.join(" | ")} |`
      );
    }
  }

  lines.push(
    "",
    "## Notes",
    "",
    "- `always` tools are returned to every authenticated member, regardless of role.",
    "- There is no role-to-permission table. `requiredPermissions` describes what a",
    "  tool needs technically; `roles` describes who may consume it.",
    "- `operation.roles`, when present, overrides the parent tool for that operation.",
    ""
  );

  return lines.join("\n");
}

function buildRoute(role, toolsDoc, catalogRevision) {
  const allowed = [];
  const allowedOperations = [];
  const denied = [];

  for (const tool of toolsDoc.tools) {
    const toolAllowed = tool.always === true || (tool.roles ?? []).includes(role);
    const operations = [];
    for (const operation of tool.operations ?? []) {
      const operationRoles = operation.roles ?? tool.roles ?? [];
      const operationAllowed = tool.always === true || operationRoles.includes(role);
      if (operationAllowed) operations.push(`${tool.id}.${operation.id}`);
    }
    if (operations.length > 0) {
      allowed.push(tool.id);
      allowedOperations.push(...operations);
    } else {
      denied.push({
        toolId: tool.id,
        requiredRoles: [...new Set((tool.roles ?? []).filter((roleId) => roleId !== role))],
      });
    }
  }

  allowed.sort();
  allowedOperations.sort();
  denied.sort((a, b) => a.toolId.localeCompare(b.toolId));

  return {
    contractVersion: 2,
    catalogRevision,
    policyRevision: 42,
    ttlSeconds: 60,
    allowed,
    allowedOperations,
    denied,
  };
}

if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  console.error(`\n${errors.length} contract error(s)`);
  process.exitCode = 1;
}
