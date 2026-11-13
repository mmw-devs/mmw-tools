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
class ApiError extends Error {
    constructor(message) {
        super(message);
        this.name = "ApiError";
    }
}
async function readJson(response) {
    let body;
    try {
        body = await response.json();
    }
    catch {
        throw new ApiError(`HTTP ${response.status}: invalid JSON response`);
    }
    if (!response.ok) {
        const errField = typeof body === "object" && body !== null && typeof body.error === "string"
            ? body.error
            : `HTTP ${response.status}`;
        throw new ApiError(errField);
    }
    return body;
}
async function request(path, init) {
    let response;
    try {
        response = await fetch(path, init);
    }
    catch (err) {
        throw new ApiError("网络请求失败: " + (err instanceof Error ? err.message : String(err)));
    }
    return readJson(response);
}
export class FeishuApi {
    getStatus() {
        return request(API.feishuStatus);
    }
    loginStart() {
        return request(API.feishuLoginStart, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
    }
    loginPoll() {
        return request(API.feishuLoginPoll, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
    }
    logout() {
        return request(API.feishuLogout, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
    }
}
export const feishuApi = new FeishuApi();
