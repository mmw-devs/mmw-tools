#!/usr/bin/env node
// mcp-server/tests/pr-preview.test.mjs
//
// The preview parser is the only part of pr_preview that can be wrong
// without a network, so it is tested against the real summary shape that
// Cloudflare Pages produces (captured from ffxiv-race-ops PR #25).

import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist", "tools", "pr-preview.js");

if (!existsSync(DIST)) {
  console.error("Run `pnpm build` in mcp-server first.");
  process.exit(2);
}

const { parsePreviewUrls } = await import(pathToFileURL(DIST).href);

let pass = 0;
let fail = 0;
const ok = (l) => { pass++; console.log(`  PASS  ${l}`); };
const bad = (l, d) => { fail++; console.error(`  FAIL  ${l}${d ? `: ${d}` : ""}`); };
const eq = (a, w, label) => (a === w ? ok(`${label} = ${JSON.stringify(w)}`) : bad(label, `expected ${JSON.stringify(w)}, got ${JSON.stringify(a)}`));

const SUMMARY = `<table><tr><td><strong>Latest commit:</strong> </td><td>
<code>111d885</code>
</td></tr><tr><td><strong>Status:</strong></td><td>&nbsp;✅&nbsp; Deploy successful!</td></tr><tr><td><strong>Preview URL:</strong></td><td>
<a href='https://1a311e26.ffxiv-race-stats.pages.dev'>https://1a311e26.ffxiv-race-stats.pages.dev</a>
</td></tr><tr><td><strong>Branch Preview URL:</strong></td><td>
<a href='https://content-2026-10-29-add-conte.ffxiv-race-stats.pages.dev'>https://content-2026-10-29-add-conte.ffxiv-race-stats.pages.dev</a>
</td></tr></table>

[View logs](https://dash.cloudflare.com/?to=/b299b2b7b4d38b4ade52afab7d5729e6/pages/view/ffxiv-race-stats/1a311e26-50df-4a1a-8e9a-30cc0f199480)`;

console.log("\n--- the real Cloudflare summary ---");
{
  const urls = parsePreviewUrls(SUMMARY);
  eq(urls.previewUrl, "https://1a311e26.ffxiv-race-stats.pages.dev/", "commit preview URL");
  eq(
    urls.branchPreviewUrl,
    "https://content-2026-10-29-add-conte.ffxiv-race-stats.pages.dev/",
    "branch preview URL"
  );
  // The bug this guards: "Preview URL" is a substring of "Branch Preview URL".
  eq(
    urls.previewUrl === urls.branchPreviewUrl,
    false,
    "the two links are not confused with each other"
  );
}

console.log("\n--- missing or hostile input ---");
{
  const empty = parsePreviewUrls(null);
  eq(empty.previewUrl, null, "null summary -> no commit URL");
  eq(empty.branchPreviewUrl, null, "null summary -> no branch URL");

  const noLinks = parsePreviewUrls("<table><tr><td>Deploy queued</td></tr></table>");
  eq(noLinks.previewUrl, null, "summary without links -> no URL");

  const httpOnly = parsePreviewUrls("<strong>Preview URL:</strong> <a href='http://evil.pages.dev'>x</a>");
  eq(httpOnly.previewUrl, null, "http is refused");

  const wrongHost = parsePreviewUrls("<strong>Preview URL:</strong> <a href='https://evil.example.com/'>x</a>");
  eq(wrongHost.previewUrl, null, "a non-pages.dev host is refused");

  const lookalike = parsePreviewUrls("<strong>Preview URL:</strong> <a href='https://pages.dev.evil.com/'>x</a>");
  eq(lookalike.previewUrl, null, "a lookalike host is refused");

  const javascript = parsePreviewUrls("<strong>Preview URL:</strong> <a href='javascript:alert(1)'>x</a>");
  eq(javascript.previewUrl, null, "javascript: is refused");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
