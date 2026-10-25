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
import type { InstallationTokenResult } from "./broker-client.js";

/** Same union the status schema and the panel already render. */
export type AuthStatus = "no_token" | "device_pending" | "authorized" | "reauth_needed";

/**
 * Discriminated so `ok: true` guarantees `tokens`. The previous shape had
 * `tokens` optional, which forced every caller to guard a field that was
 * always present on success.
 */
export type FlowResult =
  | {
      ok: true;
      message: string;
      tokens: { login: string; scope: string; accessToken: string };
    }
  | { ok: false; message: string };

export interface StartedSignIn {
  /** Broker flows have no user code; the panel shows the URL instead. */
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
}

export interface AuthView {
  configured: boolean;
  login: string;
  scope: string;
  accessTokenMasked: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  tokenUpdatedAt: string;
  /** Where the session record lives; shown by the panel. */
  configPath: string;
}

export interface BrokerAuthOptions {
  brokerUrl: string;
  /** Where the child reads `accessToken` from. */
  installationTokenFile: string;
  store?: SessionStore;
  broker?: BrokerClient;
  now?: () => number;
}

interface Pending {
  state: string;
  pollSecret: string;
  loginUrl: string;
  expiresAt: number;
}

/** Refresh the installation token this long before GitHub expires it. */
const INSTALLATION_MARGIN_MS = 10 * 60 * 1000;

/** Result of an operation that carries no credentials (refresh). */
export interface OpResult {
  ok: boolean;
  message: string;
}

export class BrokerAuth {
  private readonly store: SessionStore;
  private readonly broker: BrokerClient;
  private readonly now: () => number;
  private readonly tokenFile: string;

  private pending: Pending | null = null;
  private installation: InstallationTokenResult | null = null;

  constructor(opts: BrokerAuthOptions) {
    this.store = opts.store ?? new SessionStore();
    this.broker =
      opts.broker ??
      new BrokerClient({ brokerUrl: opts.brokerUrl });
    this.now = opts.now ?? (() => Date.now());
    this.tokenFile = opts.installationTokenFile;
  }

  /** Nothing to load at boot; kept for the effect that calls it. */
  async hydrate(): Promise<void> {
    await this.store.read();
  }

  status(): AuthStatus {
    if (this.pending) return "device_pending";
    return "no_token";
  }

  /** Status against the store, which is the source of truth. */
  async resolvedStatus(): Promise<AuthStatus> {
    if (this.pending) return "device_pending";
    const session = await this.store.read();
    if (!session) return "no_token";
    return session.expiresAt > this.now() ? "authorized" : "reauth_needed";
  }

  async view(): Promise<AuthView> {
    const session = await this.store.read();
    if (!session) {
      return {
        configured: false,
        login: "",
        scope: "",
        accessTokenMasked: "",
        accessTokenExpiresAt: 0,
        refreshTokenExpiresAt: 0,
        tokenUpdatedAt: "",
        configPath: this.store.path,
      };
    }
    return {
      configured: true,
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

  /** Step 1: obtain a browser URL from the broker. */
  async begin(): Promise<StartedSignIn> {
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
  async poll(): Promise<FlowResult> {
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
   */
  async ensureInstallationToken(force = false): Promise<string | null> {
    const cached = this.installation;
    if (
      !force &&
      cached &&
      cached.expiresAt - INSTALLATION_MARGIN_MS > this.now()
    ) {
      return cached.token;
    }

    const session = await this.store.readValid(this.now());
    if (!session) {
      this.installation = null;
      await this.removeTokenFile();
      return null;
    }

    const issued = await this.broker.getInstallationToken(session.sessionToken);
    this.installation = issued;
    await this.writeTokenFile(issued);
    return issued.token;
  }

  /** Watchdog hook: keep the child's credential fresh. */
  async ensureFresh(): Promise<boolean> {
    const before = this.installation?.token ?? null;
    try {
      const token = await this.ensureInstallationToken(false);
      return token !== null && token !== before;
    } catch (err) {
      if (err instanceof BrokerError && err.code === "session-rejected") {
        // The broker no longer accepts this session; drop it locally too.
        await this.store.clear();
        this.installation = null;
        await this.removeTokenFile();
        return false;
      }
      throw err;
    }
  }

  /** Panel "Refresh": force a new installation token. */
  async refresh(): Promise<OpResult> {
    const session = await this.store.readValid(this.now());
    if (!session) {
      return { ok: false, message: "尚未登录，请先完成浏览器授权。" };
    }
    try {
      const issued = await this.broker.getInstallationToken(session.sessionToken);
      this.installation = issued;
      await this.writeTokenFile(issued);
      return {
        ok: true,
        message: `已获取仓库令牌，有效期至 ${new Date(issued.expiresAt).toISOString()}。`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Sign out: revoke server-side, then clear everything local. */
  async clearAll(): Promise<void> {
    const session = await this.store.read();
    this.pending = null;
    this.installation = null;
    await this.removeTokenFile();
    await this.store.clear();
    if (session) {
      try {
        await this.broker.revoke(session.sessionToken);
      } catch {
        // Local state is already gone; a failed revoke must not undo that.
      }
    }
  }

  private async writeTokenFile(issued: InstallationTokenResult): Promise<void> {
    const payload = JSON.stringify(
      { accessToken: issued.token, expiresAt: issued.expiresAt, scope: "broker" },
      null,
      2
    );
    await mkdir(path.dirname(this.tokenFile), { recursive: true });
    await writeFile(this.tokenFile, payload, { mode: 0o600 });
    try {
      await chmod(this.tokenFile, 0o600);
    } catch {
      /* Windows / FAT */
    }
  }

  private async removeTokenFile(): Promise<void> {
    if (!existsSync(this.tokenFile)) return;
    try {
      await unlink(this.tokenFile);
    } catch {
      /* best effort */
    }
  }
}

/** Default location the MCP child is told to read. */
export function installationTokenPath(): string {
  return path.join(homedir(), ".dsh", "dsh-github-engineer-installation.json");
}
