/**
 * GitHub App authentication — JWT minting and installation-token
 * exchange. See docs/AUTH-BROKER.md §3 and §5.
 *
 * This module is deliberately free of the broker and of the plugin's
 * context: it takes an App id, a private key and an installation id, and
 * returns a short-lived token. That makes it testable offline with a
 * locally generated keypair and a stubbed fetch.
 *
 * Invariants that matter:
 *   - The private key never leaves the caller's process except as an
 *     RSA signature inside a JWT.
 *   - No error message may contain the private key, the JWT, or a
 *     freshly minted token. Errors carry a code and GitHub's `message`
 *     field only.
 *   - Installation tokens live 1 hour; callers must cache by
 *     `expiresAt`, never assume 3600s from creation time.
 */

import { createSign } from "node:crypto";

const GITHUB_API = "https://api.github.com";

/** GitHub rejects JWTs whose `exp` is more than 10 minutes ahead. */
const JWT_BACKDATE_SECONDS = 60;
const JWT_TTL_SECONDS = 540;

export type GithubAppErrorCode =
  | "jwt-invalid-key"
  | "token-exchange-failed"
  | "token-response-malformed";

export class GithubAppError extends Error {
  readonly code: GithubAppErrorCode;
  constructor(code: GithubAppErrorCode, message: string) {
    super(message);
    this.name = "GithubAppError";
    this.code = code;
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface MintAppJwtOptions {
  appId: string | number;
  privateKeyPem: string;
  /** Unix seconds; injectable for tests. */
  now?: number;
}

/**
 * Mint the RS256 JWT GitHub requires for App-level endpoints.
 *
 * `iss` is the App id, `iat` is backdated 60 s to tolerate clock skew,
 * and `exp` is 9 minutes out — inside GitHub's 10-minute ceiling.
 */
export function mintAppJwt(opts: MintAppJwtOptions): string {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - JWT_BACKDATE_SECONDS,
    exp: now + JWT_TTL_SECONDS,
    iss: String(opts.appId),
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(
    JSON.stringify(payload)
  )}`;

  let signature: Buffer;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    signature = signer.sign(opts.privateKeyPem);
  } catch (err) {
    // Deliberately does not echo the key or the signer's message: the
    // message can quote key material.
    throw new GithubAppError(
      "jwt-invalid-key",
      `could not sign the App JWT; the private key is unreadable or not an RSA key (${
        (err as NodeJS.ErrnoException).code ?? "unknown error"
      })`
    );
  }

  return `${signingInput}.${b64url(signature)}`;
}

export interface InstallationToken {
  token: string;
  /** Unix ms, taken from GitHub's `expires_at`. */
  expiresAt: number;
  permissions: Record<string, string>;
  repositories: string[];
}

export interface CreateInstallationTokenOptions {
  appId: string | number;
  privateKeyPem: string;
  installationId: string | number;
  /** Restrict the token to these repositories. Omit for all installed. */
  repositories?: string[];
  fetchImpl?: typeof fetch;
  now?: number;
}

/**
 * Exchange an App JWT for an installation access token.
 *
 * The token is what actually writes to the repository; it lasts one hour
 * and must never be persisted.
 */
export async function createInstallationToken(
  opts: CreateInstallationTokenOptions
): Promise<InstallationToken> {
  const jwt = mintAppJwt({
    appId: opts.appId,
    privateKeyPem: opts.privateKeyPem,
    now: opts.now,
  });
  const doFetch = opts.fetchImpl ?? fetch;

  const url = `${GITHUB_API}/app/installations/${encodeURIComponent(
    String(opts.installationId)
  )}/access_tokens`;

  const body: Record<string, unknown> = {};
  if (opts.repositories && opts.repositories.length > 0) {
    body.repositories = opts.repositories;
  }

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dsh-github-engineer-broker",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new GithubAppError(
      "token-exchange-failed",
      `could not reach GitHub to exchange the App JWT: ${
        (err as Error).message
      }`
    );
  }

  if (!res.ok) {
    // Only GitHub's `message` is surfaced. The response body could, on an
    // unexpected shape, carry a token; the status and message are enough
    // to diagnose a bad installation id or an under-scoped App.
    let message = `HTTP ${res.status}`;
    try {
      const payload = (await res.json()) as { message?: unknown };
      if (typeof payload.message === "string") message = payload.message;
    } catch {
      /* keep the status-only message */
    }
    throw new GithubAppError(
      "token-exchange-failed",
      `GitHub refused the installation token (HTTP ${res.status}): ${message}`
    );
  }

  let payload: {
    token?: unknown;
    expires_at?: unknown;
    permissions?: unknown;
    repositories?: unknown;
  };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new GithubAppError(
      "token-response-malformed",
      "GitHub returned a non-JSON body for the installation token"
    );
  }

  if (typeof payload.token !== "string" || payload.token.length === 0) {
    throw new GithubAppError(
      "token-response-malformed",
      "GitHub returned no installation token"
    );
  }
  if (typeof payload.expires_at !== "string") {
    throw new GithubAppError(
      "token-response-malformed",
      "GitHub returned no expiry for the installation token"
    );
  }
  const expiresAt = Date.parse(payload.expires_at);
  if (!Number.isFinite(expiresAt)) {
    throw new GithubAppError(
      "token-response-malformed",
      "GitHub returned an unparseable installation token expiry"
    );
  }

  const permissions: Record<string, string> = {};
  if (payload.permissions && typeof payload.permissions === "object") {
    for (const [k, v] of Object.entries(payload.permissions as Record<string, unknown>)) {
      if (typeof v === "string") permissions[k] = v;
    }
  }

  const repositories = Array.isArray(payload.repositories)
    ? (payload.repositories as Array<{ full_name?: unknown }>)
        .map((r) => (typeof r?.full_name === "string" ? r.full_name : ""))
        .filter((s) => s.length > 0)
    : [];

  return { token: payload.token, expiresAt, permissions, repositories };
}

/**
 * A tiny cache with the 1-hour installation token in mind: refresh
 * `marginMs` before GitHub's own expiry rather than on a fixed interval.
 */
export class InstallationTokenCache {
  private current: InstallationToken | null = null;
  constructor(private readonly marginMs = 10 * 60 * 1000) {}

  /** Returns a token, or null when absent or too close to expiry. */
  get(now = Date.now()): InstallationToken | null {
    if (!this.current) return null;
    if (this.current.expiresAt - this.marginMs <= now) return null;
    return this.current;
  }

  set(token: InstallationToken): void {
    this.current = token;
  }

  clear(): void {
    this.current = null;
  }
}
