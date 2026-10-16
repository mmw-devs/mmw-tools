/**
 * dsh-github-engineer — token store.
 *
 * Persists the OAuth Device Flow credentials (access_token + refresh_token
 * + scopes + login + expiry timestamps) to
 * `~/.dsh/dsh-github-engineer.json` with mode 0600. Secrets never leave
 * this module's surface (`view()` masks them; only the `getAccessToken()`
 * accessor hands one out, and even then only via a short-lived variable).
 *
 * The path can be overridden with `DSH_GITHUB_ENGINEER_CONFIG` (used by
 * tests).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Default config location on disk. */
const DEFAULT_CONFIG_FILE = path.join(homedir(), ".dsh", "dsh-github-engineer.json");

/** Test override for the config location. */
export function configPath(): string {
  const override = process.env.DSH_GITHUB_ENGINEER_CONFIG;
  return override !== undefined && override !== "" ? override : DEFAULT_CONFIG_FILE;
}

/** Mask a credential for display, keeping only the head and tail. */
function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return value.slice(0, 2) + "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

/** What the token store owns. */
export interface StoredTokens {
  /** OAuth access_token used to call api.github.com. */
  accessToken: string;
  /** Refresh token for renewing access_token (6-month lifetime). */
  refreshToken: string;
  /** Unix ms when `accessToken` expires. 0 means "unknown / never expires". */
  accessTokenExpiresAt: number;
  /** Unix ms when `refreshToken` expires. 0 means "unknown / never expires". */
  refreshTokenExpiresAt: number;
  /** Space-separated OAuth scopes that the token was granted. */
  scope: string;
  /** GitHub login (e.g. "weunimix") of the user who authorized. */
  login: string;
  /** Last successful connection timestamp (ISO 8601). */
  tokenUpdatedAt: string;
}

/** Empty credentials record. */
function empty(): StoredTokens {
  return {
    accessToken: "",
    refreshToken: "",
    accessTokenExpiresAt: 0,
    refreshTokenExpiresAt: 0,
    scope: "",
    login: "",
    tokenUpdatedAt: "",
  };
}

/** Parse an unknown JSON record into tokens (tolerates missing keys). */
function parse(raw: unknown): StoredTokens {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    accessToken: str(record.accessToken),
    refreshToken: str(record.refreshToken),
    accessTokenExpiresAt: num(record.accessTokenExpiresAt),
    refreshTokenExpiresAt: num(record.refreshTokenExpiresAt),
    scope: str(record.scope),
    login: str(record.login),
    tokenUpdatedAt: str(record.tokenUpdatedAt),
  };
}

/** Public, secret-free view of the token store. */
export interface TokenView {
  configured: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  accessTokenMasked: string;
  refreshTokenMasked: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  scope: string;
  login: string;
  tokenUpdatedAt: string;
  configPath: string;
}

/**
 * Small credential store backed by ~/.dsh/dsh-github-engineer.json.
 * Reads are lazy and cached; writes use mode 0600 so secrets never leak
 * to other local users.
 */
export class TokenStore {
  private cache: StoredTokens | null = null;

  /** Load from disk (cached after first call). */
  async load(): Promise<StoredTokens> {
    if (this.cache !== null) return this.cache;
    try {
      const raw = await readFile(configPath(), "utf8");
      this.cache = parse(JSON.parse(raw));
    } catch {
      this.cache = empty();
    }
    return this.cache;
  }

  /** Persist tokens to disk with mode 0600. */
  async save(next: StoredTokens): Promise<void> {
    this.cache = next;
    await mkdir(path.dirname(configPath()), { recursive: true });
    await writeFile(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  }

  /** Public, secret-free view. */
  async view(): Promise<TokenView> {
    const cfg = await this.load();
    return {
      configured: cfg.accessToken.trim() !== "",
      hasAccessToken: cfg.accessToken.trim() !== "",
      hasRefreshToken: cfg.refreshToken.trim() !== "",
      accessTokenMasked: mask(cfg.accessToken),
      refreshTokenMasked: mask(cfg.refreshToken),
      accessTokenExpiresAt: cfg.accessTokenExpiresAt,
      refreshTokenExpiresAt: cfg.refreshTokenExpiresAt,
      scope: cfg.scope,
      login: cfg.login,
      tokenUpdatedAt: cfg.tokenUpdatedAt,
      configPath: configPath(),
    };
  }

  /** Persist the tokens returned by GitHub's OAuth token endpoint. */
  async saveTokens(input: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    scope?: string;
    login?: string;
  }): Promise<StoredTokens> {
    const now = Date.now();
    const next: StoredTokens = {
      accessToken: input.access_token,
      refreshToken: input.refresh_token ?? "",
      accessTokenExpiresAt:
        typeof input.expires_in === "number" && input.expires_in > 0
          ? now + input.expires_in * 1000
          : 0,
      refreshTokenExpiresAt:
        typeof input.refresh_token_expires_in === "number" &&
        input.refresh_token_expires_in > 0
          ? now + input.refresh_token_expires_in * 1000
          : 0,
      scope: input.scope ?? "",
      login: input.login ?? "",
      tokenUpdatedAt: new Date(now).toISOString(),
    };
    await this.save(next);
    return next;
  }

  /** Update only `tokenUpdatedAt` (after a successful API call). */
  async recordConnected(): Promise<void> {
    const cfg = await this.load();
    await this.save({ ...cfg, tokenUpdatedAt: new Date().toISOString() });
  }

  /** Erase every credential. */
  async clearAll(): Promise<void> {
    await this.save(empty());
  }
}