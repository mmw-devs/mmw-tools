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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GitReadCache } from "./read-cache.mjs";

const GITHUB_OAUTH = "https://github.com/login/oauth";
const GITHUB_API = "https://api.github.com";
const CONTRACT_PATH = "contract/operations.json";

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

/**
 * Operations the auth core must grant before this broker hands out a
 * repository token without a GitHub login.
 */
const FEISHU_READ_OPERATION = "race-ops.repo_read";
const FEISHU_EDIT_OPERATION = "race-ops.repo_edit";
const FEISHU_PR_OPERATION = "race-ops.pr_create";
const FEISHU_MERGE_OPERATION = "race-ops.pr_merge";
const FEISHU_CLOSE_OPERATION = "race-ops.pr_close";

/** Idempotent write responses are kept for a day: a retry is not a new edit. */
const WRITE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A merge approval is short-lived and single-use. */
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_EDITS_PER_COMMIT = 50;
const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_EDIT_TOTAL_BYTES = 4 * 1024 * 1024;
const REPO_POLICY_PATH = ".dsh-mmw-tools.yaml";
const REPO_POLICY_TTL_MS = 60 * 1000;

/**
 * Parse the small YAML subset a repository policy file uses: scalar fields,
 * block lists of strings, and one-level maps for preflight/bootstrap. Keeping
 * this local avoids adding a YAML dependency to a file that is deployed as a
 * single unit on the broker host.
 */
export function parseRepoPolicy(text) {
  const root = {};
  const stack = [{ indent: -1, target: root }];
  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed === "---" || trimmed.startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = trimmed.replace(/\s+#.*$/, "");
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].target;
    if (line.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new BrokerRefused("repo-policy-invalid", `unexpected list item: ${trimmed}`, 503);
      }
      parent.push(unquote(line.slice(2).trim()));
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      throw new BrokerRefused("repo-policy-invalid", `cannot parse line: ${trimmed}`, 503);
    }
    const key = match[1];
    const value = match[2] ?? "";
    if (value === "") {
      const next = lines[index + 1];
      const nextTrimmed = next ? next.trim() : "";
      if (nextTrimmed.startsWith("- ")) {
        parent[key] = [];
        stack.push({ indent, target: parent[key] });
      } else {
        parent[key] = {};
        stack.push({ indent, target: parent[key] });
      }
    } else {
      parent[key] = unquote(value);
    }
  }
  return root;
}

function unquote(value) {
  const text = String(value).trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  if (text === "[]") return [];
  if (text.startsWith("[") && text.endsWith("]")) {
    return text
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item))
      .filter((item) => item !== "");
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

export function validateRepoPolicy(parsed) {
  const fail = (message) => {
    throw new BrokerRefused("repo-policy-invalid", message, 503);
  };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("policy must be a map");
  if (parsed.version !== 1) fail("version must be 1");
  const stringList = (value, name) => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
      fail(`${name} must be a list of non-empty strings`);
    }
    return value.map((item) => item.trim());
  };
  const allowlistPaths = stringList(parsed.allowlistPaths, "allowlistPaths");
  const denylistPaths = stringList(parsed.denylistPaths, "denylistPaths");
  const branchPrefix = String(parsed.branchPrefix ?? "");
  if (!branchPrefix.endsWith("/")) fail("branchPrefix must end with /");
  const mapField = (value, name, fields) => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be a map`);
    for (const key of Object.keys(value)) {
      if (!fields.includes(key)) fail(`${name}.${key} is not supported`);
    }
    return value;
  };
  const preflight = mapField(parsed.preflight, "preflight", ["cmd", "timeoutSeconds"]);
  const bootstrap = mapField(parsed.bootstrap, "bootstrap", [
    "cmd",
    "whenMissing",
    "timeoutSeconds",
  ]);
  const normalizeCommand = (value, name) => {
    if (!value || typeof value !== "object") return { cmd: "", timeoutSeconds: 300 };
    if (value.cmd !== undefined && typeof value.cmd !== "string") fail(`${name}.cmd must be a string`);
    const timeout = value.timeoutSeconds ?? 300;
    if (!Number.isInteger(timeout) || timeout <= 0) fail(`${name}.timeoutSeconds must be positive`);
    return { cmd: value.cmd ?? "", timeoutSeconds: timeout };
  };
  const prDefaultDraft = parsed.prDefaultDraft ?? true;
  if (typeof prDefaultDraft !== "boolean") fail("prDefaultDraft must be a boolean");
  return {
    allowlistPaths,
    denylistPaths,
    branchPrefix,
    preflight: normalizeCommand(preflight, "preflight"),
    bootstrap: {
      ...normalizeCommand(bootstrap, "bootstrap"),
      whenMissing: typeof bootstrap.whenMissing === "string" ? bootstrap.whenMissing : "",
    },
    prDefaultDraft,
  };
}

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

/**
 * Extract every `command` declared in an op-log JSON block. Kept in the
 * broker (not only the MCP server) so a direct broker call cannot skip it.
 */
export function extractCommands(message) {
  const ids = [];
  if (typeof message !== "string" || message.length === 0) return ids;
  const fence =
    /(?:^|\n)[ \t]*(`{3,}|~{3,})[ \t]*json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*(?=\r?\n|$)/g;
  let match;
  while ((match = fence.exec(message)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(match[2]);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const command = parsed.command;
    if (typeof command === "string" && command.trim() !== "") ids.push(command.trim());
  }
  return ids;
}

export function evaluateMergeContract(contract, commandIds) {
  if (!Array.isArray(commandIds) || commandIds.length === 0) {
    return {
      allowed: false,
      reason: "PR 提交信息里没有 op-log 的 command 字段，无法确认操作级别",
    };
  }
  const levels = contract?.levels ?? {};
  const index = new Map();
  for (const domain of contract?.domains ?? []) {
    for (const command of domain?.commands ?? []) {
      if (typeof command?.id === "string" && typeof command?.level === "string") {
        index.set(command.id, command.level);
      }
    }
  }
  for (const id of commandIds) {
    const level = index.get(id);
    if (!level) {
      return { allowed: false, reason: `command ${JSON.stringify(id)} 不在 contract/operations.json 中` };
    }
    const definition = levels[level];
    if (!definition || typeof definition.agentMerge !== "boolean") {
      return { allowed: false, reason: `契约没有为级别 ${JSON.stringify(level)} 声明 agentMerge` };
    }
    if (definition.agentMerge !== true) {
      return {
        allowed: false,
        reason: `command ${JSON.stringify(id)} 属于 ${level}，agentMerge=false —— 该级别只能由人工在 PR 平台合并`,
      };
    }
  }
  return { allowed: true, reason: "" };
}

export class BrokerCore {
  #sessions = new Map(); // state -> { pollSecret, status, createdAt, expiresAt, login, reason }
  #tokens = new Map(); // sha256(sessionToken) -> { login, expiresAt, createdAt }
  #allowCache = new Map(); // login -> { allowed, checkedAt }
  #mintCache = new Map(); // repo key -> installation token reused for membership checks
  #writeMintCache = new Map(); // repo key -> installation token used by the write proxy only
  #readMintCache = new Map(); // repo key -> read-only installation token for the read proxy
  #idempotency = new Map(); // key -> { value, expiresAt }
  #approvals = new Map(); // approvalId -> { member, pr, headSha, ..., expiresAt }
  #repoPolicies = new Map(); // repo key -> { rules, sha, at }
  #ownership = new Map(); // "<repo>#<branch>" -> login that created the branch

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
    // Optional: when set, a Feishu plugin token can substitute for a GitHub
    // login. The token is verified against the auth core, not trusted.
    this.authUrl = opts.authUrl ? String(opts.authUrl).replace(/\/+$/, "") : "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.sessionTtlMs = opts.sessionTtlMs ?? SESSION_TTL_MS;
    this.stateTtlMs = opts.stateTtlMs ?? STATE_TTL_MS;
    this.allowCacheMs = opts.allowCacheMs ?? ALLOW_CACHE_MS;
    this.githubTimeoutMs = opts.githubTimeoutMs ?? GITHUB_TIMEOUT_MS;
    this.githubAttempts = opts.githubAttempts ?? GITHUB_ATTEMPTS;
    this.mintInstallationToken = opts.mintInstallationToken; // injectable for tests

    // Write proxy. Disabled by default so shipping the code and enabling
    // the capability are separate, auditable operations.
    this.writeEnabled = opts.writeEnabled === true;
    this.allowlistPaths = (opts.allowlistPaths ?? []).map((p) => String(p).trim()).filter(Boolean);
    this.denylistPaths = (opts.denylistPaths ?? []).map((p) => String(p).trim()).filter(Boolean);
    this.baseBranch = String(opts.baseBranch ?? "main");
    this.branchPrefix = String(opts.branchPrefix ?? "content/");

    // Read proxy. Off by default for the same reason as writes: deploying
    // the binary and enabling the capability are separate operations.
    this.readEnabled = opts.readEnabled === true;
    this.readCache =
      opts.readCache ??
      (this.readEnabled ? new GitReadCache({ dir: opts.readCacheDir }) : null);

    // Repository registry. The configured repo stays the default; extra
    // entries let one broker mint tokens for several repositories without
    // changing the App installation. Each entry carries the rules that were
    // previously process-wide (base branch, branch prefix, path allowlist).
    this.defaultRepo = {
      key: `${this.owner}/${this.repo}`,
      owner: this.owner,
      name: this.repo,
      baseBranch: this.baseBranch,
      branchPrefix: this.branchPrefix,
      allowlistPaths: this.allowlistPaths,
      denylistPaths: this.denylistPaths,
    };
    this.repos = new Map([[this.defaultRepo.key.toLowerCase(), this.defaultRepo]]);
    for (const raw of Array.isArray(opts.repos) ? opts.repos : []) {
      const owner = String(raw?.owner ?? "").trim();
      const name = String(raw?.name ?? raw?.repo ?? "").trim();
      if (!owner || !name) throw new Error("broker repos entries need owner and name");
      const key = `${owner}/${name}`;
      this.repos.set(key.toLowerCase(), {
        key,
        owner,
        name,
        baseBranch: String(raw.baseBranch ?? this.baseBranch),
        branchPrefix: String(raw.branchPrefix ?? this.branchPrefix),
        allowlistPaths: Array.isArray(raw.allowlistPaths) ? raw.allowlistPaths : this.allowlistPaths,
        denylistPaths: Array.isArray(raw.denylistPaths) ? raw.denylistPaths : this.denylistPaths,
      });
    }
    this.maxEdits = opts.maxEdits ?? MAX_EDITS_PER_COMMIT;
    this.maxEditBytes = opts.maxEditBytes ?? MAX_EDIT_BYTES;
    this.maxEditTotalBytes = opts.maxEditTotalBytes ?? MAX_EDIT_TOTAL_BYTES;
    this.audit = typeof opts.audit === "function" ? opts.audit : null;

    // Branch ownership is persisted only when a path is configured. Without
    // one it lives in this process, which means a restart falls back to the
    // stricter "operator/admin only" close rule rather than forgetting who
    // owned what.
    this.ownershipFile = String(opts.ownershipFile ?? "").trim();
    if (this.ownershipFile && existsSync(this.ownershipFile)) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(this.ownershipFile, "utf8"));
      } catch {
        throw new Error("broker ownership file is not valid JSON");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("broker ownership file must be a JSON object");
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value !== "") this.#ownership.set(key, value);
      }
    }
  }

  get repository() {
    return `${this.owner}/${this.repo}`;
  }

  /**
   * Resolve a repo key ("owner/name") against the registry. An omitted key
   * means the default repository; an unknown key is refused instead of
   * falling back, so a typo can never touch the wrong repository.
   */
  #repoConfig(key) {
    const wanted = String(key ?? "").trim();
    const resolved = wanted === "" ? this.defaultRepo : this.repos.get(wanted.toLowerCase());
    if (!resolved) {
      throw new BrokerRefused("repo-denied", `repository ${wanted} is not configured`, 403);
    }
    return resolved;
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

    // Checked before the cache on purpose: a person who just failed a login
    // has a cached refusal, and adding them to the list should work on their
    // next attempt, not ten minutes later. This branch makes no GitHub call,
    // so it is free to run every time.
    if (this.allowList.includes(lower)) {
      return { allowed: true, reason: "allowlisted" };
    }

    const cached = this.#allowCache.get(lower);
    if (cached && this.now() - cached.checkedAt < this.allowCacheMs) {
      return { allowed: cached.allowed, reason: cached.reason };
    }

    let verdict;
    if (this.allowMode === "list") {
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

  /**
   * Feishu path: the auth core already knows who this person is and which
   * operations their roles grant. The broker asks it each time a token is
   * minted, so a revoked role takes effect on the next refresh.
   *
   * The plugin token is a bearer credential: it is forwarded only to the
   * configured auth service and never logged or persisted here.
   */
  async #feishuIdentity(pluginToken) {
    if (!this.authUrl) {
      throw new BrokerRefused(
        "feishu-not-configured",
        "this broker has no auth service URL configured",
        503
      );
    }
    const token = String(pluginToken ?? "").trim();
    if (!token) throw new BrokerRefused("feishu-token-required", "no Feishu credential", 401);

    const me = await this.#authGet("/v1/me", token);
    if (!me || typeof me.id !== "string" || me.id.length === 0) {
      throw new BrokerRefused("feishu-bad-response", "the auth service did not identify the member", 502);
    }

    const routes = await this.#authGet("/v1/agent/routes", token);
    const operations = Array.isArray(routes.allowedOperations)
      ? routes.allowedOperations.map(String)
      : [];
    return { id: me.id, login: String(me.name ?? me.id), operations };
  }

  /**
   * The read-token entry point. Both credentials now yield a read-only
   * installation token; writes go through the broker so the write-capable
   * token never reaches the agent's process.
   */
  async #resolveFeishu(pluginToken) {
    const who = await this.#feishuIdentity(pluginToken);
    const canEdit =
      who.operations.includes(FEISHU_EDIT_OPERATION) &&
      who.operations.includes(FEISHU_PR_OPERATION);
    const canRead = who.operations.includes(FEISHU_READ_OPERATION);
    if (!canRead && !canEdit) {
      throw new BrokerRefused(
        "feishu-no-access",
        `${who.login} 的飞书角色没有该仓库的权限`,
        403
      );
    }
    return { login: who.login };
  }

  /** Operation-level authorization for a single write endpoint. */
  async #requireFeishuOperation(pluginToken, operation) {
    const who = await this.#feishuIdentity(pluginToken);
    if (!who.operations.includes(operation)) {
      throw new BrokerRefused(
        "feishu-operation-denied",
        `${who.login} 的飞书角色没有 ${operation} 权限`,
        403
      );
    }
    return who;
  }

  /** One bounded auth-service call. Errors never echo the token. */
  async #authGet(pathname, token) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.githubAttempts; attempt++) {
      try {
        const signal =
          typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(this.githubTimeoutMs)
            : undefined;
        const res = await this.fetchImpl(`${this.authUrl}${pathname}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "User-Agent": "dsh-race-ops-broker",
          },
          signal,
        });
        if (res.status === 401 || res.status === 403) {
          throw new BrokerRefused(
            "feishu-auth-rejected",
            "飞书授权已失效，请重新登录",
            401
          );
        }
        if (!res.ok) {
          throw new BrokerRefused(
            "feishu-check-failed",
            `the auth service answered HTTP ${res.status}`,
            502
          );
        }
        const body = await res.json().catch(() => null);
        if (!body || typeof body !== "object") {
          throw new BrokerRefused(
            "feishu-bad-response",
            "the auth service returned a non-JSON body",
            502
          );
        }
        return body;
      } catch (err) {
        if (err instanceof BrokerRefused) throw err;
        lastError = err;
        if (attempt < this.githubAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    }
    throw new BrokerRefused(
      "feishu-unreachable",
      `the auth service did not answer within ${this.githubTimeoutMs / 1000}s ` +
        `(${lastError?.name ?? "network error"})`,
      502
    );
  }

  /**
   * Mint a token for a Feishu-authenticated member. This is the path that
   * lets someone without a GitHub account open a PR: the PR is authored by
   * the App installation, and the person is identified by Feishu.
   */
  async issueInstallationTokenForFeishu(pluginToken, repoKey) {
    const resolved = await this.#resolveFeishu(pluginToken);
    const rc = this.#repoConfig(repoKey);
    const permissions = { contents: "read", pull_requests: "read" };
    const result = await this.#mintFor(rc, { permissions });
    return {
      token: result.token,
      expiresAt: result.expiresAt,
      repository: rc.key,
      permissions: result.permissions ?? permissions,
      authMode: "feishu",
      login: resolved.login,
      // The client token is always read-only now. Writes are proxied.
      scope: "read",
    };
  }

  /** One installation token, reused briefly for membership checks. */
  async #installationTokenForChecks() {
    const now = this.now();
    const key = this.defaultRepo.key.toLowerCase();
    const cached = this.#mintCache.get(key);
    if (cached && cached.expiresAt - 60_000 > now) {
      return cached.token;
    }
    const issued = await this.#mintFor(this.defaultRepo);
    this.#mintCache.set(key, { token: issued.token, expiresAt: issued.expiresAt });
    return issued.token;
  }

  #mintFor(rc, opts = {}) {
    const mint = this.mintInstallationToken ?? defaultMint(this);
    return mint({ ...opts, repository: rc.key });
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

  /** A read-only token; repository writes go through the broker proxy. */
  async issueInstallationToken(sessionToken, repoKey) {
    const { record } = this.#sessionFor(sessionToken);

    // Re-check: the allowlist is the revocation mechanism, so a cached
    // verdict from sign-in time is not good enough here.
    const verdict = await this.#checkAllowlist(record.login);
    if (!verdict.allowed) {
      this.#revokeByLogin(record.login);
      throw new BrokerRefused("not-allowed", `no longer allowed: ${verdict.reason}`, 403);
    }

    const rc = this.#repoConfig(repoKey);
    const permissions = { contents: "read", pull_requests: "read" };
    const result = await this.#mintFor(rc, { permissions });
    return {
      token: result.token,
      expiresAt: result.expiresAt,
      repository: rc.key,
      permissions: result.permissions ?? permissions,
      authMode: "github",
      login: record.login,
      scope: "read",
    };
  }

  /* ---------------- repository policy file ---------------- */

  /**
   * Read `.dsh-mmw-tools.yaml` from the repository's base branch. Write
   * operations fail closed when it is missing or invalid; the plugin also
   * asks for it through `repoPolicy()` so its local cache matches.
   */
  async #policyFor(rc, { fresh = false } = {}) {
    const key = rc.key.toLowerCase();
    const now = this.now();
    const hit = this.#repoPolicies.get(key);
    if (!fresh && hit && now - hit.at < REPO_POLICY_TTL_MS) return hit;

    const issued = await this.#mintFor(rc, { permissions: { contents: "read" } });
    let res;
    try {
      const signal =
        typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(this.githubTimeoutMs)
          : undefined;
      res = await this.fetchImpl(
        `${GITHUB_API}/repos/${encodeURIComponent(rc.owner)}/${encodeURIComponent(rc.name)}` +
          `/contents/${encodeURIComponent(REPO_POLICY_PATH)}?ref=${encodeURIComponent(rc.baseBranch)}`,
        {
          headers: {
            Authorization: `Bearer ${issued.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "dsh-race-ops-broker",
          },
          signal,
        }
      );
    } catch (err) {
      throw new BrokerRefused(
        "repo-policy-unavailable",
        `cannot read ${REPO_POLICY_PATH} (${err?.name ?? "network error"})`,
        503
      );
    }
    if (res.status === 404) {
      throw new BrokerRefused(
        "repo-policy-missing",
        `${rc.key} has no ${REPO_POLICY_PATH} on ${rc.baseBranch}`,
        503
      );
    }
    const text = await res.text().catch(() => "");
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok || !parsed || typeof parsed.content !== "string") {
      throw new BrokerRefused(
        "repo-policy-unavailable",
        `cannot read ${REPO_POLICY_PATH} (HTTP ${res.status})`,
        503
      );
    }
    const rules = validateRepoPolicy(
      parseRepoPolicy(Buffer.from(parsed.content, "base64").toString("utf8"))
    );
    const entry = { rules, sha: String(parsed.sha ?? ""), at: now };
    this.#repoPolicies.set(key, entry);
    return entry;
  }

  /** Plugin-facing read of the repository policy, after identity check. */
  async repoPolicy(repoKey, { feishuToken } = {}) {
    const token = String(feishuToken ?? "").trim();
    if (!token) throw new BrokerRefused("repo-policy-credential-required", "no Feishu credential", 401);
    await this.#feishuIdentity(token);
    const rc = this.#repoConfig(repoKey);
    const entry = await this.#policyFor(rc, { fresh: true });
    return {
      repository: rc.key,
      path: REPO_POLICY_PATH,
      sha: entry.sha,
      rules: entry.rules,
    };
  }

  /* ---------------- write proxy ---------------- */

  /**
   * The write-capable installation token. It is minted here, kept in this
   * process and never returned to a client. The client token from
   * `/installation-token` is read-only.
   */
  async #writeToken(rc = this.defaultRepo) {
    const now = this.now();
    const key = rc.key.toLowerCase();
    const cached = this.#writeMintCache.get(key);
    if (cached && cached.expiresAt - 60_000 > now) {
      return cached.token;
    }
    const issued = await this.#mintFor(rc, {
      permissions: { contents: "write", pull_requests: "write" },
    });
    this.#writeMintCache.set(key, { token: issued.token, expiresAt: issued.expiresAt });
    return issued.token;
  }

  /**
   * The read-only installation token used by the read proxy. It never
   * leaves the broker either: clients receive bundles and JSON, not tokens.
   */
  async #readToken(rc = this.defaultRepo) {
    const key = rc.key.toLowerCase();
    const cached = this.#readMintCache.get(key);
    if (cached && cached.expiresAt - 60_000 > this.now()) return cached.token;
    const issued = await this.#mintFor(rc, {
      permissions: { contents: "read", pull_requests: "read" },
    });
    this.#readMintCache.set(key, { token: issued.token, expiresAt: issued.expiresAt });
    return issued.token;
  }

  /** One GitHub API call with the broker's read token, scoped to one repo. */
  async #readApi(pathname, { repo, allow404 = true } = {}) {
    const rc = this.#repoConfig(repo);
    const token = await this.#readToken(rc);
    let res;
    try {
      const signal =
        typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(this.githubTimeoutMs)
          : undefined;
      res = await this.fetchImpl(
        `${GITHUB_API}/repos/${encodeURIComponent(rc.owner)}/${encodeURIComponent(rc.name)}${pathname}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "dsh-race-ops-broker",
          },
          signal,
        }
      );
    } catch (err) {
      throw new BrokerRefused(
        "github-unreachable",
        `GitHub did not answer within ${this.githubTimeoutMs / 1000}s (${err?.name ?? "network error"})`,
        502
      );
    }
    if (res.status === 404 && allow404) return null;
    const text = await res.text().catch(() => "");
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const message =
        parsed && typeof parsed.message === "string"
          ? parsed.message
          : `GitHub answered HTTP ${res.status}`;
      throw new BrokerRefused("github-read-failed", message, res.status === 403 ? 403 : 502);
    }
    return parsed;
  }

  /** One GitHub API call with the broker's write token, scoped to one repo. */
  async #api(method, pathname, { body, allow404 = false, repo } = {}) {
    const rc = this.#repoConfig(repo);
    const token = await this.#writeToken(rc);
    let res;
    try {
      const signal =
        typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(this.githubTimeoutMs)
          : undefined;
      res = await this.fetchImpl(
        `${GITHUB_API}/repos/${encodeURIComponent(rc.owner)}/${encodeURIComponent(rc.name)}${pathname}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "dsh-race-ops-broker",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal,
        }
      );
    } catch (err) {
      throw new BrokerRefused(
        "github-unreachable",
        `GitHub did not answer within ${this.githubTimeoutMs / 1000}s (${err?.name ?? "network error"})`,
        502
      );
    }

    if (res.status === 404 && allow404) return null;
    const text = await res.text().catch(() => "");
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const message =
        parsed && typeof parsed.message === "string"
          ? parsed.message
          : `GitHub answered HTTP ${res.status}`;
      const status = res.status === 422 || res.status === 409 ? 409 : res.status === 403 ? 403 : 502;
      throw new BrokerRefused("github-write-failed", message, status);
    }
    return parsed;
  }

  /** Which credential is writing, and is it allowed to perform this operation? */
  async #authorizeWrite(operation, { feishuToken, sessionToken }) {
    if (!this.writeEnabled) {
      throw new BrokerRefused("write-disabled", "the write proxy is not enabled on this broker", 503);
    }
    const feishu = String(feishuToken ?? "").trim();
    if (feishu) {
      const who = await this.#requireFeishuOperation(feishu, operation);
      return { login: who.login, kind: "feishu", operations: who.operations };
    }
    const session = String(sessionToken ?? "").trim();
    if (session) {
      const { record } = this.#sessionFor(session);
      const verdict = await this.#checkAllowlist(record.login);
      if (!verdict.allowed) {
        this.#revokeByLogin(record.login);
        throw new BrokerRefused("not-allowed", `no longer allowed: ${verdict.reason}`, 403);
      }
      return { login: record.login, kind: "github" };
    }
    throw new BrokerRefused(
      "write-credential-required",
      "no Feishu or GitHub credential",
      401
    );
  }

  /** Read credentials use the same identities but a separate capability flag. */
  async #authorizeRead(operation, { feishuToken, sessionToken } = {}) {
    if (!this.readEnabled) {
      throw new BrokerRefused("read-disabled", "the read proxy is not enabled on this broker", 503);
    }
    const feishu = String(feishuToken ?? "").trim();
    if (feishu) {
      const who = await this.#requireFeishuOperation(feishu, operation);
      return { login: who.login, kind: "feishu", operations: who.operations };
    }
    const session = String(sessionToken ?? "").trim();
    if (session) {
      const { record } = this.#sessionFor(session);
      const verdict = await this.#checkAllowlist(record.login);
      if (!verdict.allowed) {
        this.#revokeByLogin(record.login);
        throw new BrokerRefused("not-allowed", `no longer allowed: ${verdict.reason}`, 403);
      }
      return { login: record.login, kind: "github" };
    }
    throw new BrokerRefused(
      "read-credential-required",
      "no Feishu or GitHub credential",
      401
    );
  }

  #readRef(value, fallback) {
    const ref = String(value ?? fallback ?? "").trim();
    if (!ref || ref.length > 256 || /[\s~^:?*[\\]|\.\./.test(ref)) {
      throw new BrokerRefused("ref-invalid", "ref is not a valid branch name", 400);
    }
    return ref;
  }

  #assertBranch(branch, rc = this.defaultRepo, rules = rc) {
    if (typeof branch !== "string" || !branch.startsWith(rules.branchPrefix)) {
      throw new BrokerRefused(
        "branch-prefix",
        `branch must start with ${rules.branchPrefix}`,
        400
      );
    }
    if (branch === rc.baseBranch || branch.includes("..") || branch.length > 200) {
      throw new BrokerRefused("branch-invalid", "branch name is not allowed", 400);
    }
  }

  #normalizePath(raw, rc = this.defaultRepo, rules = rc) {
    const normalized = normalizeRepoPath(raw);
    if (!rules.allowlistPaths.some((glob) => globToRegExp(glob).test(normalized))) {
      throw new BrokerRefused("path-not-allowed", `${normalized} is not in the write allowlist`, 403);
    }
    if (rules.denylistPaths.some((glob) => globToRegExp(glob).test(normalized))) {
      throw new BrokerRefused("path-denied", `${normalized} is on the write denylist`, 403);
    }
    return normalized;
  }

  #idempotencyKey(kind, provided, payload) {
    if (typeof provided === "string" && provided.trim() !== "") {
      return `${kind}:provided:${provided.trim()}`;
    }
    return `${kind}:sha:${sha256(JSON.stringify(payload))}`;
  }

  #recall(key) {
    const hit = this.#idempotency.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.#idempotency.delete(key);
      return null;
    }
    return hit.value;
  }

  #remember(key, value) {
    this.#idempotency.set(key, {
      value,
      expiresAt: this.now() + WRITE_IDEMPOTENCY_TTL_MS,
    });
  }

  #audit(event) {
    if (!this.audit) return;
    try {
      this.audit({ at: new Date(this.now()).toISOString(), ...event });
    } catch {
      /* auditing must never fail the write */
    }
  }

  #requestId(requestId) {
    return typeof requestId === "string" && requestId.trim() !== ""
      ? requestId.trim().slice(0, 80)
      : randomToken(8);
  }

  async #readContent(pathname, ref, repo) {
    const data = await this.#api(
      "GET",
      `/contents/${encodePath(pathname)}?ref=${encodeURIComponent(ref)}`,
      { allow404: true, repo }
    );
    if (!data) return null;
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
      throw new BrokerRefused("path-not-file", `${pathname} is not a file in this commit`, 409);
    }
    const encoding = data.encoding === "base64" ? "base64" : "utf8";
    return Buffer.from(data.content, encoding).toString("utf8");
  }

  #ownershipKey(rc, branch) {
    return `${rc.key.toLowerCase()}#${branch}`;
  }

  #ownerOf(rc, branch) {
    return this.#ownership.get(this.#ownershipKey(rc, branch)) ?? null;
  }

  #recordOwner(rc, branch, who) {
    if (!who || typeof who.login !== "string" || who.login === "") return;
    this.#ownership.set(this.#ownershipKey(rc, branch), who.login);
    if (!this.ownershipFile) return;
    try {
      mkdirSync(path.dirname(this.ownershipFile), { recursive: true });
      writeFileSync(this.ownershipFile, JSON.stringify(Object.fromEntries(this.#ownership), null, 2), {
        mode: 0o600,
      });
    } catch {
      // Losing the ledger only makes close stricter after a restart.
    }
  }

  #isPrivileged(who) {
    return (
      who.kind === "github" ||
      (Array.isArray(who.operations) && who.operations.includes(FEISHU_MERGE_OPERATION))
    );
  }

  /**
   * The contract gate must run on the broker, not only in the MCP child:
   * a direct `/v1/write/pr_merge` call would otherwise skip it. The contract
   * is read from the PR's base commit, so a PR cannot widen its own gate by
   * editing `contract/operations.json` in the same change.
   */
  async #assertMergeContract(prNumber, pr, rc) {
    const base = await this.#readContent(CONTRACT_PATH, pr.base.sha, rc.key);
    if (base === null) return; // repository does not use the contract
    const head = await this.#readContent(CONTRACT_PATH, pr.head.sha, rc.key);
    if (head === null || head !== base) {
      throw new BrokerRefused(
        "contract-changed",
        "PR 修改了 contract/operations.json；合并规则不能在同一个 PR 里被改写",
        409
      );
    }
    let contract;
    try {
      contract = JSON.parse(base);
    } catch {
      throw new BrokerRefused("contract-unreadable", "contract/operations.json is not valid JSON", 409);
    }
    const commits = await this.#api("GET", `/pulls/${prNumber}/commits?per_page=100`, {
      repo: rc.key,
    });
    const messages = Array.isArray(commits)
      ? commits.map((commit) => String(commit?.commit?.message ?? ""))
      : [];
    const commandIds = messages.flatMap((message) => extractCommands(message));
    const verdict = evaluateMergeContract(contract, commandIds);
    if (!verdict.allowed) {
      throw new BrokerRefused("agent-merge-denied", verdict.reason, 403);
    }
  }

  #applyEdit(original, edit) {
    if (edit.mode === "replace") {
      if (original === null) {
        throw new BrokerRefused("replace-no-file", `replace mode requires an existing file at ${edit.path}`, 409);
      }
      const find = String(edit.find ?? "");
      if (find === "") throw new BrokerRefused("edit-find-required", "replace mode requires find", 400);
      const occurrences = original.split(find).length - 1;
      if (occurrences !== 1) {
        throw new BrokerRefused(
          "find-not-found",
          occurrences === 0
            ? `find string not found in ${edit.path}`
            : `find string matches ${occurrences} occurrences in ${edit.path}`,
          409
        );
      }
      return original.replace(find, String(edit.replace ?? ""));
    }
    if (edit.mode === "insert") {
      const content = String(edit.content ?? "");
      if (content === "") throw new BrokerRefused("edit-content-required", "insert mode requires content", 400);
      return (original ?? "") + content;
    }
    throw new BrokerRefused(
      "edit-mode-invalid",
      "only replace and insert are supported by the write proxy",
      400
    );
  }

  #validateEditMessages(message) {
    if (typeof message !== "string" || message.trim() === "") {
      throw new BrokerRefused("commit-message-empty", "commit message is required", 400);
    }
    if (Buffer.byteLength(message) > 10_000) {
      throw new BrokerRefused("commit-message-too-long", "commit message is too long", 400);
    }
  }

  /**
   * Apply edits through the GitHub Git Data API. The commit is authored by
   * the App installation; `base_sha` pins it to the branch head the caller
   * read, which is what makes a stale edit a conflict instead of a silent
   * overwrite.
   */
  async writeRepoEdit(args = {}) {
    const who = await this.#authorizeWrite(FEISHU_EDIT_OPERATION, args);
    const rc = this.#repoConfig(args.repo);
    const rules = (await this.#policyFor(rc)).rules;
    const branch = String(args.branch ?? "");
    const baseSha = String(args.baseSha ?? args.base_sha ?? "");
    const message = String(args.message ?? args.commit_message ?? "");
    const edits = Array.isArray(args.edits) ? args.edits : [];

    this.#assertBranch(branch, rc, rules);
    if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
      throw new BrokerRefused("base-sha-invalid", "base_sha must be a 40-character commit SHA", 400);
    }
    this.#validateEditMessages(message);
    if (edits.length === 0 || edits.length > this.maxEdits) {
      throw new BrokerRefused("edits-invalid", `edits must contain 1..${this.maxEdits} entries`, 400);
    }

    const normalized = [];
    const seen = new Set();
    let totalBytes = 0;
    for (const raw of edits) {
      if (!raw || typeof raw !== "object") {
        throw new BrokerRefused("edit-invalid", "every edit must be an object", 400);
      }
      const pathname = this.#normalizePath(raw.path, rc, rules);
      if (seen.has(pathname)) {
        throw new BrokerRefused("edit-duplicate-path", `${pathname} appears twice`, 400);
      }
      seen.add(pathname);
      const mode = String(raw.mode ?? "");
      if (mode !== "replace" && mode !== "insert") {
        throw new BrokerRefused("edit-mode-invalid", "only replace and insert are supported", 400);
      }
      const payload = { path: pathname, mode, find: raw.find, replace: raw.replace, content: raw.content };
      const bytes =
        Buffer.byteLength(String(payload.find ?? "")) +
        Buffer.byteLength(String(payload.replace ?? "")) +
        Buffer.byteLength(String(payload.content ?? ""));
      totalBytes += bytes;
      normalized.push(payload);
    }
    if (totalBytes > this.maxEditTotalBytes) {
      throw new BrokerRefused("edits-too-large", "the combined edit payload is too large", 413);
    }

    const requestId = this.#requestId(args.requestId);
    const idemKey = this.#idempotencyKey("repo_edit", args.idempotencyKey, {
      repo: rc.key,
      branch,
      baseSha,
      message,
      edits: normalized,
    });
    const cached = this.#recall(idemKey);
    if (cached) return { ...cached, idempotent: true };

    const refPath = `/git/ref/heads/${encodeBranch(branch)}`;
    const existing = await this.#api("GET", refPath, { allow404: true, repo: rc.key });
    let base;
    if (existing) {
      base = existing?.object?.sha;
    } else {
      const baseRef = await this.#api("GET", `/git/ref/heads/${encodeBranch(rc.baseBranch)}`, {
        repo: rc.key,
      });
      base = baseRef?.object?.sha;
    }
    if (typeof base !== "string" || !/^[0-9a-f]{40}$/i.test(base)) {
      throw new BrokerRefused("base-branch-missing", "could not resolve the base commit", 502);
    }
    if (base !== baseSha) {
      throw new BrokerRefused(
        "base-sha-mismatch",
        `the branch head is ${base}, not ${baseSha}; pull the branch and retry`,
        409
      );
    }

    const baseCommit = await this.#api("GET", `/git/commits/${base}`, { repo: rc.key });
    const baseTree = baseCommit?.tree?.sha;
    if (typeof baseTree !== "string") {
      throw new BrokerRefused("base-commit-invalid", "could not read the base tree", 502);
    }

    const tree = [];
    const filesChanged = [];
    for (const edit of normalized) {
      const original = await this.#readContent(edit.path, base, rc.key);
      const next = this.#applyEdit(original, edit);
      const bytes = Buffer.byteLength(next);
      if (bytes > this.maxEditBytes) {
        throw new BrokerRefused("edit-too-large", `${edit.path} would exceed the file size limit`, 413);
      }
      const blob = await this.#api("POST", "/git/blobs", {
        body: { content: next, encoding: "utf-8" },
        repo: rc.key,
      });
      tree.push({ path: edit.path, mode: "100644", type: "blob", sha: blob.sha });
      filesChanged.push(edit.path);
    }

    const newTree = await this.#api("POST", "/git/trees", {
      body: { base_tree: baseTree, tree },
      repo: rc.key,
    });
    const newCommit = await this.#api("POST", "/git/commits", {
      body: { message, tree: newTree.sha, parents: [base] },
      repo: rc.key,
    });

    if (existing) {
      await this.#api("PATCH", `/git/refs/heads/${encodeBranch(branch)}`, {
        body: { sha: newCommit.sha, force: false },
        repo: rc.key,
      });
    } else {
      await this.#api("POST", "/git/refs", {
        body: { ref: `refs/heads/${branch}`, sha: newCommit.sha },
        repo: rc.key,
      });
    }

    const result = {
      branch,
      base_sha: base,
      new_commit_sha: newCommit.sha,
      files_changed: filesChanged,
      idempotent: false,
    };
    this.#remember(idemKey, result);
    this.#recordOwner(rc, branch, who);
    this.#audit({
      requestId,
      op: "repo_edit",
      member: who.login,
      kind: who.kind,
      repo: rc.key,
      branch,
      baseSha: base,
      commitSha: newCommit.sha,
      files: filesChanged,
    });
    return result;
  }

  async writePrCreate(args = {}) {
    const who = await this.#authorizeWrite(FEISHU_PR_OPERATION, args);
    const rc = this.#repoConfig(args.repo);
    const rules = (await this.#policyFor(rc)).rules;
    const head = String(args.head ?? args.head_branch ?? "");
    const base = String(args.base ?? rc.baseBranch);
    const title = String(args.title ?? "");
    const body = String(args.body ?? "");
    const draft = args.draft === undefined ? rules.prDefaultDraft !== false : args.draft !== false;

    this.#assertBranch(head, rc, rules);
    if (base !== rc.baseBranch) {
      throw new BrokerRefused("base-not-allowed", `PRs may only target ${rc.baseBranch}`, 400);
    }
    if (title.trim() === "" || Buffer.byteLength(title) > 256) {
      throw new BrokerRefused("title-invalid", "title must be 1..256 characters", 400);
    }
    if (Buffer.byteLength(body) > 65_536) {
      throw new BrokerRefused("body-too-large", "PR body is too large", 413);
    }

    const requestId = this.#requestId(args.requestId);
    const idemKey = this.#idempotencyKey("pr_create", args.idempotencyKey, {
      repo: rc.key,
      head,
      base,
      title,
      body,
      draft,
    });
    const cached = this.#recall(idemKey);
    if (cached) return { ...cached, idempotent: true };

    const ref = await this.#api("GET", `/git/ref/heads/${encodeBranch(head)}`, {
      allow404: true,
      repo: rc.key,
    });
    if (!ref) {
      throw new BrokerRefused("branch-not-found", `branch ${head} does not exist on the remote`, 409);
    }
    const headSha = ref.object?.sha;

    const query =
      `?state=open` +
      `&head=${encodeURIComponent(`${rc.owner}:${head}`)}` +
      `&base=${encodeURIComponent(base)}`;
    const open = await this.#api("GET", `/pulls${query}`, { repo: rc.key });
    const existing = Array.isArray(open)
      ? open.find((pr) => pr?.head?.ref === head && pr?.base?.ref === base)
      : null;

    let pr = existing;
    let created = false;
    if (!pr) {
      pr = await this.#api("POST", "/pulls", {
        body: { title, body, head, base, draft },
        repo: rc.key,
      });
      created = true;
    }

    const result = {
      number: pr.number,
      url: pr.html_url,
      head_sha: pr.head?.sha ?? headSha,
      draft: Boolean(pr.draft),
      created,
      idempotent: false,
    };
    this.#remember(idemKey, result);
    if (created) this.#recordOwner(rc, head, who);
    this.#audit({
      requestId,
      op: "pr_create",
      member: who.login,
      kind: who.kind,
      repo: rc.key,
      pr: pr.number,
      head,
      base,
      headSha: result.head_sha,
      created,
    });
    return result;
  }

  /**
   * Close an open content/* PR without merging it.
   *
   * Closing is what makes the lifecycle finite: a PR that is abandoned (CI
   * red, superseded, or the change no longer wanted) should leave the open
   * queue. Re-closing an already closed/merged PR is a no-op, so a retry
   * after a lost response is safe.
   */
  async writePrClose(args = {}) {
    const who = await this.#authorizeWrite(FEISHU_CLOSE_OPERATION, args);
    const rc = this.#repoConfig(args.repo);
    const prNumber = Number(args.prNumber ?? args.pr_number);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new BrokerRefused("pr-number-invalid", "pr_number must be a positive integer", 400);
    }

    const requestId = this.#requestId(args.requestId);
    const idemKey = this.#idempotencyKey("pr_close", args.idempotencyKey, {
      repo: rc.key,
      prNumber,
    });
    const cached = this.#recall(idemKey);
    if (cached) return { ...cached, idempotent: true };

    const pr = await this.#api("GET", `/pulls/${prNumber}`, { allow404: true, repo: rc.key });
    if (!pr) {
      throw new BrokerRefused("pr-not-found", `PR #${prNumber} does not exist`, 404);
    }

    // Already closed (including merged): nothing to do, and a retry should
    // not turn into an error just because the first call succeeded.
    if (pr.state !== "open") {
      const result = {
        number: pr.number,
        closed: true,
        already: true,
        merged: Boolean(pr.merged_at),
        head_sha: pr.head?.sha ?? "",
        url: pr.html_url ?? "",
        idempotent: false,
      };
      this.#remember(idemKey, result);
      return result;
    }

    if (!String(pr.head?.ref ?? "").startsWith(rc.branchPrefix)) {
      throw new BrokerRefused("branch-prefix", "the PR head is not a content branch", 409);
    }
    if (pr.base?.ref !== rc.baseBranch) {
      throw new BrokerRefused("base-not-allowed", `the PR does not target ${rc.baseBranch}`, 409);
    }

    const owner = this.#ownerOf(rc, pr.head.ref);
    if (!this.#isPrivileged(who) && (!owner || owner.toLowerCase() !== who.login.toLowerCase())) {
      throw new BrokerRefused(
        "pr-not-owned",
        "only the branch owner or an operator/admin may close this PR",
        403
      );
    }

    await this.#api("PATCH", `/pulls/${prNumber}`, { body: { state: "closed" }, repo: rc.key });

    const result = {
      number: pr.number,
      closed: true,
      already: false,
      merged: false,
      head_sha: pr.head?.sha ?? "",
      url: pr.html_url ?? "",
      idempotent: false,
    };
    this.#remember(idemKey, result);
    this.#audit({
      requestId,
      op: "pr_close",
      member: who.login,
      kind: who.kind,
      repo: rc.key,
      pr: prNumber,
      headSha: result.head_sha,
    });
    return result;
  }

  /* ---------------- read proxy ---------------- */

  /**
   * Resolve a branch head for the client. Used by repo_edit before it builds
   * a commit, so a client that cannot reach api.github.com can still supply
   * the base_sha the broker requires.
   */
  async readBaseSha({ repo, ref, feishuToken, sessionToken } = {}) {
    const who = await this.#authorizeRead("race-ops.repo_read", { feishuToken, sessionToken });
    const rc = this.#repoConfig(repo);
    const wanted = this.#readRef(ref, rc.baseBranch);
    const token = await this.#readToken(rc);
    const sha = await this.readCache.baseSha(rc, token, wanted);
    if (!sha) throw new BrokerRefused("ref-not-found", `branch ${wanted} does not exist`, 404);
    return { repository: rc.key, ref: wanted, sha, login: who.login };
  }

  /**
   * Stream a bundle for every branch. The client clones or fetches this
   * local file; its `origin` stays the clean GitHub URL for identity only.
   */
  async readBundle({ repo, ref, operation = "race-ops.repo_clone", feishuToken, sessionToken } = {}) {
    await this.#authorizeRead(operation, { feishuToken, sessionToken });
    const rc = this.#repoConfig(repo);
    const wanted = this.#readRef(ref, rc.baseBranch);
    const token = await this.#readToken(rc);
    const sha = await this.readCache.baseSha(rc, token, wanted);
    if (!sha) throw new BrokerRefused("ref-not-found", `branch ${wanted} does not exist`, 404);
    const bundle = await this.readCache.bundle(rc, token);
    return { repository: rc.key, ref: wanted, sha, ...bundle };
  }

  async readPulls({ repo, state = "open", base, feishuToken, sessionToken } = {}) {
    await this.#authorizeRead("race-ops.pr_list", { feishuToken, sessionToken });
    const rc = this.#repoConfig(repo);
    const wantedState = ["open", "closed", "all"].includes(String(state)) ? String(state) : "open";
    const wantedBase = this.#readRef(base, rc.baseBranch);
    const rows = await this.#readApi(
      `/pulls?state=${wantedState}&base=${encodeURIComponent(wantedBase)}&per_page=100&sort=updated&direction=desc`,
      { repo: rc.key }
    );
    return { repository: rc.key, items: Array.isArray(rows) ? rows : [] };
  }

  async readPr({ repo, number, feishuToken, sessionToken } = {}) {
    await this.#authorizeRead("race-ops.pr_preview", { feishuToken, sessionToken });
    const prNumber = Number(number);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new BrokerRefused("pr-number-invalid", "pr_number must be a positive integer", 400);
    }
    const rc = this.#repoConfig(repo);
    const pr = await this.#readApi(`/pulls/${prNumber}`, { repo: rc.key });
    if (!pr) throw new BrokerRefused("pr-not-found", `PR #${prNumber} does not exist`, 404);
    return { repository: rc.key, pr };
  }

  async readChecks({ repo, number, feishuToken, sessionToken } = {}) {
    const { pr } = await this.readPr({ repo, number, feishuToken, sessionToken });
    const rc = this.#repoConfig(repo);
    const checks = await this.#readApi(
      `/commits/${encodeURIComponent(pr.head.sha)}/check-runs?per_page=100`,
      { repo: rc.key }
    );
    return {
      repository: rc.key,
      head_sha: pr.head.sha,
      check_runs: Array.isArray(checks?.check_runs) ? checks.check_runs : [],
    };
  }

  async #fetchMergeablePr(prNumber, rc = this.defaultRepo) {
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new BrokerRefused("pr-number-invalid", "pr_number must be a positive integer", 400);
    }
    let pr = await this.#api("GET", `/pulls/${prNumber}`, { repo: rc.key });
    if (!pr || pr.state !== "open") {
      throw new BrokerRefused("pr-not-open", `PR #${prNumber} is not open`, 409);
    }
    if (pr.draft) {
      await this.#api("PATCH", `/pulls/${prNumber}`, { body: { draft: false }, repo: rc.key });
      pr = await this.#api("GET", `/pulls/${prNumber}`, { repo: rc.key });
    }
    if (!String(pr.head?.ref ?? "").startsWith(rc.branchPrefix)) {
      throw new BrokerRefused("branch-prefix", "the PR head is not a content branch", 409);
    }
    if (pr.base?.ref !== rc.baseBranch) {
      throw new BrokerRefused("base-not-allowed", `the PR does not target ${rc.baseBranch}`, 409);
    }
    for (let i = 0; i < 5 && pr.mergeable_state === "unknown"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      pr = await this.#api("GET", `/pulls/${prNumber}`, { repo: rc.key });
    }
    if (pr.mergeable_state !== "clean") {
      throw new BrokerRefused(
        "pr-not-mergeable",
        `GitHub reports mergeable_state=${pr.mergeable_state ?? "unknown"}`,
        409
      );
    }
    return pr;
  }

  /**
   * Step 1 of a merge: bind the user's intent to this PR's current head.
   * The returned id is single-use and expires quickly.
   */
  async approvePrMerge(args = {}) {
    const who = await this.#authorizeWrite(FEISHU_MERGE_OPERATION, args);
    const rc = this.#repoConfig(args.repo);
    const prNumber = Number(args.prNumber ?? args.pr_number);
    const mergeMethod = String(args.mergeMethod ?? args.merge_method ?? "squash");
    if (!["merge", "squash", "rebase"].includes(mergeMethod)) {
      throw new BrokerRefused("merge-method-invalid", "merge_method must be merge, squash or rebase", 400);
    }
    const commitTitle = String(args.commitTitle ?? args.commit_title ?? "");
    if (Buffer.byteLength(commitTitle) > 256) {
      throw new BrokerRefused("commit-title-too-long", "commit_title is too long", 400);
    }

    const pr = await this.#fetchMergeablePr(prNumber, rc);
    await this.#assertMergeContract(prNumber, pr, rc);
    const approvalId = randomToken(32);
    const expiresAt = this.now() + APPROVAL_TTL_MS;
    this.#approvals.set(approvalId, {
      member: who.login,
      kind: who.kind,
      repo: rc.key,
      pr: prNumber,
      headSha: pr.head.sha,
      method: mergeMethod,
      title: commitTitle,
      expiresAt,
    });
    this.#audit({
      requestId: this.#requestId(args.requestId),
      op: "pr_merge_approval",
      member: who.login,
      kind: who.kind,
      repo: rc.key,
      pr: prNumber,
      headSha: pr.head.sha,
      method: mergeMethod,
    });
    return {
      approval_id: approvalId,
      pr_number: prNumber,
      head_sha: pr.head.sha,
      expires_at: expiresAt,
    };
  }

  async writePrMerge(args = {}) {
    const who = await this.#authorizeWrite(FEISHU_MERGE_OPERATION, args);
    const rc = this.#repoConfig(args.repo);
    const prNumber = Number(args.prNumber ?? args.pr_number);
    const approvalId = String(args.approvalId ?? args.approval_id ?? "");
    const requestId = this.#requestId(args.requestId);
    const idemKey = this.#idempotencyKey("pr_merge", args.idempotencyKey, {
      repo: rc.key,
      prNumber,
      approvalId,
    });
    const cached = this.#recall(idemKey);
    if (cached) return { ...cached, idempotent: true };

    const approval = this.#approvals.get(approvalId);
    if (!approval) {
      throw new BrokerRefused("approval-unknown", "merge approval is missing or already used", 409);
    }
    if (approval.expiresAt <= this.now()) {
      this.#approvals.delete(approvalId);
      throw new BrokerRefused("approval-expired", "merge approval expired; ask the user again", 409);
    }
    if (approval.member !== who.login || approval.kind !== who.kind) {
      throw new BrokerRefused("approval-member-mismatch", "this approval belongs to another member", 403);
    }
    if (approval.pr !== prNumber) {
      throw new BrokerRefused("approval-pr-mismatch", "this approval is for another PR", 403);
    }
    if (approval.repo !== rc.key) {
      throw new BrokerRefused("approval-repo-mismatch", "this approval is for another repository", 403);
    }

    let pr = await this.#api("GET", `/pulls/${prNumber}`, { repo: rc.key });
    if (!pr || pr.state !== "open") {
      throw new BrokerRefused("pr-not-open", `PR #${prNumber} is not open`, 409);
    }
    if (pr.head?.sha !== approval.headSha) {
      this.#approvals.delete(approvalId);
      throw new BrokerRefused(
        "approval-stale",
        "the PR head moved since approval; ask the user again",
        409
      );
    }
    await this.#assertMergeContract(prNumber, pr, rc);
    if (pr.mergeable_state !== "clean") {
      throw new BrokerRefused(
        "pr-not-mergeable",
        `GitHub reports mergeable_state=${pr.mergeable_state ?? "unknown"}`,
        409
      );
    }

    // Single use: consume before the call, so a lost response cannot replay it.
    this.#approvals.delete(approvalId);
    const merged = await this.#api("PUT", `/pulls/${prNumber}/merge`, {
      body: {
        merge_method: approval.method,
        ...(approval.title ? { commit_title: approval.title } : {}),
      },
      repo: rc.key,
    });
    if (!merged || merged.merged !== true) {
      throw new BrokerRefused(
        "merge-refused",
        merged?.message ? String(merged.message) : "GitHub did not merge the PR",
        409
      );
    }

    const result = {
      number: prNumber,
      merged: true,
      sha: merged.sha,
      method: approval.method,
      branch: pr.head.ref,
      idempotent: false,
    };
    this.#remember(idemKey, result);
    this.#audit({
      requestId,
      op: "pr_merge",
      member: who.login,
      kind: who.kind,
      repo: rc.key,
      pr: prNumber,
      headSha: approval.headSha,
      sha: merged.sha,
      method: approval.method,
    });
    return result;
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
    for (const [key, hit] of this.#idempotency) {
      if (hit.expiresAt <= now) this.#idempotency.delete(key);
    }
    for (const [key, approval] of this.#approvals) {
      if (approval.expiresAt <= now) this.#approvals.delete(key);
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
      // Whether this deployment can authorize a Feishu member without a
      // GitHub login. The URL itself is not secret, but it is not needed.
      feishuEnabled: Boolean(this.authUrl),
      // The write proxy is a separate switch from Feishu login.
      writeEnabled: this.writeEnabled,
      // The read proxy keeps clone/read/PR metadata off github.com for
      // clients that cannot reach GitHub at all.
      readEnabled: this.readEnabled,
      pendingApprovals: this.#approvals.size,
      idempotencyEntries: this.#idempotency.size,
    };
  }
}

function normalizeRepoPath(raw) {
  const value = String(raw ?? "");
  if (value === "" || value.length > 512) {
    throw new BrokerRefused("path-invalid", "path is empty or too long", 400);
  }
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new BrokerRefused("path-invalid", `${value} is not a relative repository path`, 400);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new BrokerRefused("path-invalid", `${value} is not a normalized repository path`, 400);
  }
  return value;
}

/** Tiny glob matcher: `**` across directories, `*` within a segment, `?` one char. */
function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

function encodeBranch(branch) {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function encodePath(pathname) {
  return pathname.split("/").map(encodeURIComponent).join("/");
}

/**
 * Default minting path: sign a JWT with the App key and exchange it for a
 * token limited to one repository. `opts.repository` is "owner/name"; the
 * installation token API takes repository *names* only.
 */
function defaultMint(core) {
  return async (opts = {}) => {
    const { createInstallationToken } = await import(
      new URL("../lib/auth/github-app.js", import.meta.url).href
    );
    const repoName = String(opts.repository ?? core.repository).split("/").pop();
    return createInstallationToken({
      appId: core.appId,
      privateKeyPem: core.privateKeyPem,
      installationId: core.installationId,
      repositories: [repoName],
      fetchImpl: core.fetchImpl,
      // Checks (membership) need the App's own permission set, so they call
      // this without options. Feishu modes pass an explicit, narrower set.
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    });
  };
}
