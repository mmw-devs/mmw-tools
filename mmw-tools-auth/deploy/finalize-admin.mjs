import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const file = process.env.MMW_DB ?? "/opt/mmw-tools-auth/data/auth.sqlite";
const envFile = process.env.MMW_ENV ?? "/opt/mmw-tools-auth/.env";
const name = process.argv[2] ?? "weunimix";

const db = new DatabaseSync(file, { readOnly: true });
const member = db.prepare("select open_id from members where name = ? order by last_login_at desc limit 1").get(name);
db.close();
if (!member?.open_id) {
  console.error(`no member named ${name}`);
  process.exit(1);
}

let env = readFileSync(envFile, "utf8");
env = env
  .split("\n")
  .filter((line) => !line.startsWith("MMW_BOOTSTRAP_TOKEN="))
  .join("\n");
if (/^MMW_ADMIN_OPEN_ID=/m.test(env)) {
  env = env.replace(/^MMW_ADMIN_OPEN_ID=.*$/m, `MMW_ADMIN_OPEN_ID=${member.open_id}`);
} else {
  env += `\nMMW_ADMIN_OPEN_ID=${member.open_id}\n`;
}
writeFileSync(envFile, env, "utf8");
chmodSync(envFile, 0o600);
console.log(JSON.stringify({ name, adminOpenIdSet: true, bootstrapRemoved: true }));
