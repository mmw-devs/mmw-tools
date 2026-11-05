import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CookieJar,
  adminPatchMember,
  createFixture,
  loginBrowser,
  loginPlugin,
  readJson,
  request,
  startServer,
} from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(HERE, "..", "..", "contracts", "examples");

async function listMembers(jar, origin) {
  const response = await request(jar, `${origin}/api/admin/members`);
  return { status: response.status, body: await readJson(response) };
}

export async function runAuthTests(test) {
  await test("policy route tables match the golden contract files", async () => {
    const fixture = createFixture();
    try {
      for (const role of ["viewer", "editor", "operator", "admin"]) {
        const expected = JSON.parse(
          readFileSync(path.join(EXAMPLES, `routes.${role}.json`), "utf8")
        );
        const actual = fixture.policy.routeTable(
          { roles: [role] },
          expected.policyRevision,
          expected.ttlSeconds
        );
        assert.deepEqual(actual, expected, `route table mismatch for ${role}`);
      }
    } finally {
      fixture.cleanup();
    }
  });

  await test("health exposes the catalog revision", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture);
    try {
      const response = await request(new CookieJar(), `${server.origin}/health`);
      const body = await readJson(response);
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.contractVersion, 2);
      assert.match(body.catalogRevision, /^sha256:[a-f0-9]{64}$/);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });

  await test("plugin login: identity, no roles, only always-on status tool", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture);
    try {
      fixture.mock.state.user = { tenant_key: "tenant_test", open_id: "ou_alice", name: "Alice" };
      const login = await loginPlugin(fixture, server);
      assert.equal(login.poll.member.name, "Alice");
      assert.deepEqual(login.poll.roles, []);
      assert.equal(login.poll.isAdmin, false);

      const meResponse = await request(login.jar, `${server.origin}/v1/me`, {
        headers: { authorization: `Bearer ${login.poll.pluginToken}` },
      });
      const me = await readJson(meResponse);
      assert.equal(meResponse.status, 200);
      assert.equal(me.name, "Alice");
      assert.deepEqual(me.roles, []);
      assert.equal(me.isAdmin, false);

      const routesResponse = await request(login.jar, `${server.origin}/v1/agent/routes`, {
        headers: { authorization: `Bearer ${login.poll.pluginToken}` },
      });
      const routes = await readJson(routesResponse);
      assert.equal(routesResponse.status, 200);
      assert.deepEqual(routes.allowed, ["mmw-tools-status"]);
      assert.deepEqual(routes.allowedOperations, ["mmw-tools-status.status"]);
      assert.equal(routes.denied.length, 1);
      assert.equal(routes.denied[0].toolId, "race-ops");
      assert.deepEqual(routes.denied[0].requiredRoles, ["operator", "admin"]);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });

  await test("bootstrap admin: first browser login becomes admin, token is one-time", async () => {
    const fixture = createFixture({ bootstrapToken: "boot-secret" });
    const server = await startServer(fixture);
    try {
      fixture.mock.state.user = { tenant_key: "tenant_test", open_id: "ou_admin", name: "Admin" };
      const { me } = await loginBrowser(fixture, server, new CookieJar(), { bootstrap: "boot-secret" });
      assert.equal(me.isAdmin, true);
      assert.ok(me.member.roles.includes("admin"));

      const members = await listMembers(new CookieJar(), server.origin); // no session: 401
      assert.equal(members.status, 401);

      const badBootstrap = await request(
        new CookieJar(),
        `${server.origin}/auth/feishu/start?bootstrap=wrong`
      );
      assert.equal(badBootstrap.status, 403);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });

  await test("admin can grant operator and revoke; viewer/editor do not consume race-ops", async () => {
    const fixture = createFixture({ bootstrapToken: "boot-secret" });
    const server = await startServer(fixture);
    try {
      fixture.mock.state.user = { tenant_key: "tenant_test", open_id: "ou_admin", name: "Admin" };
      const admin = await loginBrowser(fixture, server, new CookieJar(), { bootstrap: "boot-secret" });

      fixture.mock.state.user = { tenant_key: "tenant_test", open_id: "ou_alice", name: "Alice" };
      const alice = await loginPlugin(fixture, server);

      const before = await listMembers(admin.jar, server.origin);
      assert.equal(before.status, 200);
      const aliceRow = before.body.find((member) => member.name === "Alice");
      assert.ok(aliceRow);

      const viewer = await adminPatchMember(admin.jar, server.origin, aliceRow.id, {
        version: aliceRow.version,
        roles: ["viewer"],
        enabled: true,
      });
      assert.equal(viewer.response.status, 200);

      const viewerRoutesResponse = await request(alice.jar, `${server.origin}/v1/agent/routes`, {
        headers: { authorization: `Bearer ${alice.poll.pluginToken}` },
      });
      const viewerRoutes = await readJson(viewerRoutesResponse);
      assert.deepEqual(viewerRoutes.allowed, ["mmw-tools-status"]);
      assert.equal(viewerRoutes.denied[0].toolId, "race-ops");

      const afterViewer = await listMembers(admin.jar, server.origin);
      const viewerRow = afterViewer.body.find((member) => member.name === "Alice");
      const editor = await adminPatchMember(admin.jar, server.origin, viewerRow.id, {
        version: viewerRow.version,
        roles: ["editor"],
        enabled: true,
      });
      assert.equal(editor.response.status, 200);

      const editorRoutesResponse = await request(alice.jar, `${server.origin}/v1/agent/routes`, {
        headers: { authorization: `Bearer ${alice.poll.pluginToken}` },
      });
      const editorRoutes = await readJson(editorRoutesResponse);
      assert.deepEqual(editorRoutes.allowed, ["mmw-tools-status"]);

      const afterEditor = await listMembers(admin.jar, server.origin);
      const editorRow = afterEditor.body.find((member) => member.name === "Alice");
      const operator = await adminPatchMember(admin.jar, server.origin, editorRow.id, {
        version: editorRow.version,
        roles: ["operator"],
        enabled: true,
      });
      assert.equal(operator.response.status, 200);

      const operatorRoutesResponse = await request(alice.jar, `${server.origin}/v1/agent/routes`, {
        headers: { authorization: `Bearer ${alice.poll.pluginToken}` },
      });
      const operatorRoutes = await readJson(operatorRoutesResponse);
      assert.deepEqual(operatorRoutes.allowed, ["mmw-tools-status", "race-ops"]);
      assert.ok(operatorRoutes.allowedOperations.includes("race-ops.pr_merge"));

      const afterOperator = await listMembers(admin.jar, server.origin);
      const operatorRow = afterOperator.body.find((member) => member.name === "Alice");
      const revoke = await adminPatchMember(admin.jar, server.origin, operatorRow.id, {
        version: operatorRow.version,
        roles: [],
        enabled: true,
      });
      assert.equal(revoke.response.status, 200);

      const revokedResponse = await request(alice.jar, `${server.origin}/v1/agent/routes`, {
        headers: { authorization: `Bearer ${alice.poll.pluginToken}` },
      });
      const revoked = await readJson(revokedResponse);
      assert.deepEqual(revoked.allowed, ["mmw-tools-status"]);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });

  await test("disabling a member invalidates the plugin token", async () => {
    const fixture = createFixture({ bootstrapToken: "boot-secret" });
    const server = await startServer(fixture);
    try {
      fixture.mock.state.user = { tenant_key: "tenant_test", open_id: "ou_admin", name: "Admin" };
      const admin = await loginBrowser(fixture, server, new CookieJar(), { bootstrap: "boot-secret" });
      fixture.mock.state.user = { tenant_key: "tenant_test", open_id: "ou_alice", name: "Alice" };
      const alice = await loginPlugin(fixture, server);

      const list = await listMembers(admin.jar, server.origin);
      const row = list.body.find((member) => member.name === "Alice");
      const disabled = await adminPatchMember(admin.jar, server.origin, row.id, {
        version: row.version,
        roles: ["viewer"],
        enabled: false,
      });
      assert.equal(disabled.response.status, 200);

      const meResponse = await request(alice.jar, `${server.origin}/v1/me`, {
        headers: { authorization: `Bearer ${alice.poll.pluginToken}` },
      });
      assert.equal(meResponse.status, 401);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });

  await test("last admin cannot be demoted or disabled", async () => {
    const fixture = createFixture({ bootstrapToken: "boot-secret" });
    const server = await startServer(fixture);
    try {
      fixture.mock.state.user = { tenant_key: "tenant_test", open_id: "ou_admin", name: "Admin" };
      const admin = await loginBrowser(fixture, server, new CookieJar(), { bootstrap: "boot-secret" });
      const list = await listMembers(admin.jar, server.origin);
      const row = list.body[0];
      const demote = await adminPatchMember(admin.jar, server.origin, row.id, {
        version: row.version,
        roles: [],
        enabled: true,
      });
      assert.equal(demote.response.status, 409);
      assert.equal(demote.body.error, "mmw_last_admin");
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });

  await test("callback replay, wrong browser, and wrong poll secret are rejected", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture);
    try {
      fixture.mock.state.user = { tenant_key: "tenant_test", open_id: "ou_alice", name: "Alice" };
      const jar = new CookieJar();
      const startResponse = await request(jar, `${server.origin}/v1/login/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const start = await readJson(startResponse);
      const browser = await request(jar, start.loginUrl);
      const state = new URL(browser.headers.get("location")).searchParams.get("state");

      const wrongBrowser = await request(
        new CookieJar(),
        `${server.origin}/auth/feishu/callback?state=${encodeURIComponent(state)}&code=test-code`
      );
      assert.equal(wrongBrowser.status, 403);

      const wrongPoll = await request(
        jar,
        `${server.origin}/v1/login/${encodeURIComponent(start.loginId)}?secret=wrong`
      );
      assert.equal(wrongPoll.status, 403);

      const ok = await request(
        jar,
        `${server.origin}/auth/feishu/callback?state=${encodeURIComponent(state)}&code=test-code`
      );
      assert.equal(ok.status, 200);

      const replay = await request(
        jar,
        `${server.origin}/auth/feishu/callback?state=${encodeURIComponent(state)}&code=test-code`
      );
      assert.equal(replay.status, 400);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });

  await test("tenant mismatch is rejected before creating a member", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture);
    try {
      fixture.mock.state.user = { tenant_key: "other_tenant", open_id: "ou_mallory", name: "Mallory" };
      const jar = new CookieJar();
      const startResponse = await request(jar, `${server.origin}/v1/login/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const start = await readJson(startResponse);
      const browser = await request(jar, start.loginUrl);
      const state = new URL(browser.headers.get("location")).searchParams.get("state");
      const callback = await request(
        jar,
        `${server.origin}/auth/feishu/callback?state=${encodeURIComponent(state)}&code=test-code`
      );
      assert.equal(callback.status, 403);
      assert.equal(fixture.store.allMembers().length, 0);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });

  await test("plugin token refresh rotates and logout revokes", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture);
    try {
      fixture.mock.state.user = { tenant_key: "tenant_test", open_id: "ou_alice", name: "Alice" };
      const login = await loginPlugin(fixture, server);

      const refreshResponse = await request(login.jar, `${server.origin}/v1/session/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${login.poll.pluginToken}` },
      });
      const refreshed = await readJson(refreshResponse);
      assert.equal(refreshResponse.status, 200);
      assert.notEqual(refreshed.pluginToken, login.poll.pluginToken);

      const oldToken = await request(login.jar, `${server.origin}/v1/me`, {
        headers: { authorization: `Bearer ${login.poll.pluginToken}` },
      });
      assert.equal(oldToken.status, 401);

      const newToken = await request(login.jar, `${server.origin}/v1/me`, {
        headers: { authorization: `Bearer ${refreshed.pluginToken}` },
      });
      assert.equal(newToken.status, 200);

      const logout = await request(login.jar, `${server.origin}/v1/session/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${refreshed.pluginToken}` },
      });
      assert.equal(logout.status, 200);

      const afterLogout = await request(login.jar, `${server.origin}/v1/me`, {
        headers: { authorization: `Bearer ${refreshed.pluginToken}` },
      });
      assert.equal(afterLogout.status, 401);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });

  await test("expired plugin token is rejected", async () => {
    const fixture = createFixture({ pluginTokenTtlSeconds: 1 });
    const server = await startServer(fixture);
    try {
      fixture.mock.state.user = { tenant_key: "tenant_test", open_id: "ou_alice", name: "Alice" };
      const login = await loginPlugin(fixture, server);
      fixture.nowRef.value += 2000;
      const response = await request(login.jar, `${server.origin}/v1/me`, {
        headers: { authorization: `Bearer ${login.poll.pluginToken}` },
      });
      assert.equal(response.status, 401);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });

  await test("agent events are accepted and audited without arguments", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture);
    try {
      fixture.mock.state.user = { tenant_key: "tenant_test", open_id: "ou_alice", name: "Alice" };
      const login = await loginPlugin(fixture, server);
      const response = await request(login.jar, `${server.origin}/v1/agent/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${login.poll.pluginToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          events: [{ type: "tool_denied", toolId: "race-ops.repo_edit", reason: "not_allowed" }],
        }),
      });
      const body = await readJson(response);
      assert.equal(response.status, 200);
      assert.equal(body.accepted, 1);
      assert.ok(fixture.store.listAudit(10).some((event) => event.action === "agent-event"));
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });

  await test("CSRF and session checks protect the admin API", async () => {
    const fixture = createFixture({ bootstrapToken: "boot-secret" });
    const server = await startServer(fixture);
    try {
      fixture.mock.state.user = { tenant_key: "tenant_test", open_id: "ou_admin", name: "Admin" };
      const admin = await loginBrowser(fixture, server, new CookieJar(), { bootstrap: "boot-secret" });
      const list = await listMembers(admin.jar, server.origin);
      const row = list.body[0];

      const noCsrf = await request(admin.jar, `${server.origin}/api/admin/members/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: server.origin },
        body: JSON.stringify({ version: row.version, roles: ["viewer"], enabled: true }),
      });
      assert.equal(noCsrf.status, 403);

      const crossOrigin = await request(admin.jar, `${server.origin}/api/admin/members/${row.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          "x-csrf-token": admin.me.csrf,
        },
        body: JSON.stringify({ version: row.version, roles: ["viewer"], enabled: true }),
      });
      assert.equal(crossOrigin.status, 403);

      const noSession = await request(new CookieJar(), `${server.origin}/api/admin/members`);
      assert.equal(noSession.status, 401);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });
}
