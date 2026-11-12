import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * SQLite persistence for members, sessions, plugin tokens, login transactions,
 * config, and the audit trail. One process, one file; no multi-instance sharing.
 */
export class Store {
  constructor(file) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows may not enforce POSIX mode; the data directory is still 0700.
    }
    this.db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA busy_timeout=5000;

      CREATE TABLE IF NOT EXISTS members (
        id           TEXT PRIMARY KEY,
        tenant       TEXT NOT NULL,
        open_id      TEXT NOT NULL,
        name         TEXT NOT NULL,
        roles        TEXT NOT NULL,
        permissions  TEXT NOT NULL,
        enabled      INTEGER NOT NULL,
        version      INTEGER NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS members_tenant_open_id
        ON members(tenant, open_id);

      CREATE TABLE IF NOT EXISTS sessions (
        id_hash      TEXT PRIMARY KEY,
        member_id    TEXT NOT NULL,
        csrf         TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plugin_tokens (
        token_hash   TEXT PRIMARY KEY,
        member_id    TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS login_tx (
        id_hash          TEXT PRIMARY KEY,
        poll_secret_hash TEXT NOT NULL,
        browser_hash     TEXT,
        verifier         TEXT NOT NULL,
        oauth_state      TEXT,
        status           TEXT NOT NULL,
        mode             TEXT NOT NULL,
        bootstrap        INTEGER NOT NULL DEFAULT 0,
        member_id        TEXT,
        token_hash       TEXT,
        reason           TEXT,
        created_at       INTEGER NOT NULL,
        expires_at       INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS login_tx_oauth_state
        ON login_tx(oauth_state) WHERE oauth_state IS NOT NULL;

      CREATE TABLE IF NOT EXISTS audit (
        id       TEXT PRIMARY KEY,
        actor    TEXT NOT NULL,
        action   TEXT NOT NULL,
        target   TEXT NOT NULL,
        details  TEXT NOT NULL,
        at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_at ON audit(at);

      CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repos (
        key             TEXT PRIMARY KEY,
        owner           TEXT NOT NULL,
        name            TEXT NOT NULL,
        base_branch     TEXT NOT NULL,
        branch_prefix   TEXT NOT NULL,
        allowlist_paths TEXT NOT NULL,
        denylist_paths  TEXT NOT NULL,
        enabled         INTEGER NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS grants (
        member_id  TEXT NOT NULL,
        repo_key   TEXT NOT NULL,
        role       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (member_id, repo_key, role)
      );
      CREATE INDEX IF NOT EXISTS grants_member ON grants(member_id);
    `);
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The original error is more useful.
      }
      throw error;
    }
  }

  /* ---------------- members ---------------- */

  getMember(id) {
    const row = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id);
    return row ? memberFromRow(row) : undefined;
  }

  getMemberByOpenId(tenant, openId) {
    const row = this.db
      .prepare("SELECT * FROM members WHERE tenant = ? AND open_id = ?")
      .get(tenant, openId);
    return row ? memberFromRow(row) : undefined;
  }

  allMembers() {
    return this.db.prepare("SELECT * FROM members ORDER BY name COLLATE NOCASE, id").all().map(memberFromRow);
  }

  putMember(member) {
    this.db
      .prepare(
        `INSERT INTO members
          (id, tenant, open_id, name, roles, permissions, enabled, version, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           tenant=excluded.tenant,
           open_id=excluded.open_id,
           name=excluded.name,
           roles=excluded.roles,
           permissions=excluded.permissions,
           enabled=excluded.enabled,
           version=excluded.version,
           updated_at=excluded.updated_at,
           last_login_at=excluded.last_login_at`
      )
      .run(
        member.id,
        member.tenant,
        member.openId,
        member.name,
        JSON.stringify(member.roles ?? []),
        JSON.stringify(member.permissions ?? []),
        member.enabled ? 1 : 0,
        member.version,
        member.createdAt,
        member.updatedAt,
        member.lastLoginAt ?? null
      );
  }

  /* ---------------- sessions ---------------- */

  putSession(session) {
    this.db
      .prepare(
        `INSERT INTO sessions (id_hash, member_id, csrf, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id_hash) DO UPDATE SET
           member_id=excluded.member_id,
           csrf=excluded.csrf,
           expires_at=excluded.expires_at`
      )
      .run(session.idHash, session.memberId, session.csrf, session.createdAt, session.expiresAt);
  }

  getSession(idHash) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id_hash = ?").get(idHash);
    if (!row) return undefined;
    return {
      idHash: row.id_hash,
      memberId: row.member_id,
      csrf: row.csrf,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  deleteSession(idHash) {
    this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
  }

  deleteSessionsForMember(memberId) {
    this.db.prepare("DELETE FROM sessions WHERE member_id = ?").run(memberId);
  }

  /* ---------------- plugin tokens ---------------- */

  putPluginToken(token) {
    this.db
      .prepare(
        `INSERT INTO plugin_tokens (token_hash, member_id, created_at, expires_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(token.tokenHash, token.memberId, token.createdAt, token.expiresAt, token.lastUsedAt);
  }

  getPluginToken(tokenHash) {
    const row = this.db.prepare("SELECT * FROM plugin_tokens WHERE token_hash = ?").get(tokenHash);
    if (!row) return undefined;
    return {
      tokenHash: row.token_hash,
      memberId: row.member_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
    };
  }

  touchPluginToken(tokenHash, at) {
    this.db.prepare("UPDATE plugin_tokens SET last_used_at = ? WHERE token_hash = ?").run(at, tokenHash);
  }

  deletePluginToken(tokenHash) {
    this.db.prepare("DELETE FROM plugin_tokens WHERE token_hash = ?").run(tokenHash);
  }

  deleteTokensForMember(memberId) {
    this.db.prepare("DELETE FROM plugin_tokens WHERE member_id = ?").run(memberId);
  }

  /* ---------------- login transactions ---------------- */

  putLoginTx(tx) {
    this.db
      .prepare(
        `INSERT INTO login_tx
          (id_hash, poll_secret_hash, browser_hash, verifier, oauth_state, status, mode,
           bootstrap, member_id, token_hash, reason, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id_hash) DO UPDATE SET
           browser_hash=excluded.browser_hash,
           oauth_state=excluded.oauth_state,
           status=excluded.status,
           member_id=excluded.member_id,
           token_hash=excluded.token_hash,
           reason=excluded.reason,
           expires_at=excluded.expires_at`
      )
      .run(
        tx.idHash,
        tx.pollSecretHash,
        tx.browserHash ?? null,
        tx.verifier,
        tx.oauthState ?? null,
        tx.status,
        tx.mode,
        tx.bootstrap ? 1 : 0,
        tx.memberId ?? null,
        tx.tokenHash ?? null,
        tx.reason ?? null,
        tx.createdAt,
        tx.expiresAt
      );
  }

  getLoginTx(idHash) {
    const row = this.db.prepare("SELECT * FROM login_tx WHERE id_hash = ?").get(idHash);
    return row ? loginTxFromRow(row) : undefined;
  }

  getLoginTxByState(oauthState) {
    const row = this.db.prepare("SELECT * FROM login_tx WHERE oauth_state = ?").get(oauthState);
    return row ? loginTxFromRow(row) : undefined;
  }

  deleteLoginTx(idHash) {
    this.db.prepare("DELETE FROM login_tx WHERE id_hash = ?").run(idHash);
  }

  /* ---------------- config ---------------- */

  getConfig(key) {
    const row = this.db.prepare("SELECT value FROM config WHERE key = ?").get(key);
    return row ? row.value : undefined;
  }

  setConfig(key, value) {
    this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      )
      .run(key, String(value));
  }

  /* ---------------- repos ---------------- */

  getRepo(key) {
    const row = this.db.prepare("SELECT * FROM repos WHERE key = ?").get(key);
    return row ? repoFromRow(row) : undefined;
  }

  allRepos() {
    return this.db.prepare("SELECT * FROM repos ORDER BY key COLLATE NOCASE").all().map(repoFromRow);
  }

  putRepo(repo) {
    this.db
      .prepare(
        `INSERT INTO repos
          (key, owner, name, base_branch, branch_prefix, allowlist_paths,
           denylist_paths, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           owner=excluded.owner,
           name=excluded.name,
           base_branch=excluded.base_branch,
           branch_prefix=excluded.branch_prefix,
           allowlist_paths=excluded.allowlist_paths,
           denylist_paths=excluded.denylist_paths,
           enabled=excluded.enabled,
           updated_at=excluded.updated_at`
      )
      .run(
        repo.key,
        repo.owner,
        repo.name,
        repo.baseBranch,
        repo.branchPrefix,
        JSON.stringify(repo.allowlistPaths ?? []),
        JSON.stringify(repo.denylistPaths ?? []),
        repo.enabled ? 1 : 0,
        repo.createdAt,
        repo.updatedAt
      );
  }

  deleteConfig(key) {
    this.db.prepare("DELETE FROM config WHERE key = ?").run(key);
  }

  /* ---------------- grants ---------------- */

  grantsForMember(memberId) {
    return this.db
      .prepare("SELECT repo_key, role FROM grants WHERE member_id = ? ORDER BY repo_key, role")
      .all(memberId)
      .map((row) => ({ repoKey: row.repo_key, role: row.role }));
  }

  allGrants() {
    return this.db
      .prepare("SELECT member_id, repo_key, role FROM grants ORDER BY member_id, repo_key, role")
      .all()
      .map((row) => ({ memberId: row.member_id, repoKey: row.repo_key, role: row.role }));
  }

  /** Must be called inside an existing transaction. */
  setGrantsForMember(memberId, repoKey, roles, at = new Date().toISOString()) {
    this.db.prepare("DELETE FROM grants WHERE member_id = ? AND repo_key = ?").run(memberId, repoKey);
    const insert = this.db.prepare(
      "INSERT INTO grants (member_id, repo_key, role, created_at) VALUES (?, ?, ?, ?)"
    );
    for (const role of roles) insert.run(memberId, repoKey, role, at);
  }

  getPolicyRevision() {
    return Number(this.getConfig("policyRevision") ?? "1");
  }

  /** Must be called inside an existing transaction. */
  incrementPolicyRevision() {
    const next = this.getPolicyRevision() + 1;
    this.setConfig("policyRevision", next);
    return next;
  }

  bumpPolicyRevision() {
    return this.transaction(() => this.incrementPolicyRevision());
  }

  /* ---------------- audit ---------------- */

  appendAudit(actor, action, target, details = {}) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO audit (id, actor, action, target, details, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, actor, action, target, JSON.stringify(details), new Date().toISOString());
    return id;
  }

  listAudit(limit = 100) {
    const capped = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db
      .prepare("SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT ?")
      .all(capped)
      .map((row) => ({
        id: row.id,
        actor: row.actor,
        action: row.action,
        target: row.target,
        details: parseJson(row.details, {}),
        at: row.at,
      }));
  }

  close() {
    this.db.close();
  }
}

function memberFromRow(row) {
  return {
    id: row.id,
    tenant: row.tenant,
    openId: row.open_id,
    name: row.name,
    roles: parseJson(row.roles, []),
    permissions: parseJson(row.permissions, []),
    enabled: row.enabled === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? undefined,
  };
}

function repoFromRow(row) {
  return {
    key: row.key,
    owner: row.owner,
    name: row.name,
    baseBranch: row.base_branch,
    branchPrefix: row.branch_prefix,
    allowlistPaths: parseJson(row.allowlist_paths, []),
    denylistPaths: parseJson(row.denylist_paths, []),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loginTxFromRow(row) {  return {
    idHash: row.id_hash,
    pollSecretHash: row.poll_secret_hash,
    browserHash: row.browser_hash ?? undefined,
    verifier: row.verifier,
    oauthState: row.oauth_state ?? undefined,
    status: row.status,
    mode: row.mode,
    bootstrap: row.bootstrap === 1,
    memberId: row.member_id ?? undefined,
    tokenHash: row.token_hash ?? undefined,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
