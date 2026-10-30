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
  oauthStart: "/api/mmw-tools/oauth/start",
  oauthFinish: "/api/mmw-tools/oauth/finish",
  oauthRefresh: "/api/mmw-tools/oauth/refresh",
  revoke: "/api/mmw-tools/revoke",
} as const;
