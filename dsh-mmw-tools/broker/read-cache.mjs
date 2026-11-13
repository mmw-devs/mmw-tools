/**
 * Server-side git cache for the read proxy.
 *
 * The client never needs a GitHub credential or a route to github.com:
 * this module keeps a bare mirror per registered repository and hands the
 * broker either a commit SHA or a bundle. There is one mirror per repo and
 * one in-flight clone/fetch per repo, so concurrent callers share work.
 *
 * The installation token is passed through git's command-scoped config
 * (`GIT_CONFIG_*`), never argv, so it does not appear in `ps`.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_GIT_TIMEOUT_MS = 180_000;

function safeSegment(value) {
  const s = String(value ?? "");
  if (!/^[A-Za-z0-9_.-]+$/.test(s)) throw new Error(`unsafe repository path segment: ${s}`);
  return s;
}

export class GitReadCache {
  constructor({
    dir,
    now = Date.now,
    execFileImpl = execFile,
    ttlMs = DEFAULT_TTL_MS,
    gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
    remoteBase = "https://github.com",
  } = {}) {
    const base = String(dir ?? "").trim();
    if (!base) throw new Error("GitReadCache requires a cache directory");
    this.dir = path.resolve(base);
    this.remoteBase = String(remoteBase).replace(/\/+$/, "");
    this.now = now;
    this.execFileImpl = execFileImpl;
    this.ttlMs = ttlMs;
    this.gitTimeoutMs = gitTimeoutMs;
    this.lastFetch = new Map(); // repo key -> timestamp
    this.inflight = new Map(); // repo key -> Promise
  }

  #repoDir(rc) {
    return path.join(this.dir, safeSegment(rc.owner), `${safeSegment(rc.name)}.git`);
  }

  #run(args, { token, timeoutMs = this.gitTimeoutMs } = {}) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (token) {
      const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.extraHeader";
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    }
    return new Promise((resolve, reject) => {
      this.execFileImpl(
        "git",
        args,
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            const message = String(stderr || error.message || "git failed").trim();
            reject(new Error(message.split("\n").slice(-3).join(" ")));
            return;
          }
          resolve(String(stdout ?? ""));
        }
      );
    });
  }

  async #refresh(rc, token) {
    const dir = this.#repoDir(rc);
    const key = rc.key.toLowerCase();
    const now = this.now();
    const last = this.lastFetch.get(key) ?? 0;
    if (existsSync(dir) && now - last < this.ttlMs) return dir;
    if (existsSync(dir)) {
      await this.#run(["-C", dir, "fetch", "--prune", "--tags", "origin"], { token });
      this.lastFetch.set(key, now);
      return dir;
    }
    mkdirSync(path.dirname(dir), { recursive: true });
    const url = `${this.remoteBase}/${encodeURIComponent(rc.owner)}/${encodeURIComponent(rc.name)}.git`;
    try {
      await this.#run(["clone", "--mirror", url, dir], { token });
    } catch (err) {
      // A half-written mirror would be mistaken for a usable cache on the
      // next request. Remove it so the retry starts clean.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* leave the original error as the cause */
      }
      throw err;
    }
    this.lastFetch.set(key, this.now());
    return dir;
  }

  /**
   * A mirror is shared by all readers of one repository. A single promise
   * serializes clone/fetch so two simultaneous requests do not race on the
   * same directory.
   */
  async ensure(rc, token) {
    const key = rc.key.toLowerCase();
    const running = this.inflight.get(key);
    if (running) return running;
    const job = (async () => {
      try {
        return await this.#refresh(rc, token);
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, job);
    return job;
  }

  async baseSha(rc, token, branch) {
    const dir = await this.ensure(rc, token);
    try {
      const out = await this.#run(["-C", dir, "rev-parse", "--verify", `refs/heads/${branch}`], {
        token,
        timeoutMs: 30_000,
      });
      return out.trim();
    } catch {
      return null;
    }
  }

  /**
   * Produce a full bundle (all local branches and tags) and return a path
   * the HTTP layer can stream. The caller owns cleanup.
   */
  async bundle(rc, token) {
    const dir = await this.ensure(rc, token);
    const file = path.join(dir, `read-${Date.now()}-${randomBytes(4).toString("hex")}.bundle`);
    await this.#run(["-C", dir, "bundle", "create", file, "--all"], { token });
    const size = statSync(file).size;
    let cleaned = false;
    return {
      path: file,
      size,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        try {
          unlinkSync(file);
        } catch {
          /* the tmp file will be replaced on the next request */
        }
      },
    };
  }
}
