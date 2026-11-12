import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "PolicyError";
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PolicyError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Tool-centric policy.
 *
 * A tool declares which roles may consume it and what technical permissions it
 * needs. Roles are member labels; there is no role -> permission mapping.
 * Operations inherit tool.roles unless they explicitly override it, which keeps
 * the door open for later operation-level roles without changing the gate.
 */
export class Policy {
  constructor(toolsDoc, rolesDoc, source) {
    if (toolsDoc.contractVersion !== 2) throw new PolicyError("tools.json: contractVersion must be 2");
    if (rolesDoc.contractVersion !== 2) throw new PolicyError("roles.json: contractVersion must be 2");
    this.source = source;
    this.toolsDoc = toolsDoc;
    this.rolesDoc = rolesDoc;

    this.roles = new Map();
    for (const role of rolesDoc.roles ?? []) {
      if (typeof role?.id !== "string") throw new PolicyError("roles.json: invalid role");
      this.roles.set(role.id, role);
    }
    if (this.roles.size === 0) throw new PolicyError("roles.json: no roles");

    this.adminRoleId = [...this.roles.values()].find((role) => role.admin === true)?.id;
    if (!this.adminRoleId) throw new PolicyError("roles.json: no admin=true role");

    this.catalogRevision =
      "sha256:" +
      createHash("sha256").update(JSON.stringify(canonicalize(toolsDoc))).digest("hex");

    this.tools = new Map();
    this.operationIndex = new Map();
    for (const tool of toolsDoc.tools ?? []) {
      if (typeof tool?.id !== "string") throw new PolicyError("tools.json: invalid tool");
      if (this.tools.has(tool.id)) throw new PolicyError(`tools.json: duplicate tool ${tool.id}`);
      this.tools.set(tool.id, tool);
      for (const operation of tool.operations ?? []) {
        if (typeof operation?.publicName !== "string") {
          throw new PolicyError(`tools.json: ${tool.id} has an operation without publicName`);
        }
        if (this.operationIndex.has(operation.publicName)) {
          throw new PolicyError(`tools.json: duplicate publicName ${operation.publicName}`);
        }
        this.operationIndex.set(operation.publicName, {
          toolId: tool.id,
          operationId: operation.id,
          risk: operation.risk,
        });
      }
    }

    this.toolCount = this.tools.size;
    this.operationCount = this.operationIndex.size;
  }

  static load(contractsDir) {
    const toolsFile = path.join(contractsDir, "tools.json");
    const rolesFile = path.join(contractsDir, "roles.json");
    return new Policy(readJson(toolsFile), readJson(rolesFile), contractsDir);
  }

  hasRole(member, role) {
    return Array.isArray(member.roles) && member.roles.includes(role);
  }

  memberRoles(member) {
    return new Set((member.roles ?? []).filter((role) => this.roles.has(role)));
  }

  isAdmin(member) {
    return this.hasRole(member, this.adminRoleId);
  }

  rolesForOperation(tool, operation) {
    return operation.roles ?? tool.roles ?? [];
  }

  /** Authorization table returned by GET /v1/agent/routes. */
  routeTable(member, policyRevision, ttlSeconds = 60, options = {}) {
    const memberRoles = options.roles
      ? new Set(options.roles.filter((role) => this.roles.has(role)))
      : this.memberRoles(member);
    const allowed = [];
    const allowedOperations = [];
    const denied = [];

    for (const tool of this.tools.values()) {
      const toolAlways = tool.always === true;
      const operations = [];
      for (const operation of tool.operations ?? []) {
        const roles = this.rolesForOperation(tool, operation);
        const operationAllowed = toolAlways || roles.some((role) => memberRoles.has(role));
        if (operationAllowed) operations.push(`${tool.id}.${operation.id}`);
      }
      if (operations.length > 0) {
        allowed.push(tool.id);
        allowedOperations.push(...operations);
      } else {
        denied.push({
          toolId: tool.id,
          requiredRoles: [...new Set(tool.roles ?? [])],
        });
      }
    }

    allowed.sort();
    allowedOperations.sort();
    denied.sort((a, b) => a.toolId.localeCompare(b.toolId));
    return {
      contractVersion: 2,
      catalogRevision: this.catalogRevision,
      policyRevision,
      ttlSeconds,
      ...(options.repo ? { repo: options.repo } : {}),
      allowed,
      allowedOperations,
      denied,
    };
  }

  /** Human-readable tool tree for the admin UI. */
  toolSummary() {
    return [...this.tools.values()].map((tool) => ({
      id: tool.id,
      title: tool.title,
      roles: [...(tool.roles ?? [])],
      always: tool.always === true,
      operations: (tool.operations ?? []).map((operation) => ({
        id: operation.id,
        publicName: operation.publicName,
        risk: operation.risk,
      })),
    }));
  }

  roleList() {
    return [...this.roles.values()].map((role) => ({
      id: role.id,
      title: role.title,
      description: role.description,
      admin: role.admin === true,
    }));
  }
}
