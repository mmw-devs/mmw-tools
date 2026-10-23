/**
 * dsh-github-engineer — OAuth Device Flow state machine.
 *
 * Implements the GitHub Device Authorization Grant
 * (RFC 8628): the plugin (a "headless" client) asks GitHub for a
 * one-time `device_code` + a short `user_code`. The user types the
 * `user_code` at `https://github.com/login/device` in any browser,
 * authorizes the app, and the plugin polls GitHub for the access_token.
 *
 * Endpoints used:
 *   POST https://github.com/login/device/code
 *   POST https://github.com/login/oauth/access_token
 *
 * Token lifetimes (per GitHub docs):
 *   access_token  — 8 hours
 *   refresh_token — 6 months without use; refreshable via grant_type=refresh_token
 *
 * Lifecycle:
 *   no_token → device_pending → authorized → (refresh loop) → authorized
 *                        ↓ failed
 *                    reauth_needed
 */
import { TokenStore, type StoredTokens } from "./token-store.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * How long a single request to GitHub may take.
 *
 * `fetch` has no default timeout. Without one, an unreachable GitHub
 * leaves `engineer_oauth_start` pending forever — the agent's tool call
 * never returns and the user sees a spinner with no error. Fifteen
 * seconds is well past a normal round trip and well short of a person's
 * patience.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * `fetch` with a deadline. Turns a timeout into an error a user can act
 * on instead of a request that never settles.
 */
async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  label = "request"
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(
        `GitHub ${label} 请求超时（${REQUEST_TIMEOUT_MS / 1000}s）：请检查网络或代理后重试。`
      );
    }
    throw new Error(
      `GitHub ${label} 请求失败：${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** What the plugin holds while waiting for the user. */
export interface PendingFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds between polls. */
  interval: number;
  /** Unix ms when this flow becomes invalid. */
  expiresAt: number;
}

/** Public status shape returned by `status()`. */
export type AuthStatus =
  | "no_token"
  | "device_pending"
  | "authorized"
  | "reauth_needed";

/** Result envelope used by routes + agent tools. */
export interface FlowResult {
  ok: boolean;
  message: string;
}

/** GitHub's `device/code` response shape. */
interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** GitHub's `access_token` response shape. */
interface AccessTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
  error_uri?: string;
}

/** Convert a GitHub error code into a user-friendly message. */
function describeError(body: AccessTokenResponse): string {
  const code = body.error ?? "";
  const desc = body.error_description ?? "";
  switch (code) {
    case "authorization_pending":
      return "用户在浏览器还没完成授权。";
    case "slow_down":
      return "请求过于频繁，间隔时间被拉长。";
    case "expired_token":
      return "授权码已过期（5 分钟内未完成）。请重新发起授权。";
    case "access_denied":
      return "用户拒绝授权。";
    case "incorrect_client_credentials":
      return "client_id 无效或未启用 Device Flow。";
    case "unsupported_grant_type":
      return "grant_type 不被支持。";
    case "invalid_grant":
      return "refresh_token 无效或已过期，需要重新发起授权。";
    default:
      return `${code}${desc ? ": " + desc : ""}`.trim() || "未知错误";
  }
}

/**
 * Fetch the authenticated user's login via the GitHub `/user` endpoint.
 * Used after a successful token exchange so the store has a `login` to
 * surface in `engineer_status`. Returns "" on any failure.
 */
async function fetchLogin(accessToken: string): Promise<string> {
  try {
    // Also deadline-bound: this runs inside the token-exchange path, so
    // a hung /user call would hold the whole `engineer_oauth_finish`.
    const r = await fetchWithDeadline(
      "https://api.github.com/user",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "dsh-github-engineer",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      "user"
    );
    if (!r.ok) return "";
    const data = (await r.json()) as { login?: string };
    return typeof data.login === "string" ? data.login : "";
  } catch {
    return "";
  }
}

/**
 * Device Flow state machine. Backed by `TokenStore` for persistence and
 * a single in-memory `pending` field for the active authorization.
 */
export class DeviceFlow {
  private store: TokenStore;
  private clientId: string;
  private scopes: string[];
  private pending: PendingFlow | null = null;
  private lastStatus: AuthStatus = "no_token";

  constructor(opts: { store: TokenStore; clientId: string; scopes: string[] }) {
    this.store = opts.store;
    this.clientId = opts.clientId;
    this.scopes = opts.scopes;
  }

  /** Best-effort status query. `lastStatus` is the cached value. */
  status(): AuthStatus {
    return this.lastStatus;
  }

  /** The pending flow, if any and not expired. */
  getPending(): PendingFlow | null {
    if (this.pending === null) return null;
    if (Date.now() >= this.pending.expiresAt) {
      this.pending = null;
      this.lastStatus = "no_token";
      return null;
    }
    return this.pending;
  }

  /**
   * Step 1 — request a `device_code` from GitHub. Returns the user-facing
   * instructions (user_code + verification_uri) and stores the rest.
   */
  async begin(): Promise<{ userCode: string; verificationUri: string; expiresAt: number; interval: number }> {
    if (this.clientId.trim() === "") {
      throw new Error(
        "尚未配置 GitHub OAuth App client_id：请在 cordis.patch.yml 填写 githubOAuthClientId。"
      );
    }

    const r = await fetchWithDeadline(DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "dsh-github-engineer",
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        scope: this.scopes.join(" "),
      }).toString(),
    });

    if (!r.ok) {
      throw new Error(`GitHub /login/device/code 返回 ${r.status}`);
    }
    const data = (await r.json()) as DeviceCodeResponse;
    if (!data.device_code || !data.user_code) {
      throw new Error("GitHub 响应缺少 device_code/user_code");
    }

    this.pending = {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      interval: data.interval ?? 5,
      expiresAt: Date.now() + (data.expires_in ?? 900) * 1000,
    };
    this.lastStatus = "device_pending";
    return {
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresAt: this.pending.expiresAt,
      interval: this.pending.interval,
    };
  }

  /**
   * Step 2 — exchange a `device_code` for tokens. Polls every
   * `pending.interval` seconds; respects `slow_down` by extending the
   * interval by 5 seconds.
   *
   * Returns the StoredTokens on success, or a FlowResult with
   * `ok=false` when the user hasn't completed yet (so the agent can
   * keep polling).
   */
  async poll(): Promise<{ ok: true; tokens: StoredTokens } | { ok: false; message: string }> {
    const pending = this.getPending();
    if (pending === null) {
      return { ok: false, message: "没有待完成的授权流程：请先发起登录授权。" };
    }

    const r = await fetchWithDeadline(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "dsh-github-engineer",
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        device_code: pending.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
    });

    const body = (await r.json().catch(() => ({}))) as AccessTokenResponse;

    // Still waiting.
    if (body.error === "authorization_pending") {
      return { ok: false, message: describeError(body) };
    }
    if (body.error === "slow_down") {
      pending.interval += 5;
      return { ok: false, message: describeError(body) };
    }
    // Hard failures.
    if (body.error === "expired_token" || body.error === "access_denied") {
      this.pending = null;
      this.lastStatus = "no_token";
      return { ok: false, message: describeError(body) };
    }
    if (body.error || !body.access_token) {
      return { ok: false, message: describeError(body) };
    }

    // Success — fetch login, persist, clear pending.
    const login = await fetchLogin(body.access_token);
    const tokens = await this.store.saveTokens({
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_in: body.expires_in,
      refresh_token_expires_in: body.refresh_token_expires_in,
      scope: body.scope,
      login,
    });
    this.pending = null;
    this.lastStatus = "authorized";
    return { ok: true, tokens };
  }

  /**
   * Refresh using the saved refresh_token. Returns true on success.
   * On failure, marks `lastStatus` as `reauth_needed` so the UI shows
   * a "reconnect" prompt.
   */
  async refresh(): Promise<FlowResult> {
    const cfg = await this.store.load();
    if (cfg.refreshToken.trim() === "") {
      this.lastStatus = "reauth_needed";
      return { ok: false, message: "没有 refresh_token：请重新发起登录授权（需要 scope 含 offline_access）。" };
    }

    const r = await fetchWithDeadline(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "dsh-github-engineer",
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        grant_type: "refresh_token",
        refresh_token: cfg.refreshToken,
      }).toString(),
    });

    const body = (await r.json().catch(() => ({}))) as AccessTokenResponse;
    if (body.error || !body.access_token) {
      this.lastStatus = "reauth_needed";
      return { ok: false, message: "刷新失败：" + describeError(body) };
    }

    const login = cfg.login || (await fetchLogin(body.access_token));
    await this.store.saveTokens({
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? cfg.refreshToken,
      expires_in: body.expires_in,
      refresh_token_expires_in: body.refresh_token_expires_in,
      scope: body.scope ?? cfg.scope,
      login,
    });
    this.lastStatus = "authorized";
    return { ok: true, message: "刷新成功。" };
  }

  /**
   * Refresh the access_token if it's missing, expired, or within 5
   * minutes of expiry. Returns true when a refresh happened.
   *
   * This is the function the watchdog calls periodically.
   */
  async ensureFresh(): Promise<boolean> {
    const cfg = await this.store.load();
    if (cfg.accessToken.trim() === "") return false;
    if (cfg.accessTokenExpiresAt <= 0) return false; // unknown expiry → don't risk it
    if (cfg.accessTokenExpiresAt - Date.now() > 5 * 60 * 1000) return false;
    if (cfg.refreshToken.trim() === "") return false;
    const result = await this.refresh();
    return result.ok;
  }

  /** Abort any pending flow (used by clear/reset). */
  abort(): void {
    this.pending = null;
    this.lastStatus = "no_token";
  }

  /** Erase all credentials and clear pending flow. */
  async clearAll(): Promise<void> {
    this.pending = null;
    this.lastStatus = "no_token";
    await this.store.clearAll();
  }

  /** Initialize `lastStatus` from disk (called once on bundle apply). */
  async hydrate(): Promise<void> {
    const cfg = await this.store.load();
    if (cfg.accessToken.trim() === "") {
      this.lastStatus = "no_token";
      return;
    }
    if (cfg.accessTokenExpiresAt > 0 && cfg.accessTokenExpiresAt <= Date.now()) {
      this.lastStatus = "reauth_needed";
      return;
    }
    this.lastStatus = "authorized";
  }
}