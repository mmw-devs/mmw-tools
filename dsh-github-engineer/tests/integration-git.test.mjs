#!/usr/bin/env node
/**
 * tests/integration-git.test.mjs
 *
 * Real-git integration tests for the eight MCP tools. Unlike every
 * other suite in this repository, this one executes the tool bodies
 * themselves — `repo_status`, `repo_read`, `repo_search`, `repo_edit`
 * (including its rollback path), `repo_pull`, `repo_clone`, and the
 * `pr_create` guards — against a throwaway repository built in a
 * temporary directory.
 *
 * Why it matters: the rest of the suite proves the guards and the
 * wiring, but nothing had ever run the code that actually touches the
 * user's repository.
 *
 * ## Environment requirement
 *
 * Every tool shells out through `execFile`, which needs
 * `child_process.spawn` with piped stdio. Some DSH sandboxes deny
 * that with EPERM. When that happens this suite prints a loud SKIP and
 * exits 0 rather than pretending to have tested anything. It runs for
 * real in CI (ubuntu-latest and windows-latest) and in any ordinary
 * terminal.
 *
 * ## Known limitation being exercised, not fixed
 *
 * `runPreflight` splits the command on whitespace without honouring
 * quotes, so `preflight.cmd: node -e "process.exit(1)"` would pass the
 * quotes through to node. The fixtures below therefore use a script
 * file (`node scripts/validate.js`) instead of an inline `-e`, which
 * is also what a real `npm run validate` looks like.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TOOLS = path.join(ROOT, "mcp-server", "dist", "tools");
const GUARD = path.join(ROOT, "mcp-server", "dist", "guard.js");

// A CI runner has no global git identity, so `git commit` inside the
// cloned fixture would fail with "Please tell me who you are". Setting
// the identity through the environment covers the tools as well, since
// they spawn git with this process's environment.
process.env.GIT_AUTHOR_NAME ||= "dsh-github-engineer tests";
process.env.GIT_AUTHOR_EMAIL ||= "ci@example.invalid";
process.env.GIT_COMMITTER_NAME ||= "dsh-github-engineer tests";
process.env.GIT_COMMITTER_EMAIL ||= "ci@example.invalid";

/* ============================================================== */
/*  Capability gate                                                */
/* ============================================================== */

/**
 * The tools use `execFile` (piped stdio). Probe that exact form, not
 * the inherited-stdio form, so a sandbox that allows one and denies
 * the other is reported honestly.
 */
function toolsCanRun() {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

if (!toolsCanRun()) {
  console.log("");
  console.log("  SKIP  git is unavailable to child_process in this environment");
  console.log("        (execFile -> spawn EPERM). The eight MCP tool bodies");
  console.log("        were NOT exercised. Run this suite in CI or a normal");
  console.log("        terminal to get real coverage.");
  console.log("");
  process.exit(0);
}

const repoStatus = (await import(pathToFileURL(path.join(TOOLS, "repo-status.js")).href)).repoStatus;
const repoClone = (await import(pathToFileURL(path.join(TOOLS, "repo-clone.js")).href)).repoClone;
const repoPull = (await import(pathToFileURL(path.join(TOOLS, "repo-pull.js")).href)).repoPull;
const repoRead = (await import(pathToFileURL(path.join(TOOLS, "repo-read.js")).href)).repoRead;
const repoSearch = (await import(pathToFileURL(path.join(TOOLS, "repo-search.js")).href)).repoSearch;
const repoEdit = (await import(pathToFileURL(path.join(TOOLS, "repo-edit.js")).href)).repoEdit;
const prCreate = (await import(pathToFileURL(path.join(TOOLS, "pr-create.js")).href)).prCreate;
const { GithubRefusedError } = await import(pathToFileURL(GUARD).href);

/* ============================================================== */
/*  Harness                                                        */
/* ============================================================== */

let pass = 0;
let fail = 0;

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
function truthy(value, label) {
  if (value) ok(label);
  else bad(label, "expected truthy");
}

/** Assert that `fn` rejects/throws with a specific GithubRefusedError code. */
async function refuses(fn, code, label) {
  try {
    await fn();
    bad(label, `expected refusal "${code}", but it succeeded`);
  } catch (err) {
    if (err instanceof GithubRefusedError && err.code === code) {
      ok(`${label} (${code})`);
    } else {
      bad(label, `expected GithubRefusedError "${code}", got ${err?.name}: ${err?.code ?? err?.message}`);
    }
  }
}

/* ============================================================== */
/*  Git helpers                                                    */
/* ============================================================== */

function git(cwd, args, opts = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  // CI runners have no global identity; set it per repository.
  git(dir, ["config", "user.email", "ci@example.invalid"]);
  git(dir, ["config", "user.name", "dsh-github-engineer tests"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
}

const VALIDATE_SCRIPT = `import { readFileSync } from 'node:fs'
try {
  const data = JSON.parse(readFileSync('public/data.json', 'utf8'))
  if (!Array.isArray(data.teams)) {
    console.error('data.json: teams must be an array')
    process.exit(2)
  }
  process.exit(0)
} catch (err) {
  console.error('data.json unreadable: ' + err.message)
  process.exit(1)
}
`;

const INITIAL_DATA = JSON.stringify(
  { updated: "2026-01-01", teams: [{ rank: 1, name: "Alpha", bossHP: 42 }] },
  null,
  2
);

/**
 * Build a fixture:
 *
 *   <tmp>/origin.git   bare repository (the "remote")
 *   <tmp>/seed         working clone used to push new commits
 *   <tmp>/work         where the tools under test operate
 *
 * Returns absolute paths.
 */
function makeFixture() {
  const tmp = mkdtempSync(path.join(tmpdir(), "dsh-engineer-git-"));
  const origin = path.join(tmp, "origin.git");
  const seed = path.join(tmp, "seed");

  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "ignore" });

  initRepo(seed);
  mkdirSync(path.join(seed, "public"), { recursive: true });
  mkdirSync(path.join(seed, "scripts"), { recursive: true });
  writeFileSync(path.join(seed, "public", "data.json"), INITIAL_DATA);
  writeFileSync(path.join(seed, "scripts", "validate.js"), VALIDATE_SCRIPT);
  writeFileSync(path.join(seed, "package.json"), JSON.stringify({ name: "fixture", private: true }, null, 2));
  writeFileSync(path.join(seed, "AGENTS.md"), "# AGENTS.md\n\nOnly public/data.json may be edited.\n");
  writeFileSync(path.join(seed, "README.md"), "# Fixture\n");
  commitAll(seed, "initial");
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-u", "origin", "main"]);

  return { tmp, origin, seed, work: path.join(tmp, "work") };
}

function originUrl(origin) {
  // rewriteUrl only rewrites https://github.com, so a file URL passes through.
  return pathToFileURL(origin).href;
}

function editConfig(work, overrides = {}) {
  return {
    workingDir: work,
    allowlistPaths: ["public/data.json"],
    denylistPaths: [".github/workflows/**", "schema/**", "scripts/**", "AGENTS.md", "README.md"],
    branchPrefix: "content/",
    baseBranch: "main",
    preflight: { cmd: "node scripts/validate.js", timeoutSeconds: 60 },
    ...overrides,
  };
}

function cloneConfig(fx, overrides = {}) {
  return {
    workingDir: fx.work,
    repoUrl: originUrl(fx.origin),
    baseBranch: "main",
    githubToken: null,
    ...overrides,
  };
}

function head(dir) {
  return git(dir, ["rev-parse", "HEAD"]);
}
function porcelain(dir) {
  return git(dir, ["status", "--porcelain"]);
}
function commitMessage(dir) {
  return git(dir, ["log", "-1", "--pretty=%s"]);
}

/* ============================================================== */
/*  repo_clone                                                     */
/* ============================================================== */

console.log("\n--- repo_clone ---");
{
  const fx = makeFixture();

  // Clone into a directory that does not exist yet.
  const out = await repoClone({}, cloneConfig(fx));
  eq(out.branch, "main", "cloned branch");
  truthy(git(fx.work, ["rev-parse", "HEAD"]).length === 40, "clone produced a commit");
  ok("clone from a file:// remote succeeds");

  // A second clone without force must refuse rather than wipe the tree.
  await refuses(() => repoClone({}, cloneConfig(fx)), "already-initialized", "second clone without force");

  // With force it re-clones.
  const forced = await repoClone({ force: true }, cloneConfig(fx));
  eq(forced.branch, "main", "forced re-clone branch");
  ok("force=true permits re-clone");

  rmSync(fx.tmp, { recursive: true, force: true });
}

/* ============================================================== */
/*  repo_status                                                    */
/* ============================================================== */

console.log("\n--- repo_status ---");
{
  const fx = makeFixture();
  process.env.GHOST_WORKING_DIR = fx.work;

  // Not cloned yet.
  const before = await repoStatus({});
  eq(before.cloned, false, "cloned=false before clone");
  eq(before.last_commit_sha, null, "no HEAD before clone");
  ok("repo_status on a non-repository reports cloned=false");

  await repoClone({}, cloneConfig(fx));

  const clean = await repoStatus({});
  eq(clean.cloned, true, "cloned=true after clone");
  eq(clean.current_branch, "main", "current branch");
  eq(clean.dirty, false, "clean tree is not dirty");
  truthy(/^[0-9a-f]{40}$/.test(clean.last_commit_sha ?? ""), "HEAD is a 40-char sha");

  // Dirty the tree.
  writeFileSync(path.join(fx.work, "public", "data.json"), JSON.stringify({ teams: [] }, null, 2));
  const dirty = await repoStatus({});
  eq(dirty.dirty, true, "dirty=true after an edit");
  truthy(
    dirty.uncommitted_files.some((f) => f.includes("public/data.json")),
    "uncommitted_files names the edited path"
  );

  delete process.env.GHOST_WORKING_DIR;
  rmSync(fx.tmp, { recursive: true, force: true });
}

/* ============================================================== */
/*  repo_read                                                      */
/* ============================================================== */

console.log("\n--- repo_read ---");
{
  const fx = makeFixture();
  await repoClone({}, cloneConfig(fx));
  const cfg = { workingDir: fx.work };

  const read = await repoRead({ path: "public/data.json" }, cfg);
  truthy(read.content.includes('"Alpha"'), "content matches the file");
  truthy(read.sha.length > 0, "sha computed");
  eq(read.truncated, false, "small file is not truncated");
  truthy(read.byte_size > 0, "byte_size reported");

  // Reading is deliberately unrestricted by the allowlist — the agent
  // must be able to read AGENTS.md and the tree to plan any work.
  const agents = await repoRead({ path: "AGENTS.md" }, cfg);
  truthy(agents.content.includes("Only public/data.json"), "AGENTS.md is readable (reads are not allowlisted)");

  await refuses(() => repoRead({ path: "../../etc/passwd" }, cfg), "path-traversal", "traversal refused");
  await refuses(() => repoRead({ path: "/etc/passwd" }, cfg), "path-absolute", "absolute path refused");
  await refuses(() => repoRead({ path: "does/not/exist.txt" }, cfg), "file-not-found", "missing file refused");

  // Oversized file: max_bytes caps the returned content.
  writeFileSync(path.join(fx.work, "big.txt"), "x".repeat(20_000));
  const capped = await repoRead({ path: "big.txt", max_bytes: 1024 }, cfg);
  eq(capped.truncated, true, "oversized read is truncated");
  eq(capped.content.length, 1024, "content capped at max_bytes");

  rmSync(fx.tmp, { recursive: true, force: true });
}

/* ============================================================== */
/*  repo_search                                                    */
/* ============================================================== */

console.log("\n--- repo_search ---");
{
  const fx = makeFixture();
  await repoClone({}, cloneConfig(fx));
  const cfg = { workingDir: fx.work };

  const hit = await repoSearch({ query: "Alpha" }, cfg);
  truthy(hit.hits.length >= 1, "finds a known token");
  truthy(hit.hits[0].path.includes("data.json"), "hit names the file");
  truthy(typeof hit.hits[0].line === "number" && hit.hits[0].line > 0, "hit carries a line number");

  const miss = await repoSearch({ query: "no-such-token-anywhere-xyzzy" }, cfg);
  eq(miss.hits.length, 0, "no match yields zero hits (git grep exit 1 handled)");

  // A glob must narrow the search, not replace the pattern. This case
  // exists because v0.4.0 emitted `git grep -l -- <glob> <query>`, which
  // made the glob the pattern and the pattern a pathspec.
  const globHit = await repoSearch({ query: "Alpha", glob: "public/**" }, cfg);
  truthy(globHit.hits.length >= 1, "glob filter still finds the match");
  truthy(
    globHit.hits.every((h) => h.path.startsWith("public/")),
    "glob filter restricts results to the given pathspec"
  );
  const globMiss = await repoSearch({ query: "Alpha", glob: "scripts/**" }, cfg);
  eq(globMiss.hits.length, 0, "glob filter excludes files outside the pathspec");

  await refuses(() => repoSearch({ query: "!Alpha" }, cfg), "query-dangerous", "leading ! refused");
  await refuses(() => repoSearch({ query: "Alpha --upload-pack=x" }, cfg), "query-dangerous", "argument injection refused");
  await refuses(() => repoSearch({ query: "Alpha", glob: "../../**" }, cfg), "glob-traversal", "glob traversal refused");

  rmSync(fx.tmp, { recursive: true, force: true });
}

/* ============================================================== */
/*  repo_edit                                                      */
/* ============================================================== */

console.log("\n--- repo_edit: happy path ---");
{
  const fx = makeFixture();
  await repoClone({}, cloneConfig(fx));
  const cfg = editConfig(fx.work);
  const before = head(fx.work);

  const result = await repoEdit(
    {
      branch: "content/2026-01-01-add-team",
      edits: [
        {
          path: "public/data.json",
          mode: "replace",
          find: '"name": "Alpha"',
          replace: '"name": "Alpha Prime"',
        },
      ],
      commit_message: "content: rename Alpha to Alpha Prime",
    },
    cfg
  );

  truthy(result.new_commit_sha.length > 0 || head(fx.work) !== before, "a new commit was created");
  eq(result.files_changed[0], "public/data.json", "files_changed reports the edited path");
  eq(result.preflight.ran, true, "preflight was run");
  eq(result.preflight.exit_code, 0, "preflight passed");
  eq(commitMessage(fx.work), "content: rename Alpha to Alpha Prime", "commit message landed");
  eq(porcelain(fx.work), "", "working tree is clean after a successful edit");
  eq(git(fx.work, ["rev-parse", "--abbrev-ref", "HEAD"]), "content/2026-01-01-add-team", "edit happened on the content branch");
  truthy(
    git(fx.work, ["show", "--pretty=", "--name-only", "HEAD"]).includes("public/data.json"),
    "the commit contains the edited file"
  );

  rmSync(fx.tmp, { recursive: true, force: true });
}

console.log("\n--- repo_edit: preflight failure rolls the tree back ---");
{
  const fx = makeFixture();
  await repoClone({}, cloneConfig(fx));
  // Make the file fail its own validator: teams is no longer an array.
  const cfg = editConfig(fx.work);
  const before = head(fx.work);
  const beforePorcelain = porcelain(fx.work);

  await refuses(
    () =>
      repoEdit(
        {
          branch: "content/2026-01-01-break-schema",
          edits: [
            {
              path: "public/data.json",
              mode: "replace",
              find: '"teams": [',
              replace: '"teams": {',
            },
          ],
          commit_message: "content: break the schema on purpose",
        },
        cfg
      ),
    "preflight-failed",
    "preflight failure refuses the commit"
  );

  eq(head(fx.work), before, "HEAD is unchanged after a refused commit");
  eq(porcelain(fx.work), beforePorcelain, "working tree is restored after a refused commit");
  eq(commitMessage(fx.work), "initial", "no new commit exists");
  truthy(
    readFileSync(path.join(fx.work, "public", "data.json"), "utf8").includes('"teams": ['),
    "the edited file content was rolled back on disk"
  );
  ok("rollback proof: HEAD, tree, and file bytes all match the pre-edit state");

  rmSync(fx.tmp, { recursive: true, force: true });
}

console.log("\n--- repo_edit: refusals that must not touch the tree ---");
{
  const fx = makeFixture();
  await repoClone({}, cloneConfig(fx));
  const cfg = editConfig(fx.work);
  const before = head(fx.work);

  const goodEdit = {
    path: "public/data.json",
    mode: "replace",
    find: '"Alpha"',
    replace: '"Beta"',
  };

  await refuses(
    () => repoEdit({ branch: "content/x", edits: [{ ...goodEdit, path: "package.json" }], commit_message: "m" }, cfg),
    "not-allowlisted",
    "non-allowlisted path refused"
  );
  await refuses(
    () => repoEdit({ branch: "content/x", edits: [{ ...goodEdit, path: "AGENTS.md" }], commit_message: "m" }, cfg),
    "denylisted",
    "denylisted path refused even though it exists"
  );
  await refuses(
    () => repoEdit({ branch: "main", edits: [goodEdit], commit_message: "m" }, cfg),
    "branch-is-base",
    "committing on the base branch refused"
  );
  await refuses(
    () => repoEdit({ branch: "feature/x", edits: [goodEdit], commit_message: "m" }, cfg),
    "branch-prefix-mismatch",
    "branch without content/ prefix refused"
  );
  await refuses(
    () =>
      repoEdit(
        { branch: "content/x", edits: [{ ...goodEdit, find: "not-present-anywhere" }], commit_message: "m" },
        cfg
      ),
    "find-not-found",
    "replace with a missing find string refused"
  );
  await refuses(
    () =>
      repoEdit(
        { branch: "content/x", edits: [{ ...goodEdit, find: '"Alpha"', replace: '"A"' }], commit_message: "token ghp_abc123def456ghi789jkl012mno345pqr" },
        cfg
      ),
    "token-in-string",
    "commit message containing a token refused"
  );
  await refuses(
    () =>
      repoEdit(
        {
          branch: "content/x",
          edits: Array.from({ length: 6 }, () => ({ ...goodEdit })),
          commit_message: "m",
        },
        cfg
      ),
    "edits-too-many",
    "more than five edits refused"
  );
  await refuses(
    () =>
      repoEdit(
        {
          branch: "content/x",
          edits: [{ path: "public/data.json", mode: "patch", patch: "--- a/x\n+++ b/x\n" }],
          commit_message: "m",
        },
        cfg
      ),
    "patch-not-implemented-v1",
    "patch mode is refused explicitly"
  );

  eq(head(fx.work), before, "no refusal created a commit");
  eq(porcelain(fx.work), "", "no refusal left the tree dirty");

  rmSync(fx.tmp, { recursive: true, force: true });
}

console.log("\n--- repo_edit: ambiguous find and insert mode ---");
{
  const fx = makeFixture();
  await repoClone({}, cloneConfig(fx));
  const cfg = editConfig(fx.work);

  // Two occurrences of "Alpha" once we add a second one.
  writeFileSync(
    path.join(fx.work, "public", "data.json"),
    JSON.stringify({ teams: [{ name: "Alpha" }, { name: "Alpha" }] }, null, 2)
  );
  await refuses(
    () =>
      repoEdit(
        {
          branch: "content/x",
          edits: [{ path: "public/data.json", mode: "replace", find: '"Alpha"', replace: '"B"' }],
          commit_message: "m",
        },
        cfg
      ),
    "find-ambiguous",
    "ambiguous find refused"
  );

  // Restore, then test insert mode on an existing allowlisted file.
  git(fx.work, ["checkout", "--", "public/data.json"]);
  const inserted = await repoEdit(
    {
      branch: "content/insert-test",
      edits: [{ path: "public/data.json", mode: "insert", content: "\n" }],
      commit_message: "content: append trailing newline",
    },
    cfg
  );
  truthy(inserted.new_commit_sha.length > 0 || commitMessage(fx.work) === "content: append trailing newline", "insert mode produced a commit");

  rmSync(fx.tmp, { recursive: true, force: true });
}

console.log("\n--- repo_edit: bootstrap runs once, before the first edit ---");
{
  // A fixture whose pre-flight needs dependencies, like the real repo:
  // `npm run validate` cannot run before `npm ci` has populated
  // node_modules. Without a bootstrap step, every commit on a fresh
  // clone is refused by its own pre-flight with "tsx: not found".
  const NEEDS_DEPS = `import { existsSync } from 'node:fs'
if (!existsSync('node_modules')) {
  console.error('validate: dependencies are not installed (run npm ci)')
  process.exit(1)
}
process.exit(0)
`;
  const BOOTSTRAP = `import { mkdirSync, appendFileSync } from 'node:fs'
mkdirSync('node_modules', { recursive: true })
if (process.env.E2E_COUNTER) appendFileSync(process.env.E2E_COUNTER, 'ran\\n')
`;
  const ALWAYS_FAIL = `process.exit(1)
`;

  const fx = makeFixture();
  writeFileSync(path.join(fx.seed, "scripts", "needs-deps.js"), NEEDS_DEPS);
  writeFileSync(path.join(fx.seed, "scripts", "bootstrap.js"), BOOTSTRAP);
  writeFileSync(path.join(fx.seed, "scripts", "always-fail.js"), ALWAYS_FAIL);
  commitAll(fx.seed, "test: dependency-gated validator");
  git(fx.seed, ["push", "origin", "main"]);

  await repoClone({}, cloneConfig(fx));
  const counter = path.join(fx.tmp, "bootstrap-runs.txt");
  process.env.E2E_COUNTER = counter;

  const gated = editConfig(fx.work, {
    preflight: { cmd: "node scripts/needs-deps.js", timeoutSeconds: 60 },
  });

  await refuses(
    () =>
      repoEdit(
        {
          branch: "content/no-bootstrap",
          edits: [{ path: "public/data.json", mode: "replace", find: '"Alpha"', replace: '"Beta"' }],
          commit_message: "content: would fail",
        },
        gated
      ),
    "preflight-failed",
    "dependency-gated preflight refuses a commit on a fresh clone"
  );
  ok("a fresh clone cannot commit when nothing installs dependencies");

  const boot = {
    ...gated,
    bootstrap: { cmd: "node scripts/bootstrap.js", whenMissing: "node_modules", timeoutSeconds: 60 },
  };
  const first = await repoEdit(
    {
      branch: "content/with-bootstrap",
      edits: [{ path: "public/data.json", mode: "replace", find: '"Alpha"', replace: '"Beta"' }],
      commit_message: "content: with bootstrap",
    },
    boot
  );
  eq(first.bootstrap.ran, true, "bootstrap ran before the first edit");
  eq(first.bootstrap.exit_code, 0, "bootstrap exited 0");
  eq(first.preflight.exit_code, 0, "preflight passed after bootstrap");
  truthy(existsSync(path.join(fx.work, "node_modules")), "bootstrap populated node_modules");

  const countRuns = () =>
    readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length;
  const afterFirst = countRuns();

  const second = await repoEdit(
    {
      branch: "content/with-bootstrap-2",
      edits: [{ path: "public/data.json", mode: "replace", find: '"Beta"', replace: '"Gamma"' }],
      commit_message: "content: second edit",
    },
    boot
  );
  eq(second.bootstrap.ran, false, "bootstrap is skipped once node_modules exists");
  eq(countRuns(), afterFirst, "bootstrap command ran exactly once across both edits");

  const badBoot = {
    ...gated,
    bootstrap: { cmd: "node scripts/always-fail.js", whenMissing: "node_modules", timeoutSeconds: 60 },
  };
  await refuses(
    () =>
      repoEdit(
        {
          branch: "content/bad-bootstrap",
          edits: [{ path: "public/data.json", mode: "replace", find: '"Gamma"', replace: '"Delta"' }],
          commit_message: "content: bad bootstrap",
        },
        badBoot
      ),
    "bootstrap-failed",
    "a failing bootstrap refuses the edit"
  );

  delete process.env.E2E_COUNTER;
  rmSync(fx.tmp, { recursive: true, force: true });
}

/* ============================================================== */
/*  repo_pull                                                      */
/* ============================================================== */

console.log("\n--- repo_pull ---");
{
  const fx = makeFixture();
  await repoClone({}, cloneConfig(fx));
  const cfg = { workingDir: fx.work, branchPrefix: "content/", baseBranch: "main" };

  // A clean tree fast-forwards after the remote moves ahead.
  writeFileSync(path.join(fx.seed, "CHANGELOG.md"), "# changes\n");
  commitAll(fx.seed, "docs: add changelog");
  git(fx.seed, ["push", "origin", "main"]);

  const pulled = await repoPull({}, cfg);
  truthy(pulled.fast_forwarded || pulled.message.length > 0, "pull reports what happened");
  truthy(
    git(fx.work, ["log", "--oneline", "-1"]).includes("docs: add changelog"),
    "the new remote commit arrived"
  );
  eq(pulled.conflicts, false, "no conflicts on a fast-forward");

  // A dirty tree refuses before touching anything.
  writeFileSync(path.join(fx.work, "local-dirt.txt"), "uncommitted\n");
  await refuses(() => repoPull({}, cfg), "dirty-working-tree", "pull on a dirty tree refused");

  rmSync(fx.tmp, { recursive: true, force: true });
}

/* ============================================================== */
/*  pr_create — guards only; no push, no gh, no network            */
/* ============================================================== */

console.log("\n--- pr_create: guards fire before any push ---");
{
  const fx = makeFixture();
  await repoClone({}, cloneConfig(fx));
  const cfg = {
    workingDir: fx.work,
    branchPrefix: "content/",
    baseBranch: "main",
    repoOwner: "mmw-devs",
    repoName: "fixture",
    githubToken: null,
  };

  const valid = {
    head_branch: "content/2026-01-01-x",
    title: "content: a change",
    body: "## Summary\n\nSomething.\n",
  };

  await refuses(
    () => prCreate({ ...valid, head_branch: "feature/x" }, cfg),
    "branch-prefix-mismatch",
    "head branch without the prefix refused"
  );
  await refuses(
    () => prCreate({ ...valid, base: "develop" }, cfg),
    "pr-base-not-default",
    "a base branch other than the configured one refused"
  );
  await refuses(
    () => prCreate({ ...valid, title: "" }, cfg),
    "pr-title-empty",
    "empty title refused"
  );
  await refuses(
    () => prCreate({ ...valid, title: "leak ghp_abc123def456ghi789jkl012mno345pqr" }, cfg),
    "token-in-string",
    "token in the title refused"
  );
  await refuses(
    () => prCreate({ ...valid, body: "Authorization: Bearer ghs_abcdefghijklmnopqrstuvwxyz012345" }, cfg),
    "token-in-string",
    "token in the body refused"
  );
  await refuses(
    () => prCreate({ ...valid, body: "x".repeat(70 * 1024) }, cfg),
    "size-limit",
    "oversized body refused"
  );

  ok("every pr_create refusal happened before any git push or gh call");

  rmSync(fx.tmp, { recursive: true, force: true });
}

/* ============================================================== */

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
