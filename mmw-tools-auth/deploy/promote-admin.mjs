import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const file = process.env.MMW_DB ?? "/opt/mmw-tools-auth/data/auth.sqlite";
const name = process.argv[2] ?? "weunimix";
const db = new DatabaseSync(file);
const now = new Date().toISOString();

const member =
  db.prepare("select * from members where name = ? order by last_login_at desc limit 1").get(name) ??
  db.prepare("select * from members order by last_login_at desc limit 1").get();
if (!member) {
  console.error("no member found");
  process.exit(1);
}

const roles = JSON.parse(member.roles);
if (!roles.includes("admin")) roles.push("admin");

db.exec("BEGIN IMMEDIATE");
try {
  db.prepare("update members set roles=?, version=version+1, updated_at=? where id=?").run(
    JSON.stringify(roles),
    now,
    member.id
  );
  db.prepare(
    "insert into config (key,value) values ('bootstrapped','true') " +
      "on conflict(key) do update set value=excluded.value"
  ).run();
  const current = Number(db.prepare("select value from config where key='policyRevision'").get()?.value ?? "1");
  db.prepare(
    "insert into config (key,value) values ('policyRevision',?) " +
      "on conflict(key) do update set value=excluded.value"
  ).run(String(current + 1));
  db.prepare("insert into audit (id, actor, action, target, details, at) values (?,?,?,?,?,?)").run(
    randomUUID(),
    member.id,
    "admin-bootstrap-manual",
    member.id,
    JSON.stringify({ roles }),
    now
  );
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

console.log(JSON.stringify({ name: member.name, roles }, null, 2));
db.close();
