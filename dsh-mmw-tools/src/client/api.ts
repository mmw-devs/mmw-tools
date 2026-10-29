/**
 * Browser-side API client for dsh-mmw-tools.
 *
 * Thin fetch wrapper around the loopback routes registered by the host
 * bundle (src/routes.ts). Each method maps 1:1 to a route.
 *
 * The routes already gate on loopback origin, so this client can be
 * called from `fetch('/api/...')` without explicit CORS preflight.
 */

export interface StatusView {
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
  status: "no_token" | "device_pending" | "authorized" | "reauth_needed";
}

export interface OauthStartResult {
  ok: boolean;
  userCode?: string;
  verificationUri?: string;
  expiresAt?: number;
  interval?: number;
  error?: string;
}

export interface SimpleResult {
  ok: boolean;
  message: string;
}

export class GithubApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubApiError";
  }
}

async function readJson(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GithubApiError(`HTTP ${response.status}: invalid JSON response`);
  }
  if (!response.ok) {
    const errField =
      typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${response.status}`;
    throw new GithubApiError(errField);
  }
  return body;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (err) {
    throw new GithubApiError(
      "网络请求失败: " + (err instanceof Error ? err.message : String(err))
    );
  }
  return readJson(response);
}

export class GithubApi {
  getStatus(): Promise<StatusView> {
    return request("/api/mmw-tools/status") as Promise<StatusView>;
  }

  oauthStart(): Promise<OauthStartResult> {
    return request("/api/mmw-tools/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }) as Promise<OauthStartResult>;
  }

  oauthFinish(): Promise<SimpleResult> {
    return request("/api/mmw-tools/oauth/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }) as Promise<SimpleResult>;
  }

  oauthRefresh(): Promise<SimpleResult> {
    return request("/api/mmw-tools/oauth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }) as Promise<SimpleResult>;
  }

  revoke(): Promise<SimpleResult> {
    return request("/api/mmw-tools/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }) as Promise<SimpleResult>;
  }
}

/** Singleton shared by the panel component. */
export const githubApi = new GithubApi();