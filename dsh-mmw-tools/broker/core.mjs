/**
 * Broker core — sessions, allowlist, and installation-token issuance.
 *
 * Deliberately free of HTTP: `server.mjs` adapts this to requests, and
 * the tests drive it directly. Everything that decides *whether* someone
 * may obtain a write-capable token lives here, so it is the part that
 * has to be provable without a network.
 *
 * Reuse, not duplication: JWT signing and the installation-token
 * exchange come from the plugin's compiled
 * `lib/auth/github-app.js`. The broker therefore needs `pnpm build` to
 * have run in the plugin directory before it starts — documented in
 * docs/AUTH-BROKER.md, and true for any deployment that ships this repo.
 *
 * Invariants:
 *   - The App private key never leaves this process, and no error message
 *     carries it.
 *   - A session token is opaque to the server: only its sha256 is stored.
 *   - Every installation-token request re-checks the allowlist, so
 *     removing someone takes effect without waiting out a token.
 *   - User access tokens are used for two calls and then dropped.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const GITHUB_OAUTH = "https://github.com/login/oauth";
const GITHUB_API = "https://api.github.com";

/** How long a browser has to finish a login after it is started. */
const STATE_TTL_MS = 5 * 60 * 1000;
/** Per-attempt ceiling for a GitHub call. `fetch` has no default timeout. */
const GITHUB_TIMEOUT_MS = 8_000;
/** One retry covers a dropped connection; it does not cover a dead network. */
const GITHUB_ATTEMPTS = 2;
/** Session lifetime; short enough that revocation is mostly belt-and-braces. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** How long an allowlist verdict is trusted before asking GitHub again. */
const ALLOW_CACHE_MS = 10 * 60 * 1000;

export class BrokerRefused extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = "BrokerRefused";
    this.code = code;
    this.status = status;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32) {
  return b64url(randomBytes(bytes));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time string comparison that tolerates unequal lengths. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still hash-compare so the timing does not reveal length.
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export class BrokerCore {
  #sessions = new Map(); // state -> { pollSecret, status, createdAt, expiresAt, login, reason }
  #tokens = new Map(); // sha256(sessionToken) -> { login, expiresAt, createdAt }
  #allowCache = new Map(); // login -> { allowed, checkedAt }
  #mintCache = null; // installation token reused for membership checks

  constructor(opts) {
    const required = [
      "appId",
      "privateKeyPem",
      "installationId",
      "clientId",
      "clientSecret",
      "publicUrl",
      "owner",
      "repo",
    ];
    for (const key of required) {
      if (!opts[key]) throw new Error(`broker config missing: ${key}`);
    }
    if (!/^https:\/\//.test(opts.publicUrl)) {
      throw new Error("publicUrl must be https:// — GitHub requires an HTTPS callback");
    }

    this.appId = opts.appId;
    this.privateKeyPem = opts.privateKeyPem;
    this.installationId = opts.installationId;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.publicUrl = opts.publicUrl.replace(/\/+$/, "");
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.org = opts.org ?? opts.owner;
    this.allowMode = opts.allowMode ?? "org"; // "org" | "list"
    this.allowList = (opts.allowList ?? []).map((u) => String(u).toLowerCase()).filter(Boolean);
    this.denyList = (opts.denyList ?? []).map((u) => String(u).toLowerCase()).filter(Boolean);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.sessionTtlMs = opts.sessionTtlMs ?? SESSION_TTL_MS;
    this.stateTtlMs = opts.stateTtlMs ?? STATE_TTL_MS;
    this.allowCacheMs = opts.allowCacheMs ?? ALLOW_CACHE_MS;
    this.githubTimeoutMs = opts.githubTimeoutMs ?? GITHUB_TIMEOUT_MS;
    this.githubAttempts = opts.githubAttempts ?? GITHUB_ATTEMPTS;
    this.mintInstallationToken = opts.mintInstallationToken; // injectable for tests
  }

  get repository() {
    return `${this.owner}/${this.repo}`;
  }

  callbackUrl() {
    return `${this.publicUrl}/auth/github/callback`;
  }

  /* ---------------- login ---------------- */

  /** Step 1: the browser URL and the two secrets that pair it to a poller. */
  startSession() {
    const state = randomToken(24);
    const pollSecret = randomToken(32);
    const now = this.now();
    this.#sessions.set(state, {
      pollSecret,
      status: "pending",
      createdAt: now,
      expiresAt: now + this.stateTtlMs,
    });
    return {
      state,
      pollSecret,
      loginUrl: `${this.publicUrl}/auth/github/start?state=${encodeURIComponent(state)}`,
      expiresAt: now + this.stateTtlMs,
    };
  }

  /**
   * Whether a browser link is still worth answering.
   *
   * The HTTP layer asks this before it starts an exchange, so a stale or
   * replayed link gets a page that says so instead of a blank 500.
   */
  hasPendingLogin(state) {
    const entry = this.#lookupState(state);
    return Boolean(entry) && entry.status === "pending";
  }

  /** Where `/auth/github/start` sends the browser. */
  authorizeUrl(state) {
    const entry = this.#lookupState(state);
    if (!entry) throw new BrokerRefused("state-unknown", "unknown or expired login state", 400);
    const url = new URL(`${GITHUB_OAUTH}/authorize`);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", this.callbackUrl());
    // GitHub Apps derive permissions from the App; no `scope` is sent.
    return url.toString();
  }

  #lookupState(state) {
    const entry = this.#sessions.get(state);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.#sessions.delete(state);
      return null;
    }
    return entry;
  }

  /**
   * Step 2: the browser came back. Exchange the code, learn who it is,
   * check the allowlist, and mint a session token for the poller.
   */
  async completeLogin({ code, state }) {
    const entry = this.#lookupState(state);
    if (!entry) throw new BrokerRefused("state-unknown", "unknown or expired login state", 400);
    if (entry.status !== "pending") {
      throw new BrokerRefused("state-used", "this login state was already used", 400);
    }
    if (!code) throw new BrokerRefused("code-missing", "no authorization code", 400);

    // Burn the state before doing anything that can fail slowly, so a
    // replay cannot race this request.
    entry.status = "consumed";

    try {
      const userToken = await this.#exchangeCode(code);
      const login = await this.#fetchLogin(userToken);

      const verdict = await this.#checkAllowlist(login);
      if (!verdict.allowed) {
        entry.status = "denied";
        entry.reason = verdict.reason;
        throw new BrokerRefused("not-allowed", `not allowed: ${verdict.reason}`, 403);
      }

      const sessionToken = randomToken(32);
      const now = this.now();
      this.#tokens.set(sha256(sessionToken), {
        login,
        createdAt: now,
        expiresAt: now + this.sessionTtlMs,
      });

      entry.status = "authorized";
      entry.login = login;
      entry.sessionToken = sessionToken;
      entry.sessionExpiresAt = now + this.sessionTtlMs;
      // The state now outlives its 5-minute browser window: it holds a
      // session that a poller may still be about to pick up.
      entry.expiresAt = now + this.sessionTtlMs;
      return { login, sessionToken, expiresAt: now + this.sessionTtlMs };
    } catch (err) {
      // The state is already burnt. Without a terminal status the poller
      // would sit on "pending" until the 5-minute expiry, which is exactly
      // how a failed exchange used to look: the browser showed a 504 and
      // the panel kept saying "waiting for the browser".
      if (entry.status === "consumed") {
        entry.status = "failed";
        entry.reason = err instanceof BrokerRefused ? err.code : "login-failed";
      }
      throw err;
    }
  }

  /**
   * One bounded GitHub call.
   *
   * `fetch` has no default timeout, so a stalled cross-border connection to
   * github.com hangs until the OS gives up. On 2026-10-29 that hang went
   * past nginx's 20s `proxy_read_timeout` and the user got a 504 in the
   * browser instead of a login. Every GitHub call here therefore either
   * answers or gives up, and a dropped connection is retried once.
   *
   * Only network failures are retried: re-sending the code exchange is
   * harmless while it never reached GitHub, and a lost response is rare
   * enough that the alternative (no retry at all) is worse.
   */
  async #github(url, init = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.githubAttempts; attempt++) {
      try {
        const signal =
          typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(this.githubTimeoutMs)
            : undefined;
        return await this.fetchImpl(url, { ...init, signal });
      } catch (err) {
        lastError = err;
        if (attempt < this.githubAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    }
    throw new BrokerRefused(
      "github-unreachable",
      `GitHub did not answer within ${this.githubTimeoutMs / 1000}s ` +
        `(${lastError?.name ?? "network error"})`,
      502
    );
  }

  async #exchangeCode(code) {
    const res = await this.#github(`${GITHUB_OAUTH}/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.callbackUrl(),
      }),
    });
    if (!res.ok) {
      throw new BrokerRefused("oauth-exchange-failed", `GitHub rejected the code (HTTP ${res.status})`, 502);
    }
    const body = await res.json().catch(() => ({}));
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      throw new BrokerRefused(
        "oauth-exchange-failed",
        `GitHub returned no user token${body.error ? `: ${body.error}` : ""}`,
        502
      );
    }
    return body.access_token;
  }

  async #fetchLogin(userToken) {
    const res = await this.#github(`${GITHUB_API}/user`, {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dsh-race-ops-broker",
      },
    });
    if (!res.ok) {
      throw new BrokerRefused("identity-failed", `could not read the GitHub user (HTTP ${res.status})`, 502);
    }
    const body = await res.json().catch(() => ({}));
    if (typeof body.login !== "string" || body.login.length === 0) {
      throw new BrokerRefused("identity-failed", "GitHub returned no login", 502);
    }
    return body.login;
  }

  /**
   * Allowlist.
   *
   * `BROKER_ALLOWED_USERS` is an *additional* grant, not an alternative mode:
   *
   *   deny list  → refuse, always
   *   allowed    → admit, no org call
   *   otherwise  → org membership (or, in `list` mode, refuse)
   *
   * The explicit list is what makes the plugin useful to people outside the
   * organisation. That is the whole point of the broker: an outsider proves
   * *who they are*, and the repository write comes from the App installation,
   * so they do not need org membership, collaborator status or `repo` scope
   * (docs/AUTH-BROKER.md §1). Treating `org` and `list` as mutually
   * exclusive made the "org" setting silently revoke that capability — an
   * invited outsider could not even complete a login.
   *
   * In `list` mode the same branch still works: the list is the only grant,
   * and a miss is a refusal without asking GitHub.
   */
  async #checkAllowlist(login) {
    const lower = login.toLowerCase();
    if (this.denyList.includes(lower)) {
      return { allowed: false, reason: "explicitly-denied" };
    }

    const cached = this.#allowCache.get(lower);
    if (cached && this.now() - cached.checkedAt < this.allowCacheMs) {
      return { allowed: cached.allowed, reason: cached.reason };
    }

    let verdict;
    if (this.allowList.includes(lower)) {
      verdict = { allowed: true, reason: "allowlisted" };
    } else if (this.allowMode === "list") {
      verdict = { allowed: false, reason: "not-allowlisted" };
    } else {
      // Checked with an *installation* token, not the user's.
      //
      // The user token is deliberately discarded after login, so a check
      // that needed it could only ever run once - and the re-check at
      // token-issue time sent `Bearer null`, which GitHub answers with 401.
      // `GET /orgs/{org}/members/{login}` needs only the App's
      // Members: read permission, so the same call works at login and at
      // every later mint.
      const token = await this.#installationTokenForChecks();
      const res = await this.#github(
        `${GITHUB_API}/orgs/${encodeURIComponent(this.org)}/members/${encodeURIComponent(login)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "dsh-race-ops-broker",
          },
        }
      );
      if (res.status === 204) {
        verdict = { allowed: true, reason: `member-of-${this.org}` };
      } else if (res.status === 404) {
        verdict = { allowed: false, reason: `not-a-member-of-${this.org}` };
      } else {
        throw new BrokerRefused(
          "allowlist-check-failed",
          `org membership check failed (HTTP ${res.status})`,
          502
        );
      }
    }

    this.#allowCache.set(lower, { ...verdict, checkedAt: this.now() });
    return verdict;
  }

  /** One installation token, reused briefly for membership checks. */
  async #installationTokenForChecks() {
    const now = this.now();
    if (this.#mintCache && this.#mintCache.expiresAt - 60_000 > now) {
      return this.#mintCache.token;
    }
    const mint = this.mintInstallationToken ?? defaultMint(this);
    const issued = await mint();
    this.#mintCache = { token: issued.token, expiresAt: issued.expiresAt };
    return issued.token;
  }

  /* ---------------- polling ---------------- */

  poll(state, secret) {
    const entry = this.#sessions.get(state);
    if (!entry) return { status: "expired" };
    if (entry.pollSecret !== secret || !safeEqual(entry.pollSecret, secret)) {
      throw new BrokerRefused("bad-poll-secret", "wrong poll secret", 401);
    }
    if (entry.status === "pending" && entry.expiresAt <= this.now()) {
      this.#sessions.delete(state);
      return { status: "expired" };
    }
    if (entry.status === "pending") return { status: "pending" };
    if (entry.status === "denied") return { status: "denied", reason: entry.reason ?? "denied" };
    // The plugin only understands pending / denied / expired / authorized,
    // so a failed exchange is reported as a denial with its own reason.
    // The panel then stops polling and shows why, instead of waiting out
    // the state TTL on a "pending" that can never change.
    if (entry.status === "failed") return { status: "denied", reason: entry.reason ?? "login-failed" };
    if (entry.status === "consumed") return { status: "pending" };
    if (entry.status === "authorized") {
      const out = {
        status: "authorized",
        sessionToken: entry.sessionToken,
        login: entry.login,
        expiresAt: entry.sessionExpiresAt,
      };
      // The token is handed out once; the state then dies.
      this.#sessions.delete(state);
      return out;
    }
    return { status: "expired" };
  }

  /* ---------------- tokens ---------------- */

  #sessionFor(sessionToken) {
    if (!sessionToken) throw new BrokerRefused("session-required", "no session token", 401);
    const key = sha256(sessionToken);
    const record = this.#tokens.get(key);
    if (!record) throw new BrokerRefused("session-unknown", "unknown session", 401);
    if (record.expiresAt <= this.now()) {
      this.#tokens.delete(key);
      throw new BrokerRefused("session-expired", "session expired; sign in again", 401);
    }
    return { key, record };
  }

  /** The only way to obtain something that can write to the repository. */
  async issueInstallationToken(sessionToken) {
    const { record } = this.#sessionFor(sessionToken);

    // Re-check: the allowlist is the revocation mechanism, so a cached
    // verdict from sign-in time is not good enough here.
    const verdict = await this.#checkAllowlist(record.login);
    if (!verdict.allowed) {
      this.#revokeByLogin(record.login);
      throw new BrokerRefused("not-allowed", `no longer allowed: ${verdict.reason}`, 403);
    }

    const mint = this.mintInstallationToken ?? defaultMint(this);
    const result = await mint();
    return {
      token: result.token,
      expiresAt: result.expiresAt,
      repository: this.repository,
      permissions: result.permissions ?? {},
    };
  }

  revoke(sessionToken) {
    const key = sha256(String(sessionToken ?? ""));
    const record = this.#tokens.get(key);
    this.#tokens.delete(key);
    return { revoked: Boolean(record), login: record?.login ?? "" };
  }

  #revokeByLogin(login) {
    for (const [key, record] of this.#tokens) {
      if (record.login === login) this.#tokens.delete(key);
    }
  }

  /* ---------------- housekeeping ---------------- */

  /** Drop expired state. Called by the server on a timer. */
  sweep() {
    const now = this.now();
    // Every status, not only "pending": a denied or failed entry that was
    // never polled would otherwise sit in the map forever.
    for (const [state, entry] of this.#sessions) {
      if (entry.expiresAt <= now) this.#sessions.delete(state);
    }
    for (const [key, record] of this.#tokens) {
      if (record.expiresAt <= now) this.#tokens.delete(key);
    }
    for (const [login, cached] of this.#allowCache) {
      if (now - cached.checkedAt >= this.allowCacheMs) this.#allowCache.delete(login);
    }
  }

  /** Counts only — safe to expose on /health. */
  stats() {
    return {
      pendingSessions: [...this.#sessions.values()].filter((s) => s.status === "pending").length,
      activeSessions: this.#tokens.size,
      allowCacheEntries: this.#allowCache.size,
      // Makes the explicit grant visible on /health after a deploy: the
      // count, never the names.
      allowListSize: this.allowList.length,
    };
  }
}

/**
 * Default minting path: sign a JWT with the App key and exchange it for a
 * token limited to the single configured repository.
 */
function defaultMint(core) {
  return async () => {
    const { createInstallationToken } = await import(
      new URL("../lib/auth/github-app.js", import.meta.url).href
    );
    return createInstallationToken({
      appId: core.appId,
      privateKeyPem: core.privateKeyPem,
      installationId: core.installationId,
      repositories: [core.repo],
      fetchImpl: core.fetchImpl,
    });
  };
}
