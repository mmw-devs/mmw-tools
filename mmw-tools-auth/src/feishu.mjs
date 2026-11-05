const AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
const MAX_RESPONSE_BYTES = 128 * 1024;

export class FeishuError extends Error {
  constructor(kind, message, status = 502) {
    super(message);
    this.name = "FeishuError";
    this.kind = kind;
    this.status = status;
  }
}

async function readLimited(response, max = MAX_RESPONSE_BYTES) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > max) {
    throw new FeishuError("invalid", "飞书响应过大");
  }
  return text;
}

function parseJson(text, kind) {
  try {
    return JSON.parse(text);
  } catch {
    throw new FeishuError(kind, "飞书返回了无效响应");
  }
}

export function authorizeUrl({ config, state, codeChallenge }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", `${config.origin}/auth/feishu/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (config.scopes) url.searchParams.set("scope", config.scopes);
  return url.toString();
}

export async function exchangeCode({ config, code, codeVerifier }) {
  let response;
  try {
    response = await config.fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: config.appId,
        client_secret: config.appSecret,
        code,
        redirect_uri: `${config.origin}/auth/feishu/callback`,
        code_verifier: codeVerifier,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new FeishuError("network", "飞书授权服务暂不可用，请稍后重试", 503);
  }

  const text = await readLimited(response);
  const body = parseJson(text, "authorization");
  if (!response.ok || (body.code != null && body.code !== 0) || typeof body.access_token !== "string") {
    throw new FeishuError("authorization", "飞书授权失败，请重新登录", 401);
  }
  if (!(body.expires_in > 0)) {
    throw new FeishuError("authorization", "飞书授权有效期无效", 401);
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    expiresIn: body.expires_in,
    scope: typeof body.scope === "string" ? body.scope : "",
  };
}

export async function fetchUserInfo({ config, accessToken }) {
  let response;
  try {
    response = await config.fetcher(USER_INFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new FeishuError("network", "无法获取飞书身份，请重试", 503);
  }

  const text = await readLimited(response);
  const body = parseJson(text, "authorization");
  const user = body?.data;
  if (!response.ok || body.code !== 0 || !user || typeof user.open_id !== "string") {
    throw new FeishuError("authorization", "无法获取飞书身份，请重新登录", 401);
  }
  return {
    tenantKey: String(user.tenant_key ?? ""),
    openId: user.open_id,
    name: typeof user.name === "string" && user.name.length > 0 ? user.name : "飞书成员",
    avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : undefined,
  };
}
