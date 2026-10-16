/**
 * dsh-github-engineer — loopback HTTP routes.
 *
 * Exposes the OAuth Device Flow lifecycle to the DSH web UI:
 *
 *   GET  /api/github-engineer/status       — public, secret-free state
 *   POST /api/github-engineer/oauth/start  — request a device_code
 *   POST /api/github-engineer/oauth/finish — exchange the code manually
 *   POST /api/github-engineer/oauth/refresh — refresh the access_token
 *   POST /api/github-engineer/revoke       — wipe credentials
 *
 * Every route enforces loopback-only access (the same way
 * dsh-feishu-mcp does): only 127.0.0.1 / ::1, host header must be
 * loopback, sec-fetch-site=cross-site is rejected.
 *
 * In v1 there is NO browser-redirect callback route — Device Flow
 * doesn't need one. The user copies the user_code into their browser
 * themselves, then we either poll in the background or let the user
 * paste the callback URL into a "finish" form.
 */
import type { TokenStore } from "./auth/token-store.js";
import type { DeviceFlow, FlowResult } from "./auth/device-flow.js";

/** Route paths — all prefixed with /api/github-engineer/. */
export const API = {
  status: "/api/github-engineer/status",
  oauthStart: "/api/github-engineer/oauth/start",
  oauthFinish: "/api/github-engineer/oauth/finish",
  oauthRefresh: "/api/github-engineer/oauth/refresh",
  revoke: "/api/github-engineer/revoke",
} as const;

/** Max JSON body size: 256 KiB. */
const MAX_JSON_BODY_BYTES = 256 * 1024;

/** Minimal Node `IncomingMessage` + `ServerResponse` types we touch. */
interface IncomingMessageLike {
  socket: { remoteAddress?: string | null };
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
}
interface ServerResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function getHeader(req: IncomingMessageLike, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

/** Reject any non-loopback request. */
export function isLoopbackRequest(req: IncomingMessageLike): boolean {
  const address = req.socket.remoteAddress;
  if (
    address !== "127.0.0.1" &&
    address !== "::1" &&
    address !== "::ffff:127.0.0.1"
  )
    return false;
  const host = getHeader(req, "host");
  if (typeof host !== "string") return false;
  let hostUrl: URL;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (
    hostUrl.hostname !== "127.0.0.1" &&
    hostUrl.hostname !== "localhost" &&
    hostUrl.hostname !== "[::1]"
  )
    return false;
  if (getHeader(req, "sec-fetch-site") === "cross-site") return false;
  const origin = getHeader(req, "origin");
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/** Write a JSON response. */
export function writeJson(
  res: ServerResponseLike,
  status: number,
  body: unknown
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

/** Read a JSON request body. Returns undefined when too large or unparseable. */
export async function readJsonBody(
  req: IncomingMessageLike & AsyncIterable<Buffer>
): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Loopback + method guard. Returns true on success. */
function guard(
  req: IncomingMessageLike,
  res: ServerResponseLike,
  method: string
): boolean {
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

export interface RouteDeps {
  store: TokenStore;
  flow: DeviceFlow;
}

/** Build all /api/github-engineer/* routes. */
export function makeRoutes(deps: RouteDeps): Array<{
  kind: "exact";
  path: string;
  handler: (req: IncomingMessageLike & AsyncIterable<Buffer>, res: ServerResponseLike) => Promise<void>;
}> {
  const { store, flow } = deps;
  return [
    {
      kind: "exact",
      path: API.status,
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        const view = await store.view();
        writeJson(res, 200, { ...view, status: flow.status() });
      },
    },
    {
      kind: "exact",
      path: API.oauthStart,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        try {
          const pending = await flow.begin();
          writeJson(res, 200, {
            ok: true,
            userCode: pending.userCode,
            verificationUri: pending.verificationUri,
            expiresAt: pending.expiresAt,
            interval: pending.interval,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeJson(res, 200, { ok: false, error: message });
        }
      },
    },
    {
      kind: "exact",
      path: API.oauthFinish,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        // Body is a hint, not authoritative — the device flow state machine
        // already has the device_code. We just need to ask it to poll once.
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
        if (!guard(req, res, "POST")) return;
        const result: FlowResult = await flow.refresh();
        writeJson(res, 200, { ok: result.ok, message: result.message });
      },
    },
    {
      kind: "exact",
      path: API.revoke,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        await flow.clearAll();
        const view = await store.view();
        writeJson(res, 200, { ok: true, message: "凭据已清空。", ...view });
      },
    },
  ];
}