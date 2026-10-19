/**
 * Tests for the audit logger + redacting logger.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AUDIT_DIST = path.join(ROOT, "lib", "util", "audit.js");

if (!existsSync(AUDIT_DIST)) {
  console.error("Run `pnpm build` first.");
  process.exit(2);
}

const { createAuditLogger, createRedactingLogger, auditPath, redactDeep } =
  await import(pathToFileURL(AUDIT_DIST).href);

let pass = 0,
  fail = 0;
function ok(label) {
  pass++;
  console.log(`  PASS  ${label}`);
}
function bad(label, msg) {
  fail++;
  console.error(`  FAIL  ${label}: ${msg}`);
}
function eq(actual, want, label) {
  if (actual === want) ok(`${label} = ${JSON.stringify(want)}`);
  else bad(label, `expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
}
function truthy(v, label) {
  if (v) ok(label);
  else bad(label, "expected truthy");
}

function silentLogger() {
  const captured = [];
  return {
    captured,
    warn: (m) => captured.push(m),
    info: () => {},
    error: () => {},
  };
}

/* ============================================================== */
/*  auditPath                                                      */
/* ============================================================== */
console.log("\n--- auditPath ---");
truthy(
  auditPath().endsWith("dsh-github-engineer-audit.jsonl"),
  "default auditPath"
);

/* ============================================================== */
/*  redactDeep                                                     */
/* ============================================================== */
console.log("\n--- redactDeep ---");
eq(
  redactDeep("hello ghp_abc123def456ghi789jkl012mno345pqr world"),
  "hello [REDACTED] world",
  "string is token-redacted"
);
eq(redactDeep(42), 42, "numbers pass through");
eq(redactDeep(true), true, "booleans pass through");
eq(redactDeep(null), null, "null passes through");
eq(
  JSON.stringify(redactDeep({ commit_message: "fix bug ghp_abc123def456ghi789jkl012mno345pqr", files: 3 })),
  JSON.stringify({ commit_message: "fix bug [REDACTED]", files: 3 }),
  "object values are walked"
);
eq(
  JSON.stringify(redactDeep(["hi ghp_abc123def456ghi789jkl012mno345pqr", 1, true])),
  JSON.stringify(["hi [REDACTED]", 1, true]),
  "array elements are walked"
);
eq(redactDeep({ a: { b: { c: { d: "token=gho_abc123def456ghi789jkl012mno345pqr" } } } }).a.b.c.d,
  "token=[REDACTED]",
  "4 levels deep still redacts"
);

// Depth > 8 returns [depth-limit]. Build a 10-level chain.
let deep = "leak ghp_abc123def456ghi789jkl012mno345pqr";
for (let i = 0; i < 10; i++) deep = { next: deep };
const result = redactDeep(deep);
let cursor = result;
for (let i = 0; i < 9; i++) {
  if (cursor && typeof cursor === "object" && "next" in cursor) {
    cursor = cursor.next;
  } else break;
}
eq(cursor, "[depth-limit]", "depth > 8 truncates to [depth-limit]");

/* ============================================================== */
/*  createAuditLogger: write + read + rotate                       */
/* ============================================================== */
console.log("\n--- createAuditLogger: write + redacted line ---");

{
  const tmp = mkdtempSync(path.join(tmpdir(), "dsh-audit-"));
  const file = path.join(tmp, "audit.jsonl");
  const log = createAuditLogger({
    file,
    maxBytes: 1024,
    warn: () => {},
  });
  await log.record({
    kind: "engineer_run_start",
    branch: "content/2026-10-19-fix-the-bug",
    user_request_excerpt: "Fix bug. ghp_abc123def456ghi789jkl012mno345pqr is set",
  });
  // Give the kernel a tick to flush the write.
  await new Promise((r) => setTimeout(r, 50));
  const line = readFileSync(file, "utf8").trim();
  truthy(existsSync(file), "file created");
  truthy(line.length > 0, "line written");
  truthy(line.includes("engineer_run_start"), "line has kind");
  truthy(line.includes("content/2026-10-19-fix-the-bug"), "branch present");
  truthy(
    !line.includes("ghp_abc123def456ghi789jkl012mno345pqr"),
    "raw token NOT in line"
  );
  truthy(line.includes("[REDACTED]"), "excerpt shows [REDACTED]");
  truthy(line.includes('"at"'), "timestamp injected");
  rmSync(tmp, { recursive: true, force: true });
}

console.log("\n--- createAuditLogger: rotation ---");

{
  const tmp = mkdtempSync(path.join(tmpdir(), "dsh-audit-"));
  const file = path.join(tmp, "audit.jsonl");
  // maxBytes=128 forces rotation on the second write.
  const log = createAuditLogger({ file, maxBytes: 128, warn: () => {} });
  for (let i = 0; i < 20; i++) {
    await log.record({
      kind: "engineer_run_start",
      idx: i,
      payload: "x".repeat(64),
    });
  }
  await new Promise((r) => setTimeout(r, 100));
  truthy(existsSync(file), "live file exists after rotation");
  truthy(existsSync(`${file}.1`), ".1 rotated file exists");
  rmSync(tmp, { recursive: true, force: true });
}

console.log("\n--- createAuditLogger: write failures do not throw ---");

{
  const log = createAuditLogger({
    file: "/this/path/does/not/exist/and/parent/cannot/be/created",
    maxBytes: 1024,
    warn: () => {},
  });
  let caught = null;
  try {
    await log.record({ kind: "engineer_run_start" });
  } catch (err) {
    caught = err;
  }
  eq(caught, null, "record() never throws");
}

console.log("\n--- createAuditLogger: warn fires only once ---");

{
  const captured = [];
  const log = createAuditLogger({
    file: "/nope/cannot/create",
    maxBytes: 1024,
    warn: (m) => captured.push(m),
  });
  await log.record({ kind: "a" });
  await log.record({ kind: "b" });
  await log.record({ kind: "c" });
  eq(captured.length, 1, "warn fires once on repeated failures");
  truthy(captured[0].includes("audit write failed"), "warn includes diagnostic");
  truthy(
    captured[0].includes("further audit failures are silent"),
    "warn mentions the once-only behavior"
  );
}

/* ============================================================== */
/*  createRedactingLogger                                           */
/* ============================================================== */
console.log("\n--- createRedactingLogger ---");

{
  const captured = [];
  const base = {
    info: (m) => captured.push(["info", m]),
    warn: (m) => captured.push(["warn", m]),
    error: (m) => captured.push(["error", m]),
  };
  const safe = createRedactingLogger(base);
  safe.info("info with ghp_abc123def456ghi789jkl012mno345pqr");
  safe.warn("warn with Bearer ghs_secretvalue_abc123def456ghi789jkl012");
  safe.error("error with api_key=sk-xyz");

  eq(captured.length, 3, "3 messages");
  truthy(
    !captured[0][1].includes("ghp_abc123def456ghi789jkl012mno345pqr"),
    "info level redacts token"
  );
  truthy(
    captured[0][1].includes("[REDACTED]"),
    "info level substitutes [REDACTED]"
  );
  truthy(
    !captured[1][1].includes("ghs_secretvalue_abc123def456ghi789jkl012"),
    "warn level redacts bearer token"
  );
  truthy(
    captured[1][1].includes("[REDACTED]"),
    "warn level substitutes [REDACTED]"
  );
  truthy(
    !captured[2][1].includes("sk-xyz"),
    "error level redacts api_key"
  );
}

console.log("\n--- createRedactingLogger: clean messages pass through ---");

{
  const captured = [];
  const safe = createRedactingLogger({
    info: (m) => captured.push(["info", m]),
    warn: () => {},
    error: () => {},
  });
  safe.info("plain message without any secrets");
  eq(captured[0][1], "plain message without any secrets", "clean message unchanged");
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);