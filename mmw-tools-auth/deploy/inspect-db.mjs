import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const file = process.env.MMW_DB ?? "/opt/mmw-tools-auth/data/auth.sqlite";
const envFile = process.env.MMW_ENV ?? "/opt/mmw-tools-auth/.env";
const env = {};
try {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
} catch {
  // env is optional for this diagnostic
}
const mask = (value) => (value && value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value ? "***" : "(missing)");
const db = new DatabaseSync(file, { readOnly: true });

const members = db
  .prepare("select id, name, open_id, roles, permissions, enabled, version, last_login_at from members order by last_login_at desc")
  .all()
  .map((member) => ({
    ...member,
    open_id: mask(member.open_id),
    matchesAdminOpenId: Boolean(env.MMW_ADMIN_OPEN_ID) && member.open_id === env.MMW_ADMIN_OPEN_ID,
  }));
const config = db.prepare("select key, value from config").all();
const audit = db.prepare("select at, actor, action, target from audit order by at desc limit 20").all();

console.log(
  JSON.stringify(
    {
      adminOpenId: mask(env.MMW_ADMIN_OPEN_ID),
      bootstrapTokenSet: Boolean(env.MMW_BOOTSTRAP_TOKEN),
      members,
      config,
      audit,
    },
    null,
    2
  )
);
db.close();
