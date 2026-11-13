/**
 * Browser-side API client for dsh-mmw-tools.
 *
 * Thin fetch wrapper around the loopback routes registered by the host
 * bundle (src/routes.ts). The only user-facing credential is Feishu; the
 * broker owns the GitHub App identity.
 *
 * The routes already gate on loopback origin, so this client can be
 * called from `fetch('/api/...')` without explicit CORS preflight.
 */

import { API } from "../shared/api-paths.js";

export interface SimpleResult {
  ok: boolean;
  message: string;
}

class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function readJson(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(`HTTP ${response.status}: invalid JSON response`);
  }
  if (!response.ok) {
    const errField =
      typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${response.status}`;
    throw new ApiError(errField);
  }
  return body;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (err) {
    throw new ApiError(
      "网络请求失败: " + (err instanceof Error ? err.message : String(err))
    );
  }
  return readJson(response);
}

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
