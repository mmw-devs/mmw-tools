import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findPolicyFile,
  readGitRepo,
  repoFromRemote,
  resolveWorkspaceMode,
} from "../lib/gate/workspace-mode.js";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "mmw-workspace-mode-"));
}

function writeOrigin(root, url) {
  const git = path.join(root, ".git");
  mkdirSync(git, { recursive: true });
  writeFileSync(
    path.join(git, "config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n`
  );
}

function writePolicy(root) {
  writeFileSync(path.join(root, ".dsh-mmw-tools.yaml"), "version: 1\n");
}

function registry(...keys) {
  return keys.map((key) => ({ key, workingDir: path.join(tmpdir(), `missing-${key}`) }));
}

test("repoFromRemote understands the common remote forms", () => {
  assert.equal(repoFromRemote("https://github.com/mmw-devs/ffxiv-race-ops.git"), "mmw-devs/ffxiv-race-ops");
  assert.equal(repoFromRemote("git@github.com:mmw-devs/ffxiv-race-ops.git"), "mmw-devs/ffxiv-race-ops");
  assert.equal(repoFromRemote("ssh://git@github.com/mmw-devs/ffxiv-race-ops.git"), "mmw-devs/ffxiv-race-ops");
  assert.equal(repoFromRemote("https://github.com/mmw-devs/ffxiv-race-ops"), "mmw-devs/ffxiv-race-ops");
  assert.equal(repoFromRemote("not a remote"), null);
  assert.equal(repoFromRemote(""), null);
});

test("readGitRepo walks up and reads origin from a normal .git directory", () => {
  const root = tempDir();
  try {
    writeOrigin(root, "https://github.com/mmw-devs/ffxiv-race-ops.git");
    const nested = path.join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    const found = readGitRepo(nested);
    assert.equal(found?.root, root);
    assert.equal(found?.repo, "mmw-devs/ffxiv-race-ops");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readGitRepo follows a .git file into a worktree", () => {
  const root = tempDir();
  try {
    const gitDir = path.join(root, ".git", "worktrees", "wt");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "commondir"), "../..\n");
    writeFileSync(
      path.join(root, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:mmw-devs/ffxiv-race-ops.git\n`
    );
    const worktree = path.join(root, "checkout");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);

    const found = readGitRepo(worktree);
    assert.equal(found?.root, worktree);
    assert.equal(found?.repo, "mmw-devs/ffxiv-race-ops");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findPolicyFile walks up to the nearest rule file", () => {
  const root = tempDir();
  try {
    writePolicy(root);
    const nested = path.join(root, "src");
    mkdirSync(nested);
    assert.equal(findPolicyFile(nested), path.join(root, ".dsh-mmw-tools.yaml"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a registered checkout with its rule file is managed", () => {
  const root = tempDir();
  try {
    writeOrigin(root, "https://github.com/mmw-devs/ffxiv-race-ops.git");
    writePolicy(root);
    const nested = path.join(root, "src");
    mkdirSync(nested);
    const snapshot = resolveWorkspaceMode({
      cwd: nested,
      registry: registry("mmw-devs/ffxiv-race-ops"),
    });
    assert.equal(snapshot.mode, "managed");
    assert.equal(snapshot.repo, "mmw-devs/ffxiv-race-ops");
    assert.equal(snapshot.gitRepo, "mmw-devs/ffxiv-race-ops");
    assert.equal(snapshot.marker, path.join(root, ".dsh-mmw-tools.yaml"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a checkout that is not registered and has no rule file is unmanaged", () => {
  const root = tempDir();
  try {
    writeOrigin(root, "https://github.com/someone/else.git");
    const snapshot = resolveWorkspaceMode({
      cwd: root,
      registry: registry("mmw-devs/ffxiv-race-ops"),
    });
    assert.equal(snapshot.mode, "unmanaged");
    assert.equal(snapshot.gitRepo, "someone/else");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unregistered checkout that carries a rule file is a mismatch", () => {
  const root = tempDir();
  try {
    writeOrigin(root, "https://github.com/someone/else.git");
    writePolicy(root);
    const snapshot = resolveWorkspaceMode({
      cwd: root,
      registry: registry("mmw-devs/ffxiv-race-ops"),
    });
    assert.equal(snapshot.mode, "mismatch");
    assert.match(snapshot.reason, /不在仓库注册表/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a registered checkout without a rule file is a mismatch", () => {
  const root = tempDir();
  try {
    writeOrigin(root, "https://github.com/mmw-devs/ffxiv-race-ops.git");
    const snapshot = resolveWorkspaceMode({
      cwd: root,
      registry: registry("mmw-devs/ffxiv-race-ops"),
    });
    assert.equal(snapshot.mode, "mismatch");
    assert.match(snapshot.reason, /缺少 .dsh-mmw-tools.yaml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a selected repository must match the checkout", () => {
  const root = tempDir();
  try {
    writeOrigin(root, "https://github.com/mmw-devs/ffxiv-race-ops.git");
    writePolicy(root);
    const snapshot = resolveWorkspaceMode({
      cwd: root,
      registry: registry("mmw-devs/ffxiv-race-ops", "mmw-devs/other"),
      selected: "mmw-devs/other",
    });
    assert.equal(snapshot.mode, "mismatch");
    assert.match(snapshot.reason, /不一致/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a selected repository that is already correct stays managed", () => {
  const root = tempDir();
  try {
    writeOrigin(root, "https://github.com/mmw-devs/ffxiv-race-ops.git");
    writePolicy(root);
    const snapshot = resolveWorkspaceMode({
      cwd: root,
      registry: registry("mmw-devs/ffxiv-race-ops"),
      selected: "mmw-devs/ffxiv-race-ops",
    });
    assert.equal(snapshot.mode, "managed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a registered checkout that has not been cloned is bootstrap", () => {
  const root = tempDir();
  try {
    const entry = { key: "mmw-devs/ffxiv-race-ops", workingDir: root };
    const nested = path.join(root, "anything");
    mkdirSync(nested);
    const snapshot = resolveWorkspaceMode({ cwd: nested, registry: [entry] });
    assert.equal(snapshot.mode, "bootstrap");
    assert.equal(snapshot.repo, "mmw-devs/ffxiv-race-ops");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no working directory is unknown, never managed", () => {
  const snapshot = resolveWorkspaceMode({ cwd: undefined, registry: [] });
  assert.equal(snapshot.mode, "unknown");
  assert.match(snapshot.reason, /工作目录/);
});

test("a rule file without an identifiable repository is a mismatch", () => {
  const root = tempDir();
  try {
    writePolicy(root);
    const snapshot = resolveWorkspaceMode({ cwd: root, registry: [] });
    assert.equal(snapshot.mode, "mismatch");
    assert.match(snapshot.reason, /无法识别 Git 仓库归属/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
