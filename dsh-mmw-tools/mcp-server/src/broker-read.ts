/**
 * Broker read client for the MCP child.
 *
 * When the host has a Feishu credential, clone/pull/base-SHA/PR list and
 * preview no longer touch github.com or the `gh` CLI. The broker performs
 * them with its GitHub App identity and returns data or a git bundle.
 */
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { GithubRefusedError } from "./guard.js";
import { readWriteCredential, type BrokerWriteConfig } from "./broker-write.js";

export type BrokerReadConfig = BrokerWriteConfig;

export function brokerReadEnabled(cfg: BrokerReadConfig): boolean {
  return Boolean(cfg.brokerUrl && readWriteCredential(cfg.writeAuthFile));
}

function authHeaders(cfg: BrokerReadConfig): Record<string, string> {
  const credential = readWriteCredential(cfg.writeAuthFile);
  if (!cfg.brokerUrl || !credential) {
    throw new GithubRefusedError(
      "broker-read-unavailable",
      "读操作需要 broker 代理凭据；请先完成飞书登录。"
    );
  }
  return credential.kind === "feishu"
    ? { "x-mmw-feishu-token": credential.token }
    : { authorization: `Bearer ${credential.token}` };
}

function urlFor(cfg: BrokerReadConfig, pathname: string, query: Record<string, string | undefined>): URL {
  const url = new URL(pathname, cfg.brokerUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url;
}

async function readError(response: Response): Promise<never> {
  const text = await response.text().catch(() => "");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* use the generic message */
  }
  const code = typeof parsed.error === "string" ? parsed.error : "broker-read-failed";
  const message =
    typeof parsed.message === "string"
      ? parsed.message
      : `broker 拒绝了读操作（HTTP ${response.status}）`;
  throw new GithubRefusedError(code, message);
}

export async function brokerRead<T>(
  cfg: BrokerReadConfig,
  pathname: string,
  query: Record<string, string | undefined> = {},
  timeoutMs = 60_000
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(urlFor(cfg, pathname, query), {
      method: "GET",
      headers: authHeaders(cfg),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new GithubRefusedError(
      "broker-unreachable",
      `无法连接 broker ${cfg.brokerUrl}: ${(err as Error).message ?? String(err)}`
    );
  }
  if (!response.ok) await readError(response);
  return (await response.json()) as T;
}

/**
 * Stream a bundle to `destination`. A bundle is binary, so this cannot use
 * the JSON helper above. Returns the commit SHA from the response header.
 */
export async function brokerReadBundle(
  cfg: BrokerReadConfig,
  pathname: string,
  query: Record<string, string | undefined>,
  destination: string,
  timeoutMs = 120_000
): Promise<{ sha: string; repository: string }> {
  let response: Response;
  try {
    response = await fetch(urlFor(cfg, pathname, query), {
      method: "GET",
      headers: authHeaders(cfg),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new GithubRefusedError(
      "broker-unreachable",
      `无法连接 broker ${cfg.brokerUrl}: ${(err as Error).message ?? String(err)}`
    );
  }
  if (!response.ok || !response.body) await readError(response);
  const out = createWriteStream(destination, { mode: 0o600 });
  try {
    await pipeline(Readable.fromWeb(response.body as never), out);
  } catch (err) {
    throw new GithubRefusedError(
      "broker-bundle-failed",
      `下载仓库快照失败：${(err as Error).message ?? String(err)}`
    );
  }
  return {
    sha: response.headers.get("x-commit-sha") ?? "",
    repository: response.headers.get("x-repository") ?? "",
  };
}
