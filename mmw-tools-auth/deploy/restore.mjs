#!/usr/bin/env node
// Restore an auth-core database from a backup made by backup.mjs.
//
// Usage:
//   sudo systemctl stop mmw-tools-auth
//   node restore.mjs --backup /var/backups/mmw-tools-auth/auth-....sqlite --data-dir /opt/mmw-tools-auth/data --force
//   sudo systemctl start mmw-tools-auth
//
// The current database is kept as auth.sqlite.before-restore-<stamp> so a
// mistaken restore is itself reversible. The service is not restarted here on
// purpose: the operator verifies /health and the admin pages before starting it.
import { DatabaseSync } from "node:sqlite";
import { copyFile, rename, stat, unlink, chown, chmod } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function fail(message) {
  console.error(`restore: ${message}`);
  process.exit(1);
}

function portOpen(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const backupArg = arg("backup", "");
if (!backupArg) fail("missing --backup <file>");
const backupFile = path.resolve(backupArg);
const dataDir = path.resolve(
  arg("data-dir", process.env.MMW_DATA_DIR ?? path.join(process.cwd(), "data"))
);
const target = path.join(dataDir, "auth.sqlite");
const force = process.argv.includes("--force");

if (await portOpen(Number(process.env.MMW_PORT ?? 4326))) {
  if (!force) {
    fail("the auth core is still listening on 127.0.0.1; stop it first or pass --force");
  }
  console.error("restore: port is still open; --force given, continuing");
}

// Verify the backup before touching the live file.
let check;
try {
  check = new DatabaseSync(backupFile, { readOnly: true });
  const result = check.prepare("PRAGMA integrity_check").get();
  if (result.integrity_check !== "ok") throw new Error("integrity_check failed");
} catch (error) {
  fail(`backup is not usable: ${error.message}`);
} finally {
  try {
    check?.close();
  } catch {
    // best-effort
  }
}

let previous = null;
try {
  previous = await stat(target);
} catch {
  // no current database: first install or already removed
}

if (previous) {
  const keep = `${target}.before-restore-${stamp()}`;
  await copyFile(target, keep);
  console.log(`restore: kept the previous database at ${keep}`);
}

const temporary = `${target}.restoring`;
await copyFile(backupFile, temporary);
try {
  await rename(temporary, target);
} catch (error) {
  await unlink(temporary).catch(() => {});
  fail(`could not replace ${target}: ${error.message}`);
}

// Keep the original ownership/mode when possible; otherwise leave the file
// readable only by its owner.
if (previous) {
  await chown(target, previous.uid, previous.gid).catch(() => {});
  await chmod(target, previous.mode & 0o777).catch(() => {});
} else {
  await chmod(target, 0o600).catch(() => {});
}

// A DELETE-journal database should not have companions; stale WAL/SHM files
// from an interrupted run would be applied on top of the restored file.
for (const suffix of ["-wal", "-shm"]) {
  await unlink(`${target}${suffix}`).catch(() => {});
}

console.log(`restore: ${backupFile} -> ${target}`);
console.log("restore: start the service only after checking its journal for a clean boot");
