/**
 * Browser-side API client for dsh-mmw-tools.
 *
 * Thin fetch wrapper around the loopback routes registered by the host
 * bundle (src/routes.ts). Each method maps 1:1 to a route.
 *
 * The routes already gate on loopback origin, so this client can be
 * called from `fetch('/api/...')` without explicit CORS preflight.
 */

import { API } from "../shared/api-paths.js";

export interface StatusView {
  phase: "signed_out" | "authorizing" | "signed_in" | "expired";
  /** Which credential is active; `feishu` means no GitHub account is involved. */
  mode: "feishu" | "github" | "none";
  session: { login: string; expiresAt: number; secondsRemaining: number };
  repoAccess: { state: "ready" | "unavailable"; reason: string };
  binding: {
    owner: string;
    name: string;
    baseBranch: string;
    allowlistPaths: string[];
  };
  brokerUrl: string;
  sessionPath: string;
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
    return request(API.status) as Promise<StatusView>;
  }

  oauthStart(): Promise<OauthStartResult> {
    return request(API.oauthStart, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }) as Promise<OauthStartResult>;
  }

  oauthFinish(): Promise<SimpleResult> {
    return request(API.oauthFinish, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }) as Promise<SimpleResult>;
  }

  oauthRefresh(): Promise<SimpleResult> {
    return request(API.oauthRefresh, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }) as Promise<SimpleResult>;
  }

  revoke(): Promise<SimpleResult> {
    return request(API.revoke, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }) as Promise<SimpleResult>;
  }
}

/** Singleton shared by the panel component. */
export const githubApi = new GithubApi();

export interface FeishuStatusView {
  signedIn: boolean;
  authServiceUrl: string;
  member?: { id: string; name: string; roles: string[]; isAdmin: boolean };
  roles: string[];
  expiresAt: number;
  secondsRemaining: number;
  tokenMasked: string;
}

export interface FeishuStartResult {
  ok: boolean;
  loginId?: string;
  loginUrl?: string;
  expiresAt?: number;
  error?: string;
}

export interface FeishuPollResult {
  ok: boolean;
  status: "pending" | "authorized" | "denied" | "expired";
  member?: { id: string; name: string; roles: string[]; isAdmin: boolean };
  roles?: string[];
  reason?: string;
  error?: string;
}

export class FeishuApi {
  getStatus(): Promise<FeishuStatusView> {
    return request(API.feishuStatus) as Promise<FeishuStatusView>;
  }

  loginStart(): Promise<FeishuStartResult> {
    return request(API.feishuLoginStart, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }) as Promise<FeishuStartResult>;
  }

  loginPoll(): Promise<FeishuPollResult> {
    return request(API.feishuLoginPoll, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }) as Promise<FeishuPollResult>;
  }

  logout(): Promise<SimpleResult> {
    return request(API.feishuLogout, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }) as Promise<SimpleResult>;
  }
}

export const feishuApi = new FeishuApi();