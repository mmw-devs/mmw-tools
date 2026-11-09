#!/usr/bin/env node
// Consistent, verified snapshot of the auth-core SQLite database.
//
// Usage:
//   node backup.mjs [--data-dir DIR] [--out-dir DIR] [--keep N]
//
// Defaults: data dir from MMW_DATA_DIR or ./data, output in <data>/backups,
// seven snapshots retained. The snapshot is written under a temporary name,
// integrity-checked, then renamed into place. A failed run leaves the previous
// snapshots untouched and exits non-zero.
import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}

function stamp(date = new Date()) {
  // Milliseconds keep two manual runs in the same second from overwriting
  // each other; the daily timer never needs that, but operators do.
  return date.toISOString().replace(/[-:.]/g, "");
}

function fail(message) {
  console.error(`backup: ${message}`);
  process.exit(1);
}

const dataDir = path.resolve(
  arg("data-dir", process.env.MMW_DATA_DIR ?? path.join(process.cwd(), "data"))
);
const source = path.join(dataDir, "auth.sqlite");
const outDir = path.resolve(
  arg("out-dir", process.env.MMW_BACKUP_DIR ?? path.join(dataDir, "backups"))
);
const keep = Number(arg("keep", process.env.MMW_BACKUP_KEEP ?? "7"));

if (!Number.isInteger(keep) || keep < 1 || keep > 90) {
  fail(`--keep must be an integer between 1 and 90, got ${keep}`);
}

try {
  const info = await stat(source);
  if (!info.isFile() || info.size === 0) fail(`${source} is not a non-empty file`);
} catch (error) {
  fail(`cannot read ${source}: ${error.message}`);
}

await mkdir(outDir, { recursive: true, mode: 0o700 });

const name = `auth-${stamp()}.sqlite`;
const destination = path.join(outDir, name);
const temporary = path.join(outDir, `.${name}.tmp`);

let db;
try {
  db = new DatabaseSync(source, { readOnly: true });
  await backup(db, temporary);
} catch (error) {
  await unlink(temporary).catch(() => {});
  fail(`snapshot failed: ${error.message}`);
} finally {
  try {
    db?.close();
  } catch {
    // closing a read-only handle is best-effort
  }
}

// A backup that cannot be opened is worse than no backup: verify before it
// replaces anything and before old snapshots are pruned.
let check;
try {
  check = new DatabaseSync(temporary, { readOnly: true });
  const result = check.prepare("PRAGMA integrity_check").get();
  if (result.integrity_check !== "ok") {
    throw new Error(`integrity_check returned ${JSON.stringify(result)}`);
  }
} catch (error) {
  await unlink(temporary).catch(() => {});
  fail(`snapshot is not readable: ${error.message}`);
} finally {
  try {
    check?.close();
  } catch {
    // best-effort
  }
}

await rename(temporary, destination);

const snapshots = (await readdir(outDir))
  .filter((entry) => /^auth-\d{8}T\d{9}Z\.sqlite$/.test(entry))
  .sort()
  .reverse();
for (const stale of snapshots.slice(keep)) {
  await unlink(path.join(outDir, stale)).catch(() => {});
}

const final = await stat(destination);
console.log(
  `backup: ${destination} (${final.size} bytes), ${Math.min(snapshots.length, keep)} snapshot(s) kept`
);
