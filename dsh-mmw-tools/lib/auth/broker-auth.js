/**
 * BrokerAuth — the single auth implementation, replacing `device-flow.ts`
 * and `token-store.ts`.
 *
 * It exposes the same method surface the routes and the status tool were
 * already written against (`begin` / `poll` / `refresh` / `clearAll` /
 * `status` / `view`), so exactly one code path performs authentication
 * and nothing else needs re-plumbing.
 *
 * Field-name caveat, recorded on purpose: `view()` still returns
 * `accessTokenMasked` / `accessTokenExpiresAt` because that is what the
 * status output schema and the panel read. Under the broker those fields
 * describe the *session* token, which cannot write to a repository. The
 * rename is cosmetic and deferred so this change stays one implementation
 * swap rather than a schema migration.
 *
 * The MCP child needs a real GitHub credential for clone/push/PR. It reads
 * `accessToken` from `GHOST_TOKEN_FILE` on every call, so this class keeps
 * a one-hour installation token in that file, mode 0600, and refreshes it
 * from the watchdog. That is a deliberate trade-off: the alternative is
 * spawning the child with the token in its environment, which would need
 * a bridge restart on every login and every hourly refresh. Documented in
 * docs/AUTH-BROKER.md; the follow-up is for the child to ask the broker
 * itself.
 */
import { mkdir, writeFile, chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { BrokerClient, BrokerError } from "./broker-client.js";
import { SessionStore, maskToken } from "./session-store.js";
/** Refresh the installation token this long before GitHub expires it. */
const INSTALLATION_MARGIN_MS = 10 * 60 * 1000;
export class BrokerAuth {
    store;
    broker;
    now;
    tokenFile;
    writeAuthFile;
    repository;
    feishu;
    pending = null;
    installation = null;
    constructor(opts) {
        this.store = opts.store ?? new SessionStore();
        this.broker =
            opts.broker ??
                new BrokerClient({ brokerUrl: opts.brokerUrl });
        this.now = opts.now ?? (() => Date.now());
        this.tokenFile = opts.installationTokenFile;
        this.writeAuthFile = (opts.writeAuthFile ?? "").trim();
        this.repository = (opts.repository ?? "").trim();
        this.feishu = opts.feishu ?? null;
    }
    /**
     * The broker and the plugin each know "which repository"; refuse to write a
     * token file when they disagree. Without this the mismatch surfaced much
     * later as a 403 from GitHub, after the agent had already spent a turn.
     */
    assertRepository(issued) {
        if (!this.repository || !issued.repository)
            return; // older broker: nothing to compare
        if (issued.repository === this.repository)
            return;
        throw new BrokerError("repo-mismatch", `broker signed a token for ${issued.repository}, but this plugin is bound to ${this.repository}`);
    }
    /** Nothing to load at boot; kept for the effect that calls it. */
    async hydrate() {
        await this.store.read();
    }
    status() {
        if (this.pending)
            return "device_pending";
        return "no_token";
    }
    /** Status against the store, which is the source of truth. */
    async resolvedStatus() {
        if (this.pending)
            return "device_pending";
        const session = await this.store.read();
        if (session && session.expiresAt > this.now())
            return "authorized";
        // A Feishu login without a GitHub account is a supported state.
        if (this.feishu && (await this.feishu.credential()))
            return "authorized";
        return session ? "reauth_needed" : "no_token";
    }
    /** The four states of docs/PANEL-CONTRACT.md §3, and nothing else. */
    async phase() {
        if (this.pending)
            return "authorizing";
        const session = await this.store.read();
        if (session && session.expiresAt > this.now())
            return "signed_in";
        if (this.feishu && (await this.feishu.credential()))
            return "signed_in";
        return session ? "expired" : "signed_out";
    }
    /**
     * Whether a repository credential is available right now.
     *
     * Deliberately separate from the session: the session can be valid while
     * the installation token is missing or the broker refuses to mint one,
     * and the user needs to see those as different things.
     */
    async repoAccess() {
        try {
            const token = await this.ensureInstallationToken(false);
            return token
                ? { state: "ready", reason: "" }
                : { state: "unavailable", reason: "尚未登录（飞书或 GitHub）" };
        }
        catch (err) {
            return {
                state: "unavailable",
                reason: err instanceof Error ? err.message : String(err),
            };
        }
    }
    async view() {
        // If the last mint came from Feishu, report that identity. This is the
        // only place the panel and mmw_tools_status learn about a Feishu-only
        // login, since there is no GitHub session record for it.
        if (this.installation?.authMode === "feishu") {
            return this.feishuView(this.installation);
        }
        const session = await this.store.read();
        if (session) {
            return {
                configured: true,
                mode: "github",
                login: session.login,
                scope: "broker",
                accessTokenMasked: maskToken(session.sessionToken),
                accessTokenExpiresAt: session.expiresAt,
                refreshTokenExpiresAt: 0,
                tokenUpdatedAt: session.updatedAt
                    ? new Date(session.updatedAt).toISOString()
                    : "",
                configPath: this.store.path,
            };
        }
        if (this.feishu && (await this.feishu.credential())) {
            return this.feishuView(null);
        }
        return {
            configured: false,
            mode: "none",
            login: "",
            scope: "",
            accessTokenMasked: "",
            accessTokenExpiresAt: 0,
            refreshTokenExpiresAt: 0,
            tokenUpdatedAt: "",
            configPath: this.store.path,
        };
    }
    /** What the panel shows for a member who signed in with Feishu only. */
    feishuView(issued) {
        return {
            configured: true,
            mode: "feishu",
            login: issued?.login ?? "",
            scope: "broker",
            accessTokenMasked: issued ? maskToken(issued.token) : "",
            accessTokenExpiresAt: issued?.expiresAt ?? 0,
            refreshTokenExpiresAt: 0,
            tokenUpdatedAt: issued ? new Date(this.now()).toISOString() : "",
            configPath: this.store.path,
        };
    }
    /** Step 1: obtain a browser URL from the broker. */
    async begin() {
        const started = await this.broker.startSession();
        this.pending = {
            state: started.state,
            pollSecret: started.pollSecret,
            loginUrl: started.loginUrl,
            expiresAt: started.expiresAt,
        };
        return {
            userCode: "",
            verificationUri: started.loginUrl,
            expiresAt: started.expiresAt,
            interval: 5,
        };
    }
    /** Step 2: ask the broker once whether the browser finished. */
    async poll() {
        if (!this.pending) {
            return { ok: false, message: "没有进行中的登录，请先调用 engineer_oauth_start。" };
        }
        if (this.pending.expiresAt <= this.now()) {
            this.pending = null;
            return { ok: false, message: "登录已超时，请重新发起。" };
        }
        const polled = await this.broker.pollSession(this.pending.state, this.pending.pollSecret);
        if (polled.status === "pending") {
            return { ok: false, message: "等待浏览器完成授权…" };
        }
        if (polled.status === "expired") {
            this.pending = null;
            return { ok: false, message: "登录状态已过期，请重新发起。" };
        }
        if (polled.status === "denied") {
            this.pending = null;
            return { ok: false, message: `BROKER_REFUSED: ${polled.reason}` };
        }
        // authorized
        await this.store.save({
            sessionToken: polled.sessionToken,
            login: polled.login,
            expiresAt: polled.expiresAt,
            brokerUrl: "",
            updatedAt: this.now(),
        });
        this.pending = null;
        // Warm the installation token immediately, so the first tool call does
        // not pay the round trip and the child has a credential in place.
        await this.ensureInstallationToken(true).catch(() => null);
        return {
            ok: true,
            message: "登录完成，会话已保存。",
            tokens: {
                login: polled.login,
                scope: "broker",
                accessToken: maskToken(polled.sessionToken),
            },
        };
    }
    /**
     * Mint or reuse an installation token and write it where the MCP child
     * reads it. `force` bypasses the cache.
     *
     * Feishu is preferred when configured: the broker verifies the plugin
     * token and scopes the result to the member's operations, so no GitHub
     * account is needed. A valid GitHub session remains the fallback, which
     * keeps the organization/allow-list path working unchanged.
     */
    async ensureInstallationToken(force = false) {
        const cached = this.installation;
        if (!force &&
            cached &&
            cached.expiresAt - INSTALLATION_MARGIN_MS > this.now()) {
            if (this.writeAuthFile) {
                // A re-login rotates the Feishu plugin token without changing the
                // cached read token. Refresh the broker credential on the cache path
                // too, otherwise MCP keeps presenting the token from before the login.
                const session = await this.store.readValid(this.now());
                const feishuToken = this.feishu ? await this.feishu.credential() : null;
                await this.writeWriteAuth(cached, session, feishuToken);
            }
            return cached.token;
        }
        const session = await this.store.readValid(this.now());
        const feishuToken = this.feishu ? await this.feishu.credential() : null;
        if (!session && !feishuToken) {
            this.installation = null;
            await this.removeTokenFile();
            await this.removeWriteAuth();
            return null;
        }
        const issued = await this.mintInstallationToken(session, feishuToken);
        this.assertRepository(issued);
        this.installation = issued;
        await this.writeTokenFile(issued);
        await this.writeWriteAuth(issued, session, feishuToken);
        return issued.token;
    }
    /**
     * The repository's own rule file, read through the broker. Only the Feishu
     * plugin token is presented: the broker mints the installation token and
     * never hands it to this call.
     */
    async repoPolicy() {
        const credential = this.feishu ? await this.feishu.credential() : null;
        if (!credential) {
            throw new BrokerError("session-required", "no Feishu credential; sign in first");
        }
        if (!this.repository) {
            throw new BrokerError("repo-mismatch", "this plugin has no repository binding");
        }
        return this.broker.getRepoPolicy(credential, this.repository);
    }
    /**
     * One place that decides which credential to present. Keeping the fallback
     * here (rather than in each caller) is what makes "Feishu first, GitHub
     * second" true for the watchdog, the panel and the first tool call alike.
     */
    async mintInstallationToken(session, feishuToken) {
        if (feishuToken) {
            try {
                return await this.broker.getInstallationTokenForFeishu(feishuToken, this.repository);
            }
            catch (err) {
                // A stale Feishu token must not strand an otherwise valid GitHub
                // session; fall through. With no session the Feishu error is the
                // useful one, so rethrow it.
                if (!session)
                    throw err;
            }
        }
        if (session)
            return this.broker.getInstallationToken(session.sessionToken, this.repository);
        throw new BrokerError("session-required", "no Feishu or GitHub credential; sign in first");
    }
    /** Watchdog hook: keep the child's credential fresh. */
    async ensureFresh() {
        const before = this.installation?.token ?? null;
        try {
            const token = await this.ensureInstallationToken(false);
            return token !== null && token !== before;
        }
        catch (err) {
            if (err instanceof BrokerError && err.code === "session-rejected") {
                // Only the GitHub path owns the session record. With Feishu
                // configured, a rejected token may be a stale Feishu credential
                // with a valid session behind it; clearing would be wrong.
                const feishuAvailable = this.feishu
                    ? Boolean(await this.feishu.credential())
                    : false;
                if (!feishuAvailable) {
                    await this.store.clear();
                    this.installation = null;
                    await this.removeTokenFile();
                    await this.removeWriteAuth();
                }
                return false;
            }
            throw err;
        }
    }
    /** Panel "Refresh": force a new installation token. */
    async refresh() {
        try {
            const token = await this.ensureInstallationToken(true);
            if (!token) {
                return { ok: false, message: "尚未登录，请先完成飞书或 GitHub 登录。" };
            }
            const expiresAt = this.installation?.expiresAt ?? 0;
            return {
                ok: true,
                message: `已获取仓库令牌，有效期至 ${new Date(expiresAt).toISOString()}。`,
            };
        }
        catch (err) {
            return { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
    }
    /** Sign out: revoke server-side, then clear everything local. */
    async clearAll() {
        const session = await this.store.read();
        this.pending = null;
        this.installation = null;
        await this.removeTokenFile();
        await this.removeWriteAuth();
        await this.store.clear();
        if (session) {
            try {
                await this.broker.revoke(session.sessionToken);
            }
            catch {
                // Local state is already gone; a failed revoke must not undo that.
            }
        }
    }
    async writeTokenFile(issued) {
        const payload = JSON.stringify({ accessToken: issued.token, expiresAt: issued.expiresAt, scope: "broker" }, null, 2);
        await mkdir(path.dirname(this.tokenFile), { recursive: true });
        await writeFile(this.tokenFile, payload, { mode: 0o600 });
        try {
            await chmod(this.tokenFile, 0o600);
        }
        catch {
            /* Windows / FAT */
        }
    }
    /**
     * A broker-proxied write presents the credential that proved *who* the
     * caller is, not a repository token. The broker mints the write token
     * itself, so this file never grants repository access on its own.
     */
    async writeWriteAuth(issued, session, feishuToken) {
        if (!this.writeAuthFile)
            return;
        let kind;
        let token;
        if (feishuToken) {
            kind = "feishu";
            token = feishuToken;
        }
        else if (session?.sessionToken) {
            kind = "github";
            token = session.sessionToken;
        }
        else {
            await this.removeWriteAuth();
            return;
        }
        const payload = JSON.stringify({ kind, token, expiresAt: issued.expiresAt }, null, 2);
        await mkdir(path.dirname(this.writeAuthFile), { recursive: true });
        await writeFile(this.writeAuthFile, payload, { mode: 0o600 });
        try {
            await chmod(this.writeAuthFile, 0o600);
        }
        catch {
            /* Windows / FAT */
        }
    }
    async removeWriteAuth() {
        if (!this.writeAuthFile || !existsSync(this.writeAuthFile))
            return;
        try {
            await unlink(this.writeAuthFile);
        }
        catch {
            /* best effort */
        }
    }
    async removeTokenFile() {
        if (!existsSync(this.tokenFile))
            return;
        try {
            await unlink(this.tokenFile);
        }
        catch {
            /* best effort */
        }
    }
}
/** Default location the MCP child is told to read. */
export function installationTokenPath() {
    return path.join(homedir(), ".dsh", "dsh-mmw-tools-installation.json");
}
/** Where the child reads the identity credential for broker-proxied writes. */
export function writeAuthPath() {
    return path.join(homedir(), ".dsh", "dsh-mmw-tools-write-auth.json");
}
