import assert from "node:assert/strict";
import test from "node:test";
import { decideBranch, matchesKeepPattern } from "./prune-merged-branches.mjs";

const NOW = Date.parse("2026-01-10T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function mergedDaysAgo(days) {
  return {
    number: 42,
    merged_at: new Date(NOW - days * DAY).toISOString(),
    html_url: "https://github.com/mmw-devs/mmw-tools/pull/42",
  };
}

function decide(overrides = {}) {
  return decideBranch({
    name: "feat/example",
    base: "main",
    mergedPr: mergedDaysAgo(8),
    openPrs: [],
    protectedBranch: "unprotected",
    fullyMerged: true,
    hasReference: false,
    now: NOW,
    minAgeDays: 7,
    keepPatterns: ["release/*", "hotfix/*"],
    ...overrides,
  });
}

test("deletes a fully merged, unreferenced branch after the retention window", () => {
  assert.deepEqual(decide(), {
    action: "delete",
    reason: "merged 8 days ago in PR #42",
  });
});

test("keeps the branch inside the retention window", () => {
  assert.equal(decide({ mergedPr: mergedDaysAgo(6) }).action, "keep");
});

test("keeps a branch with no merged PR", () => {
  assert.equal(decide({ mergedPr: null }).action, "keep");
});

test("keeps a branch that still has commits outside the base", () => {
  assert.equal(decide({ fullyMerged: false }).action, "keep");
});

test("keeps a branch used by an open PR", () => {
  assert.equal(
    decide({ openPrs: [{ number: 7, head: { ref: "feat/example" } }] }).action,
    "keep"
  );
});

test("keeps a branch that is the base of an open PR", () => {
  assert.equal(
    decide({ openPrs: [{ number: 8, base: { ref: "feat/example" } }] }).action,
    "keep"
  );
});

test("keeps a protected branch", () => {
  assert.equal(decide({ protectedBranch: "protected" }).action, "keep");
});

test("keeps a branch when protection cannot be read", () => {
  assert.equal(decide({ protectedBranch: "unknown" }).action, "keep");
});

test("keeps a branch referenced by workflow or config", () => {
  assert.equal(decide({ hasReference: true }).action, "keep");
});

test("keeps release and hotfix branches", () => {
  assert.equal(decide({ name: "release/1.0" }).action, "keep");
  assert.equal(decide({ name: "hotfix/auth" }).action, "keep");
});

test("keeps the default branch", () => {
  assert.equal(decide({ name: "main" }).action, "keep");
});

test("keeps an unreadable merge timestamp", () => {
  assert.equal(decide({ mergedPr: { number: 9, merged_at: "not-a-date" } }).action, "keep");
});

test("matches exact and prefix keep patterns", () => {
  assert.equal(matchesKeepPattern("main", "main"), true);
  assert.equal(matchesKeepPattern("release/1.0", "release/*"), true);
  assert.equal(matchesKeepPattern("feature/release/1.0", "release/*"), false);
});
