/**
 * Feishu authorization client for the DSH plugin.
 *
 * The auth core owns identity/roles and the route table; this client only
 * holds the plugin token and fetches the table. The token file is 0600 and
 * contains nothing that can write a repository.
 */
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
const DEFAULT_TOKEN_FILE = path.join(homedir(), ".dsh", "dsh-mmw-tools-feishu.json");
export function feishuTokenPath() {
    const override = process.env.DSH_MMW_TOOLS_FEISHU_TOKEN;
    return override && override.length > 0 ? override : DEFAULT_TOKEN_FILE;
}
export class FeishuAuthError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "FeishuAuthError";
        this.code = code;
    }
}
function maskToken(token) {
    if (token.length <= 12)
        return "*".repeat(token.length);
    return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
export class FeishuAuth {
    authServiceUrl;
    file;
    fetchImpl;
    now;
    pending = null;
    routesCache = null;
    refreshing = null;
    constructor(opts) {
        this.authServiceUrl = opts.authServiceUrl.replace(/\/+$/, "");
        this.file = opts.file ?? feishuTokenPath();
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.now = opts.now ?? (() => Date.now());
    }
    get path() {
        return this.file;
    }
    async readRecord() {
        if (!existsSync(this.file))
            return null;
        try {
            const parsed = JSON.parse(await readFile(this.file, "utf8"));
            if (typeof parsed.pluginToken !== "string" ||
                parsed.pluginToken.length === 0 ||
                typeof parsed.expiresAt !== "number" ||
                parsed.authServiceUrl !== this.authServiceUrl ||
                !parsed.member) {
                return null;
            }
            return parsed;
        }
        catch {
            return null;
        }
    }
    async saveRecord(record) {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(this.file, JSON.stringify(record, null, 2), { mode: 0o600 });
        try {
            await chmod(this.file, 0o600);
        }
        catch {
            // Windows may not enforce POSIX modes.
        }
    }
    async clear() {
        this.routesCache = null;
        try {
            await unlink(this.file);
        }
        catch (err) {
            if (err.code !== "ENOENT")
                throw err;
        }
    }
    /**
     * Remove the local token only when it is still the one that failed.
     *
     * A refresh rotates the token on the server; another process (or the
     * watchdog) may have written the replacement while this request was in
     * flight. Deleting it would turn a transient 401 into a forced re-login.
     */
    async clearIfTokenCurrent(record) {
        const latest = await this.readRecord();
        if (latest && latest.pluginToken !== record.pluginToken)
            return;
        await this.clear();
    }
    async request(pathname, init = {}) {
        let response;
        try {
            response = await this.fetchImpl(`${this.authServiceUrl}${pathname}`, {
                ...init,
                headers: {
                    accept: "application/json",
                    ...(init.headers ?? {}),
                },
                signal: init.signal ?? AbortSignal.timeout(15_000),
            });
        }
        catch (err) {
            throw new FeishuAuthError("network", `无法连接 MMW Tools 授权服务：${err instanceof Error ? err.message : String(err)}`);
        }
        const text = await response.text();
        let body = {};
        try {
            body = text.length > 0 ? JSON.parse(text) : {};
        }
        catch {
            throw new FeishuAuthError("invalid-response", "授权服务返回了无效响应");
        }
        if (!response.ok) {
            throw new FeishuAuthError(typeof body.error === "string" ? body.error : `http-${response.status}`, typeof body.message === "string" ? body.message : `授权服务返回 HTTP ${response.status}`);
        }
        return body;
    }
    async view() {
        const record = await this.readRecord();
        if (!record || record.expiresAt <= this.now()) {
            return {
                signedIn: false,
                authServiceUrl: this.authServiceUrl,
                roles: [],
                expiresAt: 0,
                secondsRemaining: 0,
                tokenMasked: "",
            };
        }
        return {
            signedIn: true,
            authServiceUrl: this.authServiceUrl,
            member: record.member,
            roles: [...record.member.roles],
            expiresAt: record.expiresAt,
            secondsRemaining: Math.max(0, Math.floor((record.expiresAt - this.now()) / 1000)),
            tokenMasked: maskToken(record.pluginToken),
        };
    }
    async begin() {
        const body = await this.request("/v1/login/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        if (typeof body.loginId !== "string" ||
            typeof body.pollSecret !== "string" ||
            typeof body.loginUrl !== "string" ||
            typeof body.expiresAt !== "number") {
            throw new FeishuAuthError("invalid-response", "授权服务没有返回登录链接");
        }
        this.pending = {
            loginId: body.loginId,
            pollSecret: body.pollSecret,
            loginUrl: body.loginUrl,
            expiresAt: body.expiresAt,
        };
        return this.pending;
    }
    async poll() {
        if (!this.pending)
            throw new FeishuAuthError("not-pending", "没有进行中的登录");
        const { loginId, pollSecret } = this.pending;
        const body = await this.request(`/v1/login/${encodeURIComponent(loginId)}?secret=${encodeURIComponent(pollSecret)}`);
        if (body.status === "pending")
            return { status: "pending" };
        if (body.status === "denied") {
            this.pending = null;
            return { status: "denied", reason: body.reason };
        }
        if (body.status === "expired") {
            this.pending = null;
            return { status: "expired", reason: body.reason };
        }
        if (body.status === "authorized") {
            const member = body.member;
            if (!member || typeof body.pluginToken !== "string" || typeof body.expiresAt !== "number") {
                throw new FeishuAuthError("invalid-response", "授权服务返回的登录结果不完整");
            }
            const normalizedMember = {
                id: String(member.id ?? ""),
                name: String(member.name ?? ""),
                roles: Array.isArray(member.roles) ? member.roles.map(String) : [],
                isAdmin: Boolean(member.isAdmin ?? body.isAdmin),
            };
            await this.saveRecord({
                authServiceUrl: this.authServiceUrl,
                pluginToken: body.pluginToken,
                expiresAt: body.expiresAt,
                member: normalizedMember,
                roles: Array.isArray(body.roles) ? body.roles.map(String) : [],
                savedAt: this.now(),
            });
            this.pending = null;
            this.routesCache = null;
            return {
                status: "authorized",
                member: normalizedMember,
                roles: Array.isArray(body.roles) ? body.roles.map(String) : [],
            };
        }
        throw new FeishuAuthError("invalid-response", "授权服务返回了未知登录状态");
    }
    async logout() {
        const record = await this.readRecord();
        this.pending = null;
        if (record) {
            try {
                await this.request("/v1/session/logout", {
                    method: "POST",
                    headers: { authorization: `Bearer ${record.pluginToken}` },
                });
            }
            catch {
                // Local logout still wins; the server will expire the token.
            }
        }
        await this.clear();
    }
    /**
     * Rotate the plugin token. The auth core revokes the old token in the same
     * transaction, so this is only useful while the current one is still valid.
     * A failed rotation keeps the local record unless the server says the
     * session itself is gone.
     */
    async refresh() {
        const record = await this.readRecord();
        if (!record || record.expiresAt <= this.now()) {
            throw new FeishuAuthError("auth-required", "请先使用飞书登录");
        }
        let body;
        try {
            body = await this.request("/v1/session/refresh", {
                method: "POST",
                headers: { authorization: `Bearer ${record.pluginToken}` },
            });
        }
        catch (err) {
            if (err instanceof FeishuAuthError &&
                (err.code === "mmw_auth_required" || err.code === "mmw_session_expired")) {
                await this.clearIfTokenCurrent(record);
            }
            throw err;
        }
        if (!body ||
            typeof body !== "object" ||
            typeof body.pluginToken !== "string" ||
            body.pluginToken.length === 0 ||
            typeof body.expiresAt !== "number" ||
            body.expiresAt <= this.now()) {
            throw new FeishuAuthError("invalid-response", "授权服务返回的续期结果不完整");
        }
        await this.saveRecord({
            ...record,
            pluginToken: body.pluginToken,
            expiresAt: body.expiresAt,
            savedAt: this.now(),
        });
        this.routesCache = null;
        return this.view();
    }
    /**
     * Refresh opportunistically when the token is inside `minRemainingMs`.
     * Concurrent callers share one request, so a watchdog and a caller cannot
     * rotate the same token twice.
     */
    async refreshIfNeeded(minRemainingMs = 24 * 60 * 60 * 1000) {
        const record = await this.readRecord();
        if (!record || record.expiresAt <= this.now())
            return false;
        if (record.expiresAt - this.now() > minRemainingMs)
            return false;
        if (this.refreshing)
            return this.refreshing;
        const task = this.refresh()
            .then(() => true)
            .finally(() => {
            this.refreshing = null;
        });
        this.refreshing = task;
        return task;
    }
    /**
     * The plugin token to present to the broker. Refreshes first when inside the
     * watchdog window; returns null when there is no usable session.
     *
     * The token is a bearer credential — callers must not log it.
     */
    async credential() {
        const record = await this.readRecord();
        if (!record || record.expiresAt <= this.now())
            return null;
        try {
            await this.refreshIfNeeded();
        }
        catch {
            // A failed rotation is not fatal while the current token is still valid.
        }
        const latest = await this.readRecord();
        if (!latest || latest.expiresAt <= this.now())
            return null;
        return latest.pluginToken;
    }
    async me() {
        const record = await this.readRecord();
        if (!record || record.expiresAt <= this.now()) {
            throw new FeishuAuthError("auth-required", "请先使用飞书登录");
        }
        const body = await this.request("/v1/me", {
            headers: { authorization: `Bearer ${record.pluginToken}` },
        });
        const member = {
            id: String(body.id ?? record.member.id),
            name: String(body.name ?? record.member.name),
            roles: Array.isArray(body.roles) ? body.roles.map(String) : record.member.roles,
            isAdmin: Boolean(body.isAdmin),
        };
        await this.saveRecord({ ...record, member, roles: member.roles, savedAt: this.now() });
        return member;
    }
    async routes(force = false, maxAgeMs) {
        const record = await this.readRecord();
        if (!record || record.expiresAt <= this.now()) {
            throw new FeishuAuthError("auth-required", "请先使用飞书登录");
        }
        const cached = this.routesCache;
        const cacheLimit = Math.min(cached ? cached.data.ttlSeconds * 1000 : 0, maxAgeMs ?? Infinity);
        if (!force && cached && this.now() - cached.at < cacheLimit) {
            return cached.data;
        }
        try {
            const body = await this.request("/v1/agent/routes", {
                headers: { authorization: `Bearer ${record.pluginToken}` },
            });
            if (!Array.isArray(body.allowed) || !Array.isArray(body.allowedOperations)) {
                throw new FeishuAuthError("invalid-response", "授权服务返回的授权表不完整");
            }
            const data = {
                contractVersion: Number(body.contractVersion ?? 2),
                catalogRevision: String(body.catalogRevision ?? ""),
                policyRevision: Number(body.policyRevision ?? 0),
                ttlSeconds: Number(body.ttlSeconds ?? 60),
                allowed: body.allowed.map(String),
                allowedOperations: body.allowedOperations.map(String),
                denied: Array.isArray(body.denied) ? body.denied : [],
            };
            // policyRevision only moves forward on the auth core. A lower value is a
            // stale or replayed response; adopting it could re-grant a revoked
            // operation. Keep the newer table and restart its freshness window.
            const previous = this.routesCache;
            if (previous && data.policyRevision < previous.data.policyRevision) {
                this.routesCache = { data: previous.data, at: this.now() };
                return previous.data;
            }
            this.routesCache = { data, at: this.now() };
            return data;
        }
        catch (err) {
            if (err instanceof FeishuAuthError && (err.code === "mmw_auth_required" || err.code === "mmw_session_expired")) {
                await this.clearIfTokenCurrent(record);
            }
            throw err;
        }
    }
}
