import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  AGENTS_PATH,
  expectedAgentsText,
  evaluateImpact,
  globToRegExp,
  loadManifest,
  normalizePath,
  renderDocMap,
  replaceDocMapBlock,
  validateManifest,
  validateManifestCoverage,
  ROOT,
} from "./doc-impact.mjs";

const fixture = [
  {
    path: "docs/contract.md",
    status: "living",
    defines: "Contract shape.",
    sources: ["contracts/*.json", "src/**"],
  },
  {
    path: "docs/snapshot.md",
    status: "historical",
    defines: "Frozen snapshot.",
    sources: [],
  },
];

test("glob matching treats ** as any depth and * as one segment", () => {
  assert.equal(globToRegExp("src/**").test("src/a.ts"), true);
  assert.equal(globToRegExp("src/**").test("src/deep/a.ts"), true);
  assert.equal(globToRegExp("src/*.ts").test("src/deep/a.ts"), false);
  assert.equal(globToRegExp("**/*.ts").test("a.ts"), true);
  assert.equal(globToRegExp("**/*.ts").test("deep/a.ts"), true);
  assert.equal(globToRegExp("contracts/*.json").test("contracts/tools.json"), true);
});

test("backslashes from a Windows working tree are normalized", () => {
  assert.equal(normalizePath("src\\deep\\a.ts"), "src/deep/a.ts");
  assert.equal(evaluateImpact(fixture, ["src\\deep\\a.ts"]).length, 1);
});

test("a changed source without its document is a violation", () => {
  const violations = evaluateImpact(fixture, ["contracts/tools.json"]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].document, "docs/contract.md");
  assert.deepEqual(violations[0].triggers, ["contracts/tools.json"]);
});

test("updating the document in the same change passes", () => {
  assert.deepEqual(evaluateImpact(fixture, ["contracts/tools.json", "docs/contract.md"]), []);
});

test("unrelated files and snapshots do not trigger", () => {
  assert.deepEqual(evaluateImpact(fixture, ["README.md"]), []);
  assert.deepEqual(evaluateImpact(fixture, ["docs/snapshot.md"]), []);
});

test("one source can trigger one document once", () => {
  const violations = evaluateImpact(fixture, ["src/a.ts", "src/deep/b.ts", "src/c.ts"]);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0].triggers, ["src/a.ts", "src/c.ts", "src/deep/b.ts"]);
});

test("the checked-in manifest is valid and the AGENTS table is current", () => {
  const documents = loadManifest(ROOT);
  assert.deepEqual(validateManifest(documents, ROOT), []);

  const agents = readFileSync(path.join(ROOT, AGENTS_PATH), "utf8");
  assert.equal(
    agents.replace(/\r\n/g, "\n"),
    expectedAgentsText(agents, documents).replace(/\r\n/g, "\n"),
  );
  assert.match(renderDocMap(documents), /`docs\/doc-map\.json`/);
});

test("every tracked markdown file must be listed in the manifest", () => {
  const errors = validateManifestCoverage(fixture, [
    "docs/contract.md",
    "docs/snapshot.md",
    "docs/unmapped.md",
    "contracts/tools.json",
    "src/a.ts",
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /docs\/unmapped\.md: tracked markdown is not listed/);
});

test("a document that is not tracked by git is rejected", () => {
  const errors = validateManifestCoverage(fixture, [
    "docs/snapshot.md",
    "contracts/tools.json",
    "src/a.ts",
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /docs\/contract\.md: document is not tracked by git/);
});

test("a source glob that matches no tracked file is rejected", () => {
  const documents = [{
    path: "docs/contract.md",
    status: "living",
    defines: "Contract shape.",
    sources: ["contracts/*.json", "src/**", "docs/dead-*.md"],
  }];
  const errors = validateManifestCoverage(documents, [
    "docs/contract.md",
    "contracts/tools.json",
    "src/a.ts",
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /source "docs\/dead-\*\.md" matches no tracked file/);
});

test("empty sources are labelled by document status", () => {
  const living = [{ path: "docs/live.md", status: "living", defines: "prose", sources: [] }];
  assert.match(renderDocMap(living), /manual; no automatic trigger/);
  const historical = [{ path: "docs/old.md", status: "historical", defines: "prose", sources: [] }];
  assert.match(renderDocMap(historical), /snapshot; no automatic trigger/);
});

test("replacing the generated block preserves the surrounding rules", () => {
  const original = [
    "# Rules",
    "",
    "<!-- doc-map:start -->",
    "old table",
    "<!-- doc-map:end -->",
    "",
    "tail",
  ].join("\n");
  const replaced = replaceDocMapBlock(original, "new table");
  assert.match(replaced, /^# Rules\n\n<!-- doc-map:start -->\nnew table\n<!-- doc-map:end -->\n\ntail$/);
  assert.throws(() => replaceDocMapBlock("# no markers", "x"), /missing/);
});
