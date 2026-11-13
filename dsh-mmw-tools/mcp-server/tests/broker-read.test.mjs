#!/usr/bin/env node
// mcp-server/tests/broker-read.test.mjs
//
// The read proxy is what lets a client without github.com clone, pull, read
// PRs and previews. These tests point the built tools at a local fake broker
// and assert both the wire shape and the resulting checkout.

import http from "node:http";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "..", "dist", "tools");
const BROKER_DIST = path.resolve(__dirname, "..", "dist", "broker-read.js");

if (!existsSync(BROKER_DIST) || !existsSync(path.join(DIST, "repo-clone.js"))) {
  console.error("Run `pnpm build` in mcp-server first.");
  process.exit(2);
}

const { repoClone } = await import(pathToFileURL(path.join(DIST, "repo-clone.js")).href);
const { repoPull } = await import(pathToFileURL(path.join(DIST, "repo-pull.js")).href);
const { repoEdit } = await import(pathToFileURL(path.join(DIST, "repo-edit.js")).href);
const { prList } = await import(pathToFileURL(path.join(DIST, "pr-list.js")).href);
const { prPreview } = await import(pathToFileURL(path.join(DIST, "pr-preview.js")).href);

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
const eq = (a, w, label) =>
  a === w ? ok(label) : bad(label, `expected ${JSON.stringify(w)}, got ${JSON.stringify(a)}`);

const tmp = mkdtempSync(path.join(os.tmpdir(), "mmw-broker-read-"));
const authFile = path.join(tmp, "write-auth.json");
writeFileSync(authFile, JSON.stringify({ kind: "feishu", token: "fs-test" }), { mode: 0o600 });

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_TERMINAL_PROMPT: "0",
};
const git = (cwd, args) =>
  execFileSync("git", args, { cwd, env: gitEnv, stdio: "ignore" });

let gitBlocked = false;
let seed = "";
let bundle = "";
let repoHead = "";
let originUrl = "https://github.com/mmw-devs/ffxiv-race-ops.git";

try {
  seed = path.join(tmp, "seed");
  bundle = path.join(tmp, "repo.bundle");
  git(tmp, ["init", seed]);
  git(seed, ["checkout", "-b", "main"]);
  writeFileSync(path.join(seed, "README.md"), "seed\n");
  git(seed, ["add", "README.md"]);
  git(seed, ["commit", "-m", "seed"]);
  repoHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seed, env: gitEnv }).toString().trim();
  git(seed, ["bundle", "create", bundle, "--all"]);
} catch (err) {
  const msg = String(err?.message ?? err);
  if (err?.code === "EPERM" || msg.includes("spawnSync git EPERM")) {
    gitBlocked = true;
    console.log("  SKIP  git subprocess blocked by the sandbox (clone/pull)");
  } else {
    throw err;
  }
}

const requests = [];
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
  if (req.headers["x-mmw-feishu-token"] !== "fs-test") {
    json(res, 401, { error: "read-credential-required", message: "missing test token" });
    return;
  }
  if (url.pathname === "/v1/read/bundle" || url.pathname === "/v1/read/pull") {
    if (gitBlocked) {
      json(res, 503, { error: "test-git-blocked" });
      return;
    }
    const body = readFileSync(bundle);
    res.writeHead(200, {
      "content-type": "application/x-git-bundle",
      "x-commit-sha": repoHead,
      "x-repository": "mmw-devs/ffxiv-race-ops",
    });
    res.end(body);
    return;
  }
  if (url.pathname === "/v1/read/base-sha") {
    json(res, 200, {
      repository: "mmw-devs/ffxiv-race-ops",
      ref: url.searchParams.get("ref") ?? "main",
      sha: repoHead,
      login: "weunimix",
    });
    return;
  }
  if (url.pathname === "/v1/write/repo_edit") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests[requests.length - 1].body = JSON.parse(body);
      json(res, 200, { new_commit_sha: "c1", files_changed: ["src/a.txt"], branch: "content/test" });
    });
    return;
  }
  if (url.pathname === "/v1/read/pulls") {
    json(res, 200, {
      repository: "mmw-devs/ffxiv-race-ops",
      items: [
        {
          number: 31,
          title: "feat: read proxy",
          state: "open",
          head: { ref: "content/read-proxy" },
          base: { ref: "main" },
          html_url: "https://github.com/mmw-devs/ffxiv-race-ops/pull/31",
          created_at: "2026-11-14T00:00:00Z",
        },
      ],
    });
    return;
  }
  if (url.pathname === "/v1/read/pr") {
    json(res, 200, {
      repository: "mmw-devs/ffxiv-race-ops",
      pr: {
        number: 31,
        state: "open",
        draft: false,
        mergeable_state: "clean",
        head: { ref: "content/read-proxy", sha: "a".repeat(40) },
        html_url: "https://github.com/mmw-devs/ffxiv-race-ops/pull/31",
      },
    });
    return;
  }
  if (url.pathname === "/v1/read/checks") {
    json(res, 200, {
      repository: "mmw-devs/ffxiv-race-ops",
      head_sha: "a".repeat(40),
      check_runs: [
        {
          name: "Cloudflare Pages",
          status: "completed",
          conclusion: "success",
          output: {
            summary:
              "<strong>Preview URL:</strong> <a href='https://abc123.pages.dev'>preview</a><br>" +
              "<strong>Branch Preview URL:</strong> <a href='https://branch.pages.dev'>branch</a>",
          },
        },
      ],
    });
    return;
  }
  json(res, 404, { error: "not-found", message: url.pathname });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const brokerUrl = `http://127.0.0.1:${server.address().port}`;
const broker = { brokerUrl, writeAuthFile: authFile };

try {
  if (!gitBlocked) {
    const cloneDir = path.join(tmp, "clone");
    const cloned = await repoClone(
      {},
      {
        workingDir: cloneDir,
        repoUrl: originUrl,
        baseBranch: "main",
        githubToken: null,
        repoOwner: "mmw-devs",
        repoName: "ffxiv-race-ops",
        ...broker,
      }
    );
    eq(cloned.branch, "main", "repoClone reports the base branch");
    eq(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: cloneDir, env: gitEnv }).toString().trim(),
      repoHead,
      "repoClone checked out the broker bundle's HEAD"
    );
    eq(
      execFileSync("git", ["remote", "get-url", "origin"], { cwd: cloneDir, env: gitEnv }).toString().trim(),
      originUrl,
      "repoClone restores the clean GitHub origin"
    );

    writeFileSync(path.join(seed, "PULLED.md"), "new\n");
    git(seed, ["add", "PULLED.md"]);
    git(seed, ["commit", "-m", "pull"]);
    const pulledHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seed, env: gitEnv })
      .toString()
      .trim();
    git(seed, ["bundle", "create", bundle, "--all"]);
    repoHead = pulledHead;

    const pulled = await repoPull(
      { branch: "main" },
      {
        workingDir: cloneDir,
        branchPrefix: "content/",
        baseBranch: "main",
        repoOwner: "mmw-devs",
        repoName: "ffxiv-race-ops",
        ...broker,
      }
    );
    eq(pulled.fast_forwarded, true, "repoPull reports a fast-forward");
    eq(existsSync(path.join(cloneDir, "PULLED.md")), true, "repoPull applied the new commit");
    eq(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: cloneDir, env: gitEnv }).toString().trim(),
      pulledHead,
      "repoPull moved HEAD to the broker bundle"
    );
  }

  const edit = await repoEdit(
    {
      branch: "content/test",
      commit_message: "feat: update",
      edits: [{ path: "src/a.txt", mode: "replace", find: "hello", replace: "world" }],
    },
    {
      repo: "mmw-devs/ffxiv-race-ops",
      workingDir: path.join(tmp, "edit"),
      allowlistPaths: ["src/a.txt"],
      denylistPaths: [],
      branchPrefix: "content/",
      baseBranch: "main",
      preflight: { cmd: "", timeoutSeconds: 1 },
      repoOwner: "mmw-devs",
      repoName: "ffxiv-race-ops",
      ...broker,
    }
  );
  eq(edit.new_commit_sha, "c1", "repoEdit returns the broker commit");
  const write = requests.find((r) => r.path === "/v1/write/repo_edit");
  eq(write?.body?.base_sha, repoHead, "repoEdit sends the base SHA from the broker");
  eq(write?.body?.edits?.[0]?.path, "src/a.txt", "repoEdit forwards the edits");

  const list = await prList(
    { state: "open" },
    {
      workingDir: tmp,
      baseBranch: "main",
      repoOwner: "mmw-devs",
      repoName: "ffxiv-race-ops",
      ...broker,
    }
  );
  eq(list.items.length, 1, "prList maps the broker rows");
  eq(list.items[0].head_branch, "content/read-proxy", "prList maps head.ref");
  eq(list.items[0].base_branch, "main", "prList maps base.ref");

  const preview = await prPreview(
    { pr_number: 31, wait_seconds: 0 },
    {
      workingDir: tmp,
      repoOwner: "mmw-devs",
      repoName: "ffxiv-race-ops",
      ...broker,
    }
  );
  eq(preview.preview_url, "https://abc123.pages.dev/", "prPreview parses the immutable preview");
  eq(preview.branch_preview_url, "https://branch.pages.dev/", "prPreview parses the branch preview");
  eq(preview.checks.length, 1, "prPreview returns the check summary");
  eq(requests.filter((r) => r.path === "/v1/read/base-sha").length > 0, true, "repoEdit used the broker base-sha");
  eq(requests.every((r) => r.method === "GET" || r.path === "/v1/write/repo_edit"), true, "only reads plus the one edit POST");
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nbroker-read: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
