/**
 * Broker client — everything the plugin needs to obtain write access,
 * and nothing that could mint it.
 *
 * The plugin holds a 12-hour session token (see session-store.ts) and
 * exchanges it for a 1-hour installation token on demand. The private key
 * that could mint repository access lives only on the broker
 * (docs/AUTH-BROKER.md).
 *
 * Every call is deadline-bound: `fetch` has no default timeout, and a
 * hung broker must surface as an error the agent can report, not as a
 * tool call that never returns.
 */
const REQUEST_TIMEOUT_MS = 15_000;
export class BrokerError extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.name = "BrokerError";
        this.code = code;
        if (status !== undefined)
            this.status = status;
    }
}
function trimTrailingSlash(url) {
    return url.endsWith("/") ? url.slice(0, -1) : url;
}
export class BrokerClient {
    base;
    doFetch;
    timeoutMs;
    constructor(opts) {
        if (!opts.brokerUrl || !/^https?:\/\//.test(opts.brokerUrl)) {
            throw new BrokerError("broker-unreachable", `brokerUrl must be an absolute http(s) URL, got ${JSON.stringify(opts.brokerUrl)}`);
        }
        this.base = trimTrailingSlash(opts.brokerUrl);
        this.doFetch = opts.fetchImpl ?? fetch;
        this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    }
    async request(pathname, init) {
        const headers = {
            Accept: "application/json",
            "User-Agent": "dsh-github-engineer",
            ...(init.headers ?? {}),
        };
        if (init.bearer)
            headers.Authorization = `Bearer ${init.bearer}`;
        let res;
        try {
            res = await this.doFetch(`${this.base}${pathname}`, {
                ...init,
                headers,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        }
        catch (err) {
            const name = err?.name;
            if (name === "TimeoutError" || name === "AbortError") {
                throw new BrokerError("broker-timeout", `broker did not answer within ${this.timeoutMs / 1000}s`);
            }
            throw new BrokerError("broker-unreachable", `could not reach the broker: ${err.message}`);
        }
        if (res.status === 401 || res.status === 403) {
            throw new BrokerError("session-rejected", "the broker rejected this session; sign in again", res.status);
        }
        if (res.status === 429) {
            throw new BrokerError("broker-bad-response", "the broker is rate limiting; retry shortly", 429);
        }
        if (!res.ok) {
            let message = `HTTP ${res.status}`;
            try {
                const body = (await res.json());
                if (typeof body.message === "string")
                    message = body.message;
                else if (typeof body.error === "string")
                    message = body.error;
            }
            catch {
                /* status-only */
            }
            throw new BrokerError("broker-bad-response", `broker refused the request: ${message}`, res.status);
        }
        try {
            return await res.json();
        }
        catch {
            throw new BrokerError("broker-bad-response", "the broker returned a non-JSON body");
        }
    }
    /** Step 1: ask the broker for a login URL. No credentials involved. */
    async startSession() {
        const body = (await this.request("/session/start", { method: "POST" }));
        if (typeof body.state !== "string" ||
            typeof body.pollSecret !== "string" ||
            typeof body.loginUrl !== "string" ||
            typeof body.expiresAt !== "number") {
            throw new BrokerError("broker-bad-response", "the broker's /session/start reply is malformed");
        }
        return {
            state: body.state,
            pollSecret: body.pollSecret,
            loginUrl: body.loginUrl,
            expiresAt: body.expiresAt,
        };
    }
    /** Step 2: poll until the human finishes in the browser. */
    async pollSession(state, pollSecret) {
        const body = (await this.request(`/session/${encodeURIComponent(state)}?secret=${encodeURIComponent(pollSecret)}`, { method: "GET" }));
        switch (body.status) {
            case "pending":
            case "expired":
                return { status: body.status };
            case "denied":
                return { status: "denied", reason: typeof body.reason === "string" ? body.reason : "denied" };
            case "authorized": {
                if (typeof body.sessionToken !== "string" || typeof body.expiresAt !== "number") {
                    throw new BrokerError("broker-bad-response", "the broker's authorized reply is malformed");
                }
                return {
                    status: "authorized",
                    sessionToken: body.sessionToken,
                    login: typeof body.login === "string" ? body.login : "",
                    expiresAt: body.expiresAt,
                };
            }
            default:
                throw new BrokerError("broker-bad-response", `the broker returned an unknown session status: ${String(body.status)}`);
        }
    }
    /** Step 3: exchange the session for a 1-hour installation token. */
    async getInstallationToken(sessionToken) {
        if (!sessionToken) {
            throw new BrokerError("session-required", "no session token; sign in first");
        }
        const body = (await this.request("/installation-token", {
            method: "POST",
            bearer: sessionToken,
        }));
        if (typeof body.token !== "string" || typeof body.expiresAt !== "number") {
            throw new BrokerError("broker-bad-response", "the broker's installation token reply is malformed");
        }
        const permissions = {};
        if (body.permissions && typeof body.permissions === "object") {
            for (const [k, v] of Object.entries(body.permissions)) {
                if (typeof v === "string")
                    permissions[k] = v;
            }
        }
        return {
            token: body.token,
            expiresAt: body.expiresAt,
            repository: typeof body.repository === "string" ? body.repository : "",
            permissions,
        };
    }
    /** Revoke server-side; local deletion alone would leave it usable. */
    async revoke(sessionToken) {
        if (!sessionToken)
            return;
        await this.request("/session/revoke", { method: "POST", bearer: sessionToken });
    }
}
