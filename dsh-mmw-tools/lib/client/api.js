/**
 * Browser-side API client for dsh-mmw-tools.
 *
 * Thin fetch wrapper around the loopback routes registered by the host
 * bundle (src/routes.ts). Each method maps 1:1 to a route.
 *
 * The routes already gate on loopback origin, so this client can be
 * called from `fetch('/api/...')` without explicit CORS preflight.
 */
export class GithubApiError extends Error {
    constructor(message) {
        super(message);
        this.name = "GithubApiError";
    }
}
async function readJson(response) {
    let body;
    try {
        body = await response.json();
    }
    catch {
        throw new GithubApiError(`HTTP ${response.status}: invalid JSON response`);
    }
    if (!response.ok) {
        const errField = typeof body === "object" && body !== null && typeof body.error === "string"
            ? body.error
            : `HTTP ${response.status}`;
        throw new GithubApiError(errField);
    }
    return body;
}
async function request(path, init) {
    let response;
    try {
        response = await fetch(path, init);
    }
    catch (err) {
        throw new GithubApiError("网络请求失败: " + (err instanceof Error ? err.message : String(err)));
    }
    return readJson(response);
}
export class GithubApi {
    getStatus() {
        return request("/api/mmw-tools/status");
    }
    oauthStart() {
        return request("/api/mmw-tools/oauth/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
    }
    oauthFinish() {
        return request("/api/mmw-tools/oauth/finish", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
    }
    oauthRefresh() {
        return request("/api/mmw-tools/oauth/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
    }
    revoke() {
        return request("/api/mmw-tools/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
    }
}
/** Singleton shared by the panel component. */
export const githubApi = new GithubApi();
