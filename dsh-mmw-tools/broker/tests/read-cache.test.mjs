#!/usr/bin/env node
/**
 * broker/tests/read-cache.test.mjs
 *
 * The read proxy is only useful if its cache really produces a usable git
 * bundle. This test uses a local bare repository (no network, no GitHub
 * credential) and drives the real `git` binary through GitReadCache.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.resolve(__dirname, "..", "read-cache.mjs");
const { GitReadCache } = await import(pathToFileURL(CACHE).href);

let pass = 0;
let fail = 0;
const ok = (label) => {
  pass++;
  console.log(`  PASS  ${label}`);
};
const bad = (label, detail) => {
  fail++;
  console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
};

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

const root = mkdtempSync(path.join(os.tmpdir(), "mmw-read-cache-"));
try {
  const remoteRoot = path.join(root, "remote");
  const origin = path.join(remoteRoot, "o", "r.git");
  mkdirSync(path.dirname(origin), { recursive: true });
  git(["init", "--bare", "--initial-branch=main", origin], root);

  const seed = path.join(root, "seed");
  mkdirSync(seed);
  git(["init", "--initial-branch=main"], seed);
  writeFileSync(path.join(seed, "data.json"), '{"hello":"world"}\n');
  git(["add", "data.json"], seed);
  git(["commit", "-m", "seed"], seed);
  git(["remote", "add", "origin", origin], seed);
  git(["push", "origin", "main"], seed);
  const first = git(["rev-parse", "HEAD"], seed);

  const cacheDir = path.join(root, "cache");
  let clock = 1_000_000;
  const cache = new GitReadCache({
    dir: cacheDir,
    remoteBase: pathToFileURL(remoteRoot).href,
    now: () => clock,
    ttlMs: 1_000,
    gitTimeoutMs: 30_000,
  });
  const rc = { key: "o/r", owner: "o", name: "r" };

  const sha = await cache.baseSha(rc, null, "main");
  sha === first ? ok("baseSha returns the branch head") : bad("baseSha returns the branch head", sha);

  const missing = await cache.baseSha(rc, null, "does-not-exist");
  missing === null ? ok("missing branch returns null") : bad("missing branch returns null", missing);

  const bundle = await cache.bundle(rc, null);
  existsSync(bundle.path) ? ok("bundle file exists") : bad("bundle file exists");
  bundle.size > 0 ? ok("bundle is non-empty") : bad("bundle is non-empty", String(bundle.size));

  const clone = path.join(root, "clone");
  git(["clone", "--branch", "main", "--single-branch", bundle.path, clone], root);
  const cloned = readFileSync(path.join(clone, "data.json"), "utf8").trim();
  cloned === '{"hello":"world"}'
    ? ok("bundle clones to the expected content")
    : bad("bundle clones to the expected content", cloned);

  bundle.cleanup();
  !existsSync(bundle.path) ? ok("bundle cleanup removes the temp file") : bad("bundle cleanup removes the temp file");

  // A new commit is invisible until the TTL expires, then the mirror fetches it.
  writeFileSync(path.join(seed, "data.json"), '{"hello":"again"}\n');
  git(["add", "data.json"], seed);
  git(["commit", "-m", "second"], seed);
  git(["push", "origin", "main"], seed);
  const second = git(["rev-parse", "HEAD"], seed);

  const cachedStillFirst = await cache.baseSha(rc, null, "main");
  cachedStillFirst === first
    ? ok("the cache respects the TTL")
    : bad("the cache respects the TTL", cachedStillFirst);

  clock += 2_000;
  const refreshed = await cache.baseSha(rc, null, "main");
  refreshed === second
    ? ok("an expired cache fetches the new head")
    : bad("an expired cache fetches the new head", refreshed);

  let refused = false;
  try {
    const evil = new GitReadCache({
      dir: cacheDir,
      remoteBase: pathToFileURL(remoteRoot).href,
    });
    await evil.ensure({ key: "../x/r", owner: "../x", name: "r" }, null);
  } catch {
    refused = true;
  }
  refused ? ok("unsafe repository segments are refused") : bad("unsafe repository segments are refused");
} catch (err) {
  // Sandboxed hosts (including the DSH workspace sandbox on Windows) may
  // refuse to spawn git at all. The suite is meaningful only where git is
  // available; skip rather than fail the whole check there.
  if (err && (err.code === "EPERM" || /spawnSync git EPERM/.test(String(err.message)))) {
    console.log("  SKIP  git subprocess blocked by the sandbox");
    process.exitCode = 0;
  } else {
    throw err;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exitCode = 1;
