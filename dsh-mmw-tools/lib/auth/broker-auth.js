/**
 * BrokerAuth — Feishu credential management for broker-minted repository
 * tokens.
 *
 * A Feishu plugin token proves who the member is and which operations their
 * role allows. The broker verifies it, mints the GitHub App installation
 * token, and returns only a read-only repository token. There is deliberately
 * no user-facing GitHub login: the bot identity is the broker's App, and a
 * human break-glass uses `gh` outside this plugin.
 *
 * The MCP child needs a real read-only GitHub credential for clone/read. It
 * reads `accessToken` from `GHOST_TOKEN_FILE` on every call, so this class
 * keeps a one-hour installation token in that file, mode 0600, and refreshes
 * it from the watchdog. Write operations do not use that token: the child
 * presents a Feishu credential to the broker, which mints and keeps the write
 * token itself.
 */
import { mkdir, writeFile, chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { BrokerClient, BrokerError } from "./broker-client.js";
import { maskToken } from "./session-store.js";
/** Refresh the installation token this long before GitHub expires it. */
const INSTALLATION_MARGIN_MS = 10 * 60 * 1000;
export class BrokerAuth {
    broker;
    now;
    tokenFile;
    writeAuthFile;
    repository;
    feishu;
    installation = null;
    constructor(opts) {
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
    async hydrate() { }
    /** Status against the live Feishu credential. */
    async resolvedStatus() {
        return (await this.feishuCredential()) ? "authorized" : "no_token";
    }
    /** The two states the panel renders: signed in with Feishu, or not. */
    async phase() {
        return (await this.feishuCredential()) ? "signed_in" : "signed_out";
    }
    /**
     * Whether a repository credential is available right now.
     *
     * Deliberately separate from the login: the Feishu token can be valid while
     * the broker refuses to mint, and the user needs to see those as different.
     */
    async repoAccess() {
        try {
            const token = await this.ensureInstallationToken(false);
            return token
                ? { state: "ready", reason: "" }
                : { state: "unavailable", reason: "尚未登录飞书" };
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
        // only place the panel and mmw_tools_status learn about the login, since
        // there is no session record.
        if (this.installation?.authMode === "feishu") {
            return this.feishuView(this.installation);
        }
        if (await this.feishuCredential()) {
            return this.feishuView(null);
        }
        return {
            configured: false,
            mode: "none",
            login: "",
            scope: "",
            accessTokenMasked: "",
            accessTokenExpiresAt: 0,
            tokenUpdatedAt: "",
        };
    }
    /** What the panel shows for a member who signed in with Feishu. */
    feishuView(issued) {
        return {
            configured: true,
            mode: "feishu",
            login: issued?.login ?? "",
            scope: "broker",
            accessTokenMasked: issued ? maskToken(issued.token) : "",
            accessTokenExpiresAt: issued?.expiresAt ?? 0,
            tokenUpdatedAt: issued ? new Date(this.now()).toISOString() : "",
        };
    }
    /**
     * Mint or reuse an installation token and write it where the MCP child
     * reads it. `force` bypasses the cache.
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
                const feishuToken = await this.feishuCredential();
                await this.writeWriteAuth(cached, feishuToken);
            }
            return cached.token;
        }
        const feishuToken = await this.feishuCredential();
        if (!feishuToken) {
            this.installation = null;
            await this.removeTokenFile();
            await this.removeWriteAuth();
            return null;
        }
        let issued;
        try {
            issued = await this.mintInstallationToken(feishuToken);
        }
        catch (err) {
            if (err instanceof BrokerError && err.code === "session-rejected") {
                this.installation = null;
                await this.removeTokenFile();
                await this.removeWriteAuth();
                return null;
            }
            throw err;
        }
        this.assertRepository(issued);
        this.installation = issued;
        await this.writeTokenFile(issued);
        await this.writeWriteAuth(issued, feishuToken);
        return issued.token;
    }
    /**
     * The repository's own rule file, read through the broker. Only the Feishu
     * plugin token is presented: the broker mints the installation token and
     * never hands it to this call.
     */
    async repoPolicy() {
        const credential = await this.feishuCredential();
        if (!credential) {
            throw new BrokerError("session-required", "no Feishu credential; sign in first");
        }
        if (!this.repository) {
            throw new BrokerError("repo-mismatch", "this plugin has no repository binding");
        }
        return this.broker.getRepoPolicy(credential, this.repository);
    }
    async feishuCredential() {
        return this.feishu ? this.feishu.credential() : null;
    }
    async mintInstallationToken(feishuToken) {
        return this.broker.getInstallationTokenForFeishu(feishuToken, this.repository);
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
                this.installation = null;
                await this.removeTokenFile();
                await this.removeWriteAuth();
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
                return { ok: false, message: "尚未登录，请先完成飞书登录。" };
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
    /** Clear everything local. Feishu logout is handled by the Feishu route. */
    async clearAll() {
        this.installation = null;
        await this.removeTokenFile();
        await this.removeWriteAuth();
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
    async writeWriteAuth(_issued, feishuToken) {
        if (!this.writeAuthFile)
            return;
        if (!feishuToken) {
            await this.removeWriteAuth();
            return;
        }
        const payload = JSON.stringify({ kind: "feishu", token: feishuToken, expiresAt: 0 }, null, 2);
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
