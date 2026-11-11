/**
 * Broker write client for the MCP child.
 *
 * The child never receives a writable GitHub installation token. When the
 * host wrote a write-auth file, every mutating tool is forwarded to the
 * broker, which verifies the member's Feishu operation (or GitHub allow-list
 * entry), mints a short-lived write token for itself, and returns only the
 * result. Without that file the tools keep their legacy direct-git path so
 * stand-alone use and the existing tests still work.
 */
import { readFileSync } from "node:fs";

import { GithubRefusedError } from "./guard.js";

export interface BrokerWriteConfig {
  brokerUrl: string;
  writeAuthFile: string;
}

export interface BrokerWriteCredential {
  kind: "feishu" | "github";
  token: string;
}

/** Read the identity credential the host refreshed for this child. */
export function readWriteCredential(file = process.env.MMW_WRITE_AUTH_FILE ?? ""): BrokerWriteCredential | null {
  if (!file) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      kind?: unknown;
      token?: unknown;
    };
    if (
      (raw.kind === "feishu" || raw.kind === "github") &&
      typeof raw.token === "string" &&
      raw.token.length > 0
    ) {
      return { kind: raw.kind, token: raw.token };
    }
  } catch {
    /* missing or partially written: treat as unavailable */
  }
  return null;
}

export function brokerWriteEnabled(cfg: BrokerWriteConfig): boolean {
  return Boolean(cfg.brokerUrl && readWriteCredential(cfg.writeAuthFile));
}

export interface BrokerWriteOptions {
  /** Extra time for merge polling; the broker may wait for GitHub to settle. */
  timeoutMs?: number;
}

/** POST one operation to the broker and surface its error code verbatim. */
export async function brokerWrite<T>(
  cfg: BrokerWriteConfig,
  pathname: string,
  body: Record<string, unknown>,
  opts: BrokerWriteOptions = {}
): Promise<T> {
  const credential = readWriteCredential(cfg.writeAuthFile);
  if (!cfg.brokerUrl || !credential) {
    throw new GithubRefusedError(
      "broker-write-unavailable",
      "写操作需要 broker 代理凭据；请先完成飞书或 GitHub 登录。"
    );
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (credential.kind === "feishu") headers["x-mmw-feishu-token"] = credential.token;
  else headers.authorization = `Bearer ${credential.token}`;

  let response: Response;
  try {
    response = await fetch(new URL(pathname, cfg.brokerUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (err) {
    throw new GithubRefusedError(
      "broker-unreachable",
      `无法连接 broker ${cfg.brokerUrl}: ${(err as Error).message ?? String(err)}`
    );
  }

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new GithubRefusedError(
      "broker-bad-response",
      `broker 返回了非 JSON 响应（HTTP ${response.status}）`
    );
  }

  if (!response.ok) {
    const code = typeof parsed.error === "string" ? parsed.error : "broker-write-failed";
    const message =
      typeof parsed.message === "string" ? parsed.message : `broker 拒绝了写操作（HTTP ${response.status}）`;
    throw new GithubRefusedError(code, message);
  }

  return parsed as T;
}
