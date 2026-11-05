import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { authorizeUrl, exchangeCode, fetchUserInfo, FeishuError } from "./feishu.mjs";

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sha256b64url = (value) => createHash("sha256").update(value).digest("base64url");

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const memberId = (tenant, openId) => sha256(`${tenant}:${openId}`);
const iso = (ms) => new Date(ms).toISOString();

/**
 * Feishu identity, member/role management, plugin tokens, and the route table.
 * HTTP concerns live in server.mjs; this class is directly testable.
 */
export class Auth {
  constructor({ store, config, policy }) {
    this.store = store;
    this.config = config;
    this.policy = policy;
    /** Plaintext plugin tokens keyed by login_tx.id_hash; removed on first poll. */
    this.pendingTokens = new Map();
  }

  now() {
    return this.config.now();
  }

  policyRevision() {
    return this.store.getPolicyRevision();
  }

  /* ---------------- login ---------------- */

  startLogin({ mode = "plugin", bootstrap = false } = {}) {
    const loginId = randomToken(24);
    const pollSecret = randomToken(32);
    const verifier = randomToken(32);
    const createdAt = this.now();
    const expiresAt = createdAt + this.config.oauthTtlSeconds * 1000;
    const tx = {
      idHash: sha256(loginId),
      pollSecretHash: sha256(pollSecret),
      verifier,
      status: "pending",
      mode,
      bootstrap,
      createdAt,
      expiresAt,
    };
    this.store.putLoginTx(tx);
    return {
      loginId,
      pollSecret,
      loginUrl: `${this.config.origin}/auth/feishu/start?login=${encodeURIComponent(loginId)}`,
      expiresAt,
    };
  }

  beginBrowser(loginId) {
    const tx = this.store.getLoginTx(sha256(loginId));
    if (!tx || tx.expiresAt <= this.now() || tx.status !== "pending") {
      throw new AppError(410, "mmw_login_expired", "登录请求已过期，请重新发起");
    }
    const browserSecret = randomToken(32);
    const oauthState = randomToken(24);
    tx.browserHash = sha256(browserSecret);
    tx.oauthState = oauthState;
    this.store.putLoginTx(tx);
    return {
      browserSecret,
      authorizeUrl: authorizeUrl({
        config: this.config,
        state: oauthState,
        codeChallenge: sha256b64url(tx.verifier),
      }),
      expiresAt: tx.expiresAt,
    };
  }

  startBrowserSession({ bootstrap = false } = {}) {
    const started = this.startLogin({ mode: "browser", bootstrap });
    const browser = this.beginBrowser(started.loginId);
    return { ...browser, loginId: started.loginId, expiresAt: started.expiresAt };
  }

  checkBootstrapToken(raw) {
    if (!this.config.bootstrapToken || typeof raw !== "string" || raw.length === 0) return false;
    if (this.store.getConfig("bootstrapped") === "true") return false;
    return safeEqual(raw, this.config.bootstrapToken);
  }

  async completeLogin({ state, browserSecret, code }) {
    if (typeof state !== "string" || state.length === 0) {
      throw new AppError(400, "mmw_login_invalid", "缺少授权状态");
    }
    if (typeof code !== "string" || code.length === 0 || code.length > 2048) {
      throw new AppError(400, "mmw_login_invalid", "授权未完成，请重新发起");
    }

    const tx = this.store.getLoginTxByState(state);
    if (!tx || tx.expiresAt <= this.now() || tx.status !== "pending") {
      throw new AppError(400, "mmw_login_expired", "授权会话无效或已过期，请重新登录");
    }
    if (!tx.browserHash || !safeEqual(tx.browserHash, sha256(browserSecret ?? ""))) {
      throw new AppError(403, "mmw_login_invalid", "授权会话与浏览器不匹配，请重新登录");
    }

    // Burn the transaction before the network call: replay cannot race the
    // exchange. A failed exchange requires a fresh login.
    tx.status = "consumed";
    this.store.putLoginTx(tx);

    let user;
    try {
      const credentials = await exchangeCode({
        config: this.config,
        code,
        codeVerifier: tx.verifier,
      });
      user = await fetchUserInfo({ config: this.config, accessToken: credentials.accessToken });
    } catch (error) {
      tx.status = "denied";
      tx.reason = error instanceof FeishuError ? error.kind : "exchange-failed";
      this.store.putLoginTx(tx);
      this.store.appendAudit("anonymous", "login-failed", tx.idHash, { reason: tx.reason });
      throw error instanceof FeishuError
        ? new AppError(error.status, "mmw_login_denied", error.message)
        : error;
    }

    if (user.tenantKey !== this.config.tenantKey) {
      tx.status = "denied";
      tx.reason = "tenant-mismatch";
      this.store.putLoginTx(tx);
      this.store.appendAudit("anonymous", "login-denied", tx.idHash, { reason: "tenant-mismatch" });
      throw new AppError(403, "mmw_login_denied", "仅允许指定飞书组织的成员登录");
    }

    const now = this.now();
    const at = iso(now);
    const id = memberId(this.config.tenantKey, user.openId);
    let member = this.store.getMember(id);
    if (member && !member.enabled) {
      tx.status = "denied";
      tx.reason = "disabled";
      this.store.putLoginTx(tx);
      this.store.appendAudit(id, "login-denied", tx.idHash, { reason: "disabled" });
      throw new AppError(403, "mmw_login_denied", "账号已停用");
    }
    if (!member) {
      member = {
        id,
        tenant: this.config.tenantKey,
        openId: user.openId,
        name: user.name,
        roles: [],
        permissions: [],
        enabled: true,
        version: 1,
        createdAt: at,
        updatedAt: at,
        lastLoginAt: at,
      };
    } else {
      member = { ...member, name: user.name, lastLoginAt: at, updatedAt: at };
    }

    const bootstrapped = this.store.getConfig("bootstrapped") === "true";
    const shouldBootstrap =
      !bootstrapped &&
      (tx.bootstrap || (this.config.adminOpenId.length > 0 && this.config.adminOpenId === user.openId));
    if (shouldBootstrap && !member.roles.includes("admin")) {
      member.roles = [...member.roles, "admin"];
    }

    const pluginToken = tx.mode === "plugin" ? randomToken(32) : undefined;
    const pluginTokenExpiresAt = pluginToken
      ? now + this.config.pluginTokenTtlSeconds * 1000
      : undefined;
    const sessionToken = tx.mode === "browser" ? randomToken(32) : undefined;
    const csrf = tx.mode === "browser" ? randomToken(24) : undefined;
    const sessionExpiresAt = tx.mode === "browser" ? now + this.config.sessionTtlSeconds * 1000 : undefined;

    this.store.transaction(() => {
      this.store.putMember(member);
      if (shouldBootstrap) {
        this.store.setConfig("bootstrapped", "true");
        this.store.appendAudit(id, "admin-bootstrap", id, { reason: tx.bootstrap ? "bootstrap-token" : "admin-open-id" });
      }
      if (pluginToken) {
        this.store.putPluginToken({
          tokenHash: sha256(pluginToken),
          memberId: id,
          createdAt: now,
          expiresAt: pluginTokenExpiresAt,
          lastUsedAt: now,
        });
        tx.status = "authorized";
        tx.memberId = id;
        tx.tokenHash = sha256(pluginToken);
        this.store.putLoginTx(tx);
        this.store.appendAudit(id, "login-plugin", tx.idHash);
      }
      if (sessionToken) {
        this.store.putSession({
          idHash: sha256(sessionToken),
          memberId: id,
          csrf,
          createdAt: now,
          expiresAt: sessionExpiresAt,
        });
        this.store.appendAudit(id, "login-browser", id);
      }
    });

    if (pluginToken) {
      this.pendingTokens.set(tx.idHash, { token: pluginToken, expiresAt: pluginTokenExpiresAt });
      return { mode: "plugin", member };
    }
    return {
      mode: "browser",
      member,
      session: { token: sessionToken, csrf, expiresAt: sessionExpiresAt },
    };
  }

  pollLogin(loginId, pollSecret) {
    const tx = this.store.getLoginTx(sha256(String(loginId ?? "")));
    if (!tx || tx.expiresAt <= this.now()) {
      if (tx?.tokenHash) this.store.deletePluginToken(tx.tokenHash);
      if (tx) this.store.deleteLoginTx(tx.idHash);
      return { status: "expired" };
    }
    if (!safeEqual(tx.pollSecretHash, sha256(String(pollSecret ?? "")))) {
      throw new AppError(403, "mmw_login_invalid", "轮询凭据无效");
    }
    if (tx.status === "pending") return { status: "pending" };
    if (tx.status === "denied") {
      this.store.deleteLoginTx(tx.idHash);
      return { status: "denied", reason: tx.reason ?? "denied" };
    }
    if (tx.status === "consumed") return { status: "pending" };
    if (tx.status !== "authorized") {
      this.store.deleteLoginTx(tx.idHash);
      return { status: "expired", reason: tx.status };
    }

    const pending = this.pendingTokens.get(tx.idHash);
    if (!pending) {
      if (tx.tokenHash) this.store.deletePluginToken(tx.tokenHash);
      this.store.deleteLoginTx(tx.idHash);
      return { status: "expired", reason: "token-not-available" };
    }
    const member = this.store.getMember(tx.memberId);
    if (!member || !member.enabled) {
      this.pendingTokens.delete(tx.idHash);
      if (tx.tokenHash) this.store.deletePluginToken(tx.tokenHash);
      this.store.deleteLoginTx(tx.idHash);
      return { status: "denied", reason: "disabled" };
    }

    this.pendingTokens.delete(tx.idHash);
    this.store.deleteLoginTx(tx.idHash);
    this.store.appendAudit(member.id, "plugin-token-issued", member.id);
    return {
      status: "authorized",
      pluginToken: pending.token,
      expiresAt: pending.expiresAt,
      member: this.publicMember(member),
      roles: [...member.roles],
      isAdmin: this.policy.isAdmin(member),
      policyRevision: this.policyRevision(),
    };
  }

  /* ---------------- sessions / tokens ---------------- */

  session(raw) {
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    const session = this.store.getSession(sha256(raw));
    if (!session || session.expiresAt <= this.now()) return undefined;
    const member = this.store.getMember(session.memberId);
    if (!member || !member.enabled) return undefined;
    return { session, member };
  }

  verifyPluginToken(raw) {
    if (typeof raw !== "string" || raw.length === 0) {
      throw new AppError(401, "mmw_auth_required", "请先使用飞书登录");
    }
    const token = this.store.getPluginToken(sha256(raw));
    if (!token || token.expiresAt <= this.now()) {
      throw new AppError(401, "mmw_session_expired", "登录已过期，请重新登录");
    }
    const member = this.store.getMember(token.memberId);
    if (!member || !member.enabled) {
      throw new AppError(401, "mmw_session_expired", "账号已停用，请重新登录");
    }
    this.store.touchPluginToken(token.tokenHash, this.now());
    return member;
  }

  refreshPluginToken(raw) {
    const member = this.verifyPluginToken(raw);
    const token = randomToken(32);
    const now = this.now();
    const expiresAt = now + this.config.pluginTokenTtlSeconds * 1000;
    this.store.transaction(() => {
      this.store.deletePluginToken(sha256(raw));
      this.store.putPluginToken({
        tokenHash: sha256(token),
        memberId: member.id,
        createdAt: now,
        expiresAt,
        lastUsedAt: now,
      });
      this.store.appendAudit(member.id, "plugin-token-refresh", member.id);
    });
    return { pluginToken: token, expiresAt };
  }

  logoutPluginToken(raw) {
    if (typeof raw !== "string" || raw.length === 0) return;
    const hash = sha256(raw);
    const token = this.store.getPluginToken(hash);
    if (token) {
      this.store.deletePluginToken(hash);
      this.store.appendAudit(token.memberId, "plugin-token-logout", token.memberId);
    }
  }

  logoutSession(raw) {
    if (typeof raw !== "string" || raw.length === 0) return;
    this.store.deleteSession(sha256(raw));
  }

  /* ---------------- member / admin ---------------- */

  publicMember(member) {
    return {
      id: member.id,
      name: member.name,
      roles: [...member.roles],
      isAdmin: this.policy.isAdmin(member),
      enabled: member.enabled,
      version: member.version,
    };
  }

  memberView(member) {
    return {
      ...this.publicMember(member),
      lastLoginAt: member.lastLoginAt,
    };
  }

  requireAdmin(member) {
    if (!this.policy.isAdmin(member)) {
      throw new AppError(403, "mmw_admin_required", "需要权限管理员权限");
    }
  }

  listMembers(actor) {
    this.requireAdmin(actor);
    return this.store.allMembers().map((member) => this.memberView(member));
  }

  updateMember(actor, id, input) {
    this.requireAdmin(actor);
    if (!input || typeof input !== "object") {
      throw new AppError(400, "mmw_member_invalid", "成员参数无效");
    }
    if (!Number.isInteger(input.version)) {
      throw new AppError(400, "mmw_member_invalid", "缺少成员版本");
    }
    if (!Array.isArray(input.roles) || input.roles.some((role) => typeof role !== "string")) {
      throw new AppError(400, "mmw_member_invalid", "角色参数无效");
    }
    if (typeof input.enabled !== "boolean") {
      throw new AppError(400, "mmw_member_invalid", "启用状态无效");
    }
    const roles = [...new Set(input.roles)];
    for (const role of roles) {
      if (!this.policy.roles.has(role)) {
        throw new AppError(400, "mmw_member_invalid", `未知角色：${role}`);
      }
    }

    const updated = this.store.transaction(() => {
      const member = this.store.getMember(id);
      if (!member) throw new AppError(404, "mmw_member_not_found", "成员不存在");
      if (member.version !== input.version) {
        throw new AppError(409, "mmw_member_stale", "成员状态已更新，请刷新");
      }

      const wasAdmin = member.enabled && this.policy.isAdmin(member);
      const nextCandidate = { ...member, roles, enabled: input.enabled };
      const willBeAdmin = input.enabled && this.policy.isAdmin(nextCandidate);
      if (wasAdmin && !willBeAdmin) {
        const otherAdmins = this.store
          .allMembers()
          .filter((other) => other.id !== id && other.enabled && this.policy.isAdmin(other));
        if (otherAdmins.length === 0) {
          throw new AppError(409, "mmw_last_admin", "不能停用或降级最后一位管理员");
        }
      }

      const at = iso(this.now());
      const next = {
        ...member,
        roles,
        enabled: input.enabled,
        version: member.version + 1,
        updatedAt: at,
      };
      this.store.putMember(next);
      if (!next.enabled) {
        this.store.deleteTokensForMember(next.id);
        this.store.deleteSessionsForMember(next.id);
      }
      const revision = this.store.incrementPolicyRevision();
      this.store.appendAudit(actor.id, "member-update", next.id, {
        before: { roles: member.roles, enabled: member.enabled },
        after: { roles: next.roles, enabled: next.enabled },
        revision,
      });
      return next;
    });

    return this.memberView(updated);
  }

  listAudit(actor, limit = 100) {
    this.requireAdmin(actor);
    return this.store.listAudit(limit);
  }

  me(member) {
    return {
      ...this.memberView(member),
      policyRevision: this.policyRevision(),
      catalogRevision: this.policy.catalogRevision,
    };
  }

  routes(member) {
    return this.policy.routeTable(member, this.policyRevision(), 60);
  }

  recordEvents(member, events) {
    if (!Array.isArray(events)) {
      throw new AppError(400, "mmw_events_invalid", "events 必须是数组");
    }
    const capped = events.slice(0, 50);
    for (const event of capped) {
      if (!event || typeof event !== "object" || typeof event.type !== "string") continue;
      const safe = {
        type: event.type.slice(0, 40),
        toolId: typeof event.toolId === "string" ? event.toolId.slice(0, 120) : undefined,
        reason: typeof event.reason === "string" ? event.reason.slice(0, 120) : undefined,
        policyRevision: Number.isInteger(event.policyRevision) ? event.policyRevision : undefined,
      };
      this.store.appendAudit(member.id, "agent-event", safe.toolId ?? "route", safe);
    }
    return { accepted: capped.length };
  }
}
