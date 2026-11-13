/**
 * Loopback route paths — one definition, two consumers.
 *
 * The host registers handlers at these paths (src/routes.ts) and the Settings
 * panel calls them (src/client/api.ts). They used to be written twice with
 * nothing tying the copies together, so renaming a route would have broken
 * the panel silently: the server side keeps working and every browser call
 * 404s. Importing this module is the cheap fix; the panel bundle inlines it
 * at build time, so the browser needs no module loader for it.
 */
export const API = {
  status: "/api/mmw-tools/status",
  feishuStatus: "/api/mmw-tools/feishu/status",
  feishuLoginStart: "/api/mmw-tools/feishu/login/start",
  feishuLoginPoll: "/api/mmw-tools/feishu/login/poll",
  feishuLogout: "/api/mmw-tools/feishu/logout",
} as const;
