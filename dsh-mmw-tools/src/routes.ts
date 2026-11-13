/**
 * dsh-mmw-tools — loopback HTTP routes.
 *
 * The browser surface is intentionally small: one status endpoint and the
 * Feishu login/logout endpoints. The broker owns the GitHub App identity, so
 * there is no user-facing GitHub OAuth route to expose.
 *
 * Every route enforces loopback-only access (the same way dsh-feishu-mcp
 * does): only 127.0.0.1 / ::1, host header must be loopback,
 * sec-fetch-site=cross-site is rejected.
 */
import type { BrokerAuth } from "./auth/broker-auth.js";
import type { FeishuAuth } from "./auth/feishu-auth.js";
import { API } from "./shared/api-paths.js";

// Defined in src/shared/api-paths.ts and re-exported here: the host bundle,
// the tests and the panel must agree on these strings, and the only way to
// guarantee that is to keep one copy of them.
export { API };

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
  flow: BrokerAuth;
  /** Optional so the original route tests can drive makeRoutes without it. */
  feishu?: FeishuAuth;
  brokerUrl: string;
  binding: {
    owner: string;
    name: string;
    baseBranch: string;
    allowlistPaths: string[];
  };
}

/** Build all /api/mmw-tools/* routes. */
export function makeRoutes(deps: RouteDeps): Array<{
  kind: "exact";
  path: string;
  handler: (req: IncomingMessageLike & AsyncIterable<Buffer>, res: ServerResponseLike) => Promise<void>;
}> {
  const { flow } = deps;
  const routes: Array<{
    kind: "exact";
    path: string;
    handler: (req: IncomingMessageLike & AsyncIterable<Buffer>, res: ServerResponseLike) => Promise<void>;
  }> = [
    {
      kind: "exact",
      path: API.status,
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        // Mint before reading the view: the Feishu identity arrives with the
        // installation token, so this order keeps the panel from flashing an
        // empty login next to "signed_in".
        const repoAccess = await flow.repoAccess();
        const view = await flow.view();
        const phase = await flow.phase();
        writeJson(res, 200, {
          phase,
          mode: view.mode,
          session: {
            login: view.login,
            expiresAt: view.accessTokenExpiresAt,
            secondsRemaining: Math.max(
              0,
              Math.floor((view.accessTokenExpiresAt - Date.now()) / 1000)
            ),
          },
          repoAccess,
          binding: deps.binding,
          brokerUrl: deps.brokerUrl,
        });
      },
    },
  ];

  if (deps.feishu) routes.push(...makeFeishuRoutes(deps.feishu));
  return routes;
}

function makeFeishuRoutes(feishu: FeishuAuth): Array<{
  kind: "exact";
  path: string;
  handler: (req: IncomingMessageLike & AsyncIterable<Buffer>, res: ServerResponseLike) => Promise<void>;
}> {
  return [
    {
      kind: "exact",
      path: API.feishuStatus,
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        writeJson(res, 200, await feishu.view());
      },
    },
    {
      kind: "exact",
      path: API.feishuLoginStart,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        try {
          const started = await feishu.begin();
          writeJson(res, 200, {
            ok: true,
            loginId: started.loginId,
            loginUrl: started.loginUrl,
            expiresAt: started.expiresAt,
          });
        } catch (err) {
          writeJson(res, 200, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
    {
      kind: "exact",
      path: API.feishuLoginPoll,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        try {
          const result = await feishu.poll();
          if (result.status === "authorized") {
            writeJson(res, 200, {
              ok: true,
              status: "authorized",
              member: result.member,
              roles: result.roles,
            });
            return;
          }
          writeJson(res, 200, {
            ok: false,
            status: result.status,
            reason: "reason" in result ? result.reason : undefined,
          });
        } catch (err) {
          writeJson(res, 200, {
            ok: false,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
    {
      kind: "exact",
      path: API.feishuLogout,
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        await feishu.logout();
        writeJson(res, 200, { ok: true, message: "飞书授权已清空。" });
      },
    },
  ];
}
