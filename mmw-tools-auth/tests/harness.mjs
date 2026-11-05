import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { Store } from "../src/store.mjs";
import { Policy } from "../src/policy.mjs";
import { Auth } from "../src/auth.mjs";
import { createAuthServer } from "../src/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = path.resolve(HERE, "..", "..", "contracts");

export function createFeishuMock() {
  const state = {
    user: { tenant_key: "tenant_test", open_id: "ou_alice", name: "Alice" },
    failExchange: false,
    failUserInfo: false,
  };
  const fetcher = async (url) => {
    const target = String(url);
    if (target.includes("/authen/v2/oauth/token")) {
      if (state.failExchange) {
        return new Response(JSON.stringify({ code: 19001, msg: "bad code" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ code: 0, access_token: "feishu-access-token", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (target.includes("/authen/v1/user_info")) {
      if (state.failUserInfo) {
        return new Response(JSON.stringify({ code: 19002, msg: "bad token" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: 0, data: state.user }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected Feishu URL: ${target}`);
  };
  return { state, fetcher };
}

export function createFixture({
  adminOpenId = "",
  bootstrapToken = "",
  pluginTokenTtlSeconds = 3600,
  sessionTtlSeconds = 28800,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mmw-tools-auth-"));
  const mock = createFeishuMock();
  const nowRef = { value: Date.UTC(2026, 0, 1, 0, 0, 0) };
  const config = loadConfig(
    {
      FEISHU_APP_ID: "cli_test",
      FEISHU_APP_SECRET: "secret_test",
      FEISHU_TENANT_KEY: "tenant_test",
      FEISHU_USER_SCOPES: "",
      MMW_ADMIN_OPEN_ID: adminOpenId,
      MMW_BOOTSTRAP_TOKEN: bootstrapToken,
      MMW_ORIGIN: "http://127.0.0.1:0",
      MMW_PORT: "0",
      MMW_DATA_DIR: dir,
      MMW_CONTRACTS_DIR: CONTRACTS,
      MMW_PLUGIN_TOKEN_TTL_SECONDS: String(pluginTokenTtlSeconds),
    },
    { fetcher: mock.fetcher, now: () => nowRef.value }
  );
  config.sessionTtlSeconds = sessionTtlSeconds;
  const store = new Store(path.join(dir, "auth.sqlite"));
  const policy = Policy.load(config.contractsDir);
  const auth = new Auth({ store, config, policy });
  return {
    dir,
    config,
    store,
    policy,
    auth,
    mock,
    nowRef,
    cleanup() {
      try {
        store.close();
      } catch {
        // best effort
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function startServer(fixture) {
  const server = createAuthServer({ auth: fixture.auth, config: fixture.config });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  fixture.config.origin = `http://127.0.0.1:${port}`;
  return {
    server,
    origin: fixture.config.origin,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export class CookieJar {
  constructor() {
    this.values = new Map();
  }

  update(response) {
    const raw =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : response.headers.get("set-cookie")
          ? [response.headers.get("set-cookie")]
          : [];
    for (const line of raw) {
      const [pair, ...attributes] = String(line).split(";");
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
      if (expired || value === "") this.values.delete(name);
      else this.values.set(name, value);
    }
  }

  header() {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

export async function request(jar, url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (jar?.header()) headers.cookie = jar.header();
  const response = await fetch(url, {
    ...options,
    headers,
    redirect: "manual",
  });
  jar?.update(response);
  return response;
}

export async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected JSON, got ${response.status}: ${text.slice(0, 200)}`);
  }
}

export async function loginPlugin(fixture, server, jar = new CookieJar()) {
  const startResponse = await request(jar, `${server.origin}/v1/login/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const start = await readJson(startResponse);
  if (startResponse.status !== 200) throw new Error(`login/start failed: ${startResponse.status}`);

  const browserResponse = await request(jar, start.loginUrl);
  if (browserResponse.status !== 302) {
    throw new Error(`browser start failed: ${browserResponse.status}`);
  }
  const location = browserResponse.headers.get("location");
  const state = new URL(location).searchParams.get("state");
  const callback = await request(
    jar,
    `${server.origin}/auth/feishu/callback?state=${encodeURIComponent(state)}&code=test-code`
  );
  if (callback.status !== 200) {
    throw new Error(`callback failed: ${callback.status} ${await callback.text()}`);
  }

  let poll;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request(
      jar,
      `${server.origin}/v1/login/${encodeURIComponent(start.loginId)}?secret=${encodeURIComponent(start.pollSecret)}`
    );
    poll = await readJson(response);
    if (poll.status === "authorized") break;
    if (poll.status !== "pending") throw new Error(`login ended with ${poll.status}`);
  }
  if (poll?.status !== "authorized") throw new Error("login did not authorize");
  return { start, poll, jar };
}

export async function loginBrowser(fixture, server, jar = new CookieJar(), { bootstrap } = {}) {
  const query = bootstrap ? `?bootstrap=${encodeURIComponent(bootstrap)}` : "";
  const browserResponse = await request(jar, `${server.origin}/auth/feishu/start${query}`);
  if (browserResponse.status !== 302) {
    throw new Error(`browser login start failed: ${browserResponse.status}`);
  }
  const location = browserResponse.headers.get("location");
  const state = new URL(location).searchParams.get("state");
  const callback = await request(
    jar,
    `${server.origin}/auth/feishu/callback?state=${encodeURIComponent(state)}&code=test-code`
  );
  if (callback.status !== 303) {
    throw new Error(`browser callback failed: ${callback.status} ${await callback.text()}`);
  }
  const meResponse = await request(jar, `${server.origin}/api/me`);
  const me = await readJson(meResponse);
  if (meResponse.status !== 200) throw new Error(`api/me failed: ${meResponse.status}`);
  return { me, jar };
}

export async function adminPatchMember(jar, origin, memberId, body) {
  const meResponse = await request(jar, `${origin}/api/me`);
  const me = await readJson(meResponse);
  const response = await request(jar, `${origin}/api/admin/members/${memberId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      origin,
      "x-csrf-token": me.csrf,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await readJson(response) };
}
