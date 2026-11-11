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
/** Read the identity credential the host refreshed for this child. */
export function readWriteCredential(file = process.env.MMW_WRITE_AUTH_FILE ?? "") {
    if (!file)
        return null;
    try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        if ((raw.kind === "feishu" || raw.kind === "github") &&
            typeof raw.token === "string" &&
            raw.token.length > 0) {
            return { kind: raw.kind, token: raw.token };
        }
    }
    catch {
        /* missing or partially written: treat as unavailable */
    }
    return null;
}
export function brokerWriteEnabled(cfg) {
    return Boolean(cfg.brokerUrl && readWriteCredential(cfg.writeAuthFile));
}
/** POST one operation to the broker and surface its error code verbatim. */
export async function brokerWrite(cfg, pathname, body, opts = {}) {
    const credential = readWriteCredential(cfg.writeAuthFile);
    if (!cfg.brokerUrl || !credential) {
        throw new GithubRefusedError("broker-write-unavailable", "写操作需要 broker 代理凭据；请先完成飞书或 GitHub 登录。");
    }
    const headers = { "content-type": "application/json" };
    if (credential.kind === "feishu")
        headers["x-mmw-feishu-token"] = credential.token;
    else
        headers.authorization = `Bearer ${credential.token}`;
    let response;
    try {
        response = await fetch(new URL(pathname, cfg.brokerUrl), {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
        });
    }
    catch (err) {
        throw new GithubRefusedError("broker-unreachable", `无法连接 broker ${cfg.brokerUrl}: ${err.message ?? String(err)}`);
    }
    const text = await response.text();
    let parsed = {};
    try {
        parsed = text ? JSON.parse(text) : {};
    }
    catch {
        throw new GithubRefusedError("broker-bad-response", `broker 返回了非 JSON 响应（HTTP ${response.status}）`);
    }
    if (!response.ok) {
        const code = typeof parsed.error === "string" ? parsed.error : "broker-write-failed";
        const message = typeof parsed.message === "string" ? parsed.message : `broker 拒绝了写操作（HTTP ${response.status}）`;
        throw new GithubRefusedError(code, message);
    }
    return parsed;
}
