/** Route paths — all prefixed with /api/github-engineer/. */
export const API = {
    status: "/api/github-engineer/status",
    oauthStart: "/api/github-engineer/oauth/start",
    oauthFinish: "/api/github-engineer/oauth/finish",
    oauthRefresh: "/api/github-engineer/oauth/refresh",
    revoke: "/api/github-engineer/revoke",
};
/** Max JSON body size: 256 KiB. */
const MAX_JSON_BODY_BYTES = 256 * 1024;
function getHeader(req, name) {
    const v = req.headers[name.toLowerCase()];
    if (typeof v === "string")
        return v;
    if (Array.isArray(v))
        return v[0];
    return undefined;
}
/** Reject any non-loopback request. */
export function isLoopbackRequest(req) {
    const address = req.socket.remoteAddress;
    if (address !== "127.0.0.1" &&
        address !== "::1" &&
        address !== "::ffff:127.0.0.1")
        return false;
    const host = getHeader(req, "host");
    if (typeof host !== "string")
        return false;
    let hostUrl;
    try {
        hostUrl = new URL(`http://${host}`);
    }
    catch {
        return false;
    }
    if (hostUrl.hostname !== "127.0.0.1" &&
        hostUrl.hostname !== "localhost" &&
        hostUrl.hostname !== "[::1]")
        return false;
    if (getHeader(req, "sec-fetch-site") === "cross-site")
        return false;
    const origin = getHeader(req, "origin");
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host === hostUrl.host;
    }
    catch {
        return false;
    }
}
/** Write a JSON response. */
export function writeJson(res, status, body) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "referrer-policy": "no-referrer",
    });
    res.end(JSON.stringify(body));
}
/** Read a JSON request body. Returns undefined when too large or unparseable. */
export async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_JSON_BODY_BYTES)
            return undefined;
        chunks.push(chunk);
    }
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return typeof parsed === "object" && parsed !== null ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/** Loopback + method guard. Returns true on success. */
function guard(req, res, method) {
    if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: "forbidden: loopback-only" });
        return false;
    }
    const m = (req.method ?? "GET").toUpperCase();
    if (m !== method) {
        writeJson(res, 405, { error: `method not allowed: ${m}` });
        return false;
    }
    return true;
}
/** Build all /api/github-engineer/* routes. */
export function makeRoutes(deps) {
    const { store, flow } = deps;
    return [
        {
            kind: "exact",
            path: API.status,
            handler: async (req, res) => {
                if (!guard(req, res, "GET"))
                    return;
                // docs/PANEL-CONTRACT.md §8. The OAuth-era fields (configured,
                // accessTokenMasked, scope, ...) are deliberately gone: they
                // described one credential where there are now two, which is what
                // let the panel show "configured: true" next to "no_token".
                const view = await store.view();
                const phase = await flow.phase();
                const repoAccess = await flow.repoAccess();
                writeJson(res, 200, {
                    phase,
                    session: {
                        login: view.login,
                        expiresAt: view.accessTokenExpiresAt,
                        secondsRemaining: Math.max(0, Math.floor((view.accessTokenExpiresAt - Date.now()) / 1000)),
                    },
                    repoAccess,
                    binding: deps.binding,
                    brokerUrl: deps.brokerUrl,
                    sessionPath: view.configPath,
                });
            },
        },
        {
            kind: "exact",
            path: API.oauthStart,
            handler: async (req, res) => {
                if (!guard(req, res, "POST"))
                    return;
                try {
                    const pending = await flow.begin();
                    writeJson(res, 200, {
                        ok: true,
                        userCode: pending.userCode,
                        verificationUri: pending.verificationUri,
                        expiresAt: pending.expiresAt,
                        interval: pending.interval,
                    });
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    writeJson(res, 200, { ok: false, error: message });
                }
            },
        },
        {
            kind: "exact",
            path: API.oauthFinish,
            handler: async (req, res) => {
                if (!guard(req, res, "POST"))
                    return;
                // No body is required. The poll has all the state it needs, and the
                // panel sends none — requiring JSON here turned a button click into
                // "HTTP 400: invalid JSON response". A body is still accepted and
                // ignored, so an older panel keeps working.
                await readJsonBody(req).catch(() => undefined);
                const result = await flow.poll();
                if (result.ok) {
                    writeJson(res, 200, {
                        ok: true,
                        message: "授权完成。access_token 已保存。",
                        login: result.tokens.login,
                        scope: result.tokens.scope,
                    });
                    return;
                }
                writeJson(res, 200, { ok: false, error: result.message });
            },
        },
        {
            kind: "exact",
            path: API.oauthRefresh,
            handler: async (req, res) => {
                if (!guard(req, res, "POST"))
                    return;
                const result = await flow.refresh();
                writeJson(res, 200, { ok: result.ok, message: result.message });
            },
        },
        {
            kind: "exact",
            path: API.revoke,
            handler: async (req, res) => {
                if (!guard(req, res, "POST"))
                    return;
                await flow.clearAll();
                const view = await store.view();
                writeJson(res, 200, { ok: true, message: "凭据已清空。", ...view });
            },
        },
    ];
}
