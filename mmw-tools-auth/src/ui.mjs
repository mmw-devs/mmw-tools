export const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MMW Tools 权限管理</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <div>
      <small>MMW · 内部工具授权</small>
      <h1>MMW Tools 权限管理</h1>
    </div>
    <div id="account"></div>
  </header>
  <main>
    <div id="notice" role="status" aria-live="polite"></div>

    <section id="welcome" hidden>
      <h2>使用飞书身份登录</h2>
      <p>登录后可以管理成员角色和工具权限。仅限指定飞书组织的成员。</p>
      <a class="button" href="/auth/feishu/start">使用飞书登录</a>
    </section>

    <section id="denied" hidden>
      <h2>没有管理权限</h2>
      <p>当前账号可以登录，但还不是权限管理员。请联系管理员授予 <code>admin</code> 角色。</p>
    </section>

    <section id="workspace" hidden>
      <h2>成员与角色</h2>
      <p class="muted">角色只是权限包；“直授权限”用于临时例外。停用会立即撤销该成员的全部插件 token。</p>
      <div id="member-list"></div>
      <details>
        <summary>最近操作</summary>
        <div id="audit"></div>
      </details>
    </section>
  </main>
  <footer>MMW Tools · 飞书鉴权核心 · 路由消费者：DSH agent</footer>
  <script src="/app.js"></script>
</body>
</html>`;

export const css = `:root{font-family:system-ui,"Microsoft YaHei",sans-serif;color:#23323d;background:#f3f5f7;font-size:15px}
*{box-sizing:border-box}body{margin:0}header,main,footer{max-width:1100px;margin:auto;padding:24px 32px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:1px solid #d9e1e7}
h1{margin:6px 0;font-size:26px}h2{font-size:20px;margin-top:0}small,.muted{color:#647780}
section{background:white;border:1px solid #dde4e8;border-radius:12px;padding:22px;margin-bottom:18px}
a.button,button{display:inline-block;padding:9px 13px;margin:4px 8px 4px 0;border:0;border-radius:6px;
background:#17646b;color:white;cursor:pointer;text-decoration:none;font:inherit}
button.secondary{background:#e9eef1;color:#23323d}button:disabled{opacity:.55;cursor:wait}
.member{border-top:1px solid #e3e8ec;padding:14px 0;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.member:first-child{border-top:0}.member strong{min-width:120px}
.member label{display:inline-flex;align-items:center;gap:4px;margin-right:8px}
.member input[type=text]{min-width:240px;padding:7px;border:1px solid #b7c6cf;border-radius:6px;font:inherit}
.member input[type=checkbox]{width:auto}
#notice:not(:empty){background:#fff3cf;border:1px solid #e2c878;padding:12px;border-radius:8px;margin-bottom:16px}
#audit p{margin:6px 0;color:#526671;font-size:14px}code{background:#f1f4f6;padding:1px 5px;border-radius:4px}
footer{color:#647780;font-size:13px}
@media(max-width:720px){header,main,footer{padding:16px}header{flex-direction:column}.member{align-items:flex-start}}
`;

export const js = String.raw`
const $ = (id) => document.getElementById(id);
const notice = (text) => { $("notice").textContent = text; };
let me;

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["content-type"] = "application/json";
  if (me?.csrf && options.method && options.method !== "GET") headers["x-csrf-token"] = me.csrf;
  const response = await fetch(url, { ...options, headers });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(data.message || "请求失败");
    error.status = response.status;
    throw error;
  }
  return data;
}

function show(id, visible) { $(id).hidden = !visible; }

async function boot() {
  notice("");
  try {
    me = await api("/api/me");
  } catch (error) {
    if (error.status === 401) {
      show("welcome", true); show("workspace", false); show("denied", false);
      return;
    }
    notice(error.message);
    return;
  }
  show("welcome", false); show("workspace", me.isAdmin); show("denied", !me.isAdmin);
  $("account").replaceChildren();
  const name = document.createElement("span");
  name.textContent = me.member.name + (me.isAdmin ? " · 管理员" : "");
  const logout = document.createElement("button");
  logout.textContent = "退出";
  logout.className = "secondary";
  logout.onclick = async () => {
    try { await api("/api/logout", { method: "POST", body: "{}" }); location.reload(); }
    catch (error) { notice(error.message); }
  };
  $("account").append(name, logout);
  if (me.isAdmin) {
    const roles = await api("/api/admin/roles");
    await members(roles);
    await audit();
  }
}

async function members(roles) {
  const rows = await api("/api/admin/members");
  const box = $("member-list");
  box.replaceChildren();
  for (const member of rows) {
    const row = document.createElement("div");
    row.className = "member";
    const name = document.createElement("strong");
    name.textContent = member.name;
    row.append(name);

    const inputs = {};
    for (const role of roles) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = member.roles.includes(role.id);
      inputs[role.id] = checkbox;
      label.append(checkbox, document.createTextNode(role.title || role.id));
      row.append(label);
    }

    const enabledLabel = document.createElement("label");
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = member.enabled;
    enabledLabel.append(enabled, document.createTextNode("启用"));
    row.append(enabledLabel);

    const save = document.createElement("button");
    save.textContent = "保存";
    save.onclick = async () => {
      save.disabled = true;
      try {
        const roles = Object.entries(inputs).filter(([, input]) => input.checked).map(([role]) => role);
        await api("/api/admin/members/" + member.id, {
          method: "PATCH",
          body: JSON.stringify({ version: member.version, roles, enabled: enabled.checked }),
        });
        notice("已保存：" + member.name);
        await members(roles);
        await audit();
      } catch (error) {
        notice(error.message);
      } finally {
        save.disabled = false;
      }
    };
    row.append(save);

    const effective = document.createElement("span");
    effective.className = "muted";
    effective.textContent =
      "角色：" + (member.roles.length ? member.roles.join(", ") : "(无)") +
      (member.isAdmin ? " · 管理员" : "");
    row.append(effective);
    box.append(row);
  }
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "还没有成员登录过。";
    box.append(empty);
  }
}

async function audit() {
  const events = await api("/api/admin/audit");
  const box = $("audit");
  box.replaceChildren();
  for (const event of events) {
    const row = document.createElement("p");
    row.textContent = new Date(event.at).toLocaleString("zh-CN") + " · " + event.action + " · " + event.target;
    box.append(row);
  }
}

boot().catch((error) => notice(error.message));
`;
