import path from "node:path";
import { fileURLToPath } from "node:url";

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SERVICE_ROOT = path.resolve(SRC_DIR, "..");

function required(env, keys) {
  const missing = keys.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(`missing required environment variable(s): ${missing.join(", ")}`);
  }
}

function positiveInteger(raw, fallback, label) {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * Load and validate configuration. `fetcher` is injectable so tests can mock
 * Feishu without touching the network.
 */
export function loadConfig(env = process.env, { fetcher = fetch, now = () => Date.now() } = {}) {
  required(env, ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_TENANT_KEY"]);

  const originRaw = (env.MMW_ORIGIN ?? "http://127.0.0.1:4326").replace(/\/+$/, "");
  let origin;
  try {
    origin = new URL(originRaw);
  } catch {
    throw new ConfigError("MMW_ORIGIN must be an absolute URL");
  }
  if (origin.origin !== originRaw || origin.username || origin.password) {
    throw new ConfigError("MMW_ORIGIN must be a bare origin without a path, query, or credentials");
  }
  const local =
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "localhost" ||
    origin.hostname === "::1" ||
    origin.hostname === "[::1]";
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && local)) {
    throw new ConfigError("MMW_ORIGIN must use HTTPS; local HTTP is allowed only for 127.0.0.1/localhost");
  }

  const port = Number(env.MMW_PORT ?? 4326);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError("MMW_PORT must be an integer between 0 and 65535");
  }

  return {
    appId: env.FEISHU_APP_ID.trim(),
    appSecret: env.FEISHU_APP_SECRET.trim(),
    tenantKey: env.FEISHU_TENANT_KEY.trim(),
    adminOpenId: (env.MMW_ADMIN_OPEN_ID ?? "").trim(),
    bootstrapToken: (env.MMW_BOOTSTRAP_TOKEN ?? "").trim(),
    scopes: (env.FEISHU_USER_SCOPES ?? "").trim(),
    origin: origin.origin,
    port,
    dataDir: path.resolve(env.MMW_DATA_DIR ?? path.join(SERVICE_ROOT, "data")),
    contractsDir: path.resolve(env.MMW_CONTRACTS_DIR ?? path.join(SERVICE_ROOT, "..", "contracts")),
    pluginTokenTtlSeconds: positiveInteger(
      env.MMW_PLUGIN_TOKEN_TTL_SECONDS,
      7 * 24 * 60 * 60,
      "MMW_PLUGIN_TOKEN_TTL_SECONDS"
    ),
    sessionTtlSeconds: 8 * 60 * 60,
    oauthTtlSeconds: 5 * 60,
    cookieSecure: origin.protocol === "https:",
    fetcher,
    now,
  };
}
