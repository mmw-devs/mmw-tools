import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GithubRefusedError } from "../guard.js";
import { brokerRead, brokerReadEnabled } from "../broker-read.js";

const execFileAsync = promisify(execFile);

export interface PrPreviewInput {
  pr_number: number;
  /**
   * Seconds to keep looking for the hosting check's preview link. The
   * deployment runs after the push, so a call made right after `pr_create`
   * usually has to wait 20–60 s for it to appear.
   */
  wait_seconds?: number;
}

export interface PrPreviewConfig {
  workingDir: string;
  repoOwner: string;
  repoName: string;
  brokerUrl?: string;
  writeAuthFile?: string;
}

export interface CheckSummary {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PrPreviewResult {
  number: number;
  state: string;
  is_draft: boolean;
  merge_state: string;
  head_ref: string;
  head_sha: string;
  html_url: string;
  /** Immutable URL for the exact commit that was pushed. */
  preview_url: string | null;
  /** Mutable URL for the branch; this is the one to show a human reviewer. */
  branch_preview_url: string | null;
  checks: CheckSummary[];
  waited_seconds: number;
  note: string;
}

/** The hosting integration that publishes previews for this repository. */
const PREVIEW_CHECK_NAME = "Cloudflare Pages";
/** Preview links must live on the hosting provider, not anywhere the page says. */
const PREVIEW_HOST_SUFFIX = "pages.dev";

const MAX_WAIT_SECONDS = 120;
const POLL_INTERVAL_MS = 3_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function gh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    cwd,
    env: { ...process.env },
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

function isPreviewUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (!url.hostname.endsWith(PREVIEW_HOST_SUFFIX)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Pull the two links out of the hosting check's summary.
 *
 * The summary is an HTML table with rows `<strong>Preview URL:</strong>` and
 * `<strong>Branch Preview URL:</strong>`, each followed by an `<a href='…'>`.
 * Kept as a separate exported function because it is the only part of this
 * tool that can be wrong without the network.
 */
export function parsePreviewUrls(summary: string | null | undefined): {
  previewUrl: string | null;
  branchPreviewUrl: string | null;
} {
  if (!summary) return { previewUrl: null, branchPreviewUrl: null };
  const link = (label: string): string | null => {
    const match = new RegExp(`<strong>${label}:</strong>[\\s\\S]{0,400}?href='([^']+)'`).exec(summary);
    return match ? match[1] : null;
  };
  return {
    // `Preview URL` cannot match inside `Branch Preview URL` because the
    // pattern anchors on the full `<strong>` label.
    previewUrl: isPreviewUrl(link("Preview URL")),
    branchPreviewUrl: isPreviewUrl(link("Branch Preview URL")),
  };
}

interface CheckRunsResponse {
  check_runs?: Array<{
    name?: string;
    status?: string;
    conclusion?: string | null;
    output?: { summary?: string | null } | null;
  }>;
}

async function readChecks(
  repo: string,
  sha: string,
  cwd: string
): Promise<{ checks: CheckSummary[]; previewUrl: string | null; branchPreviewUrl: string | null }> {
  const raw = await gh(
    ["api", `repos/${repo}/commits/${sha}/check-runs`, "--jq", ".check_runs"],
    cwd
  );
  let parsed: CheckRunsResponse["check_runs"] = [];
  try {
    parsed = JSON.parse(raw) as CheckRunsResponse["check_runs"];
  } catch {
    parsed = [];
  }

  return summarizeCheckRuns(parsed);
}

function summarizeCheckRuns(
  runs: CheckRunsResponse["check_runs"]
): { checks: CheckSummary[]; previewUrl: string | null; branchPreviewUrl: string | null } {
  const checks: CheckSummary[] = [];
  let previewUrl: string | null = null;
  let branchPreviewUrl: string | null = null;

  for (const run of runs ?? []) {
    checks.push({
      name: run.name ?? "",
      status: run.status ?? "unknown",
      conclusion: run.conclusion ?? null,
    });
    if (run.name === PREVIEW_CHECK_NAME && !branchPreviewUrl) {
      const urls = parsePreviewUrls(run.output?.summary);
      previewUrl = urls.previewUrl;
      branchPreviewUrl = urls.branchPreviewUrl;
    }
  }

  return { checks, previewUrl, branchPreviewUrl };
}

async function readChecksThroughBroker(
  cfg: PrPreviewConfig,
  repo: string,
  number: number
): Promise<{ checks: CheckSummary[]; previewUrl: string | null; branchPreviewUrl: string | null }> {
  const data = await brokerRead<{ check_runs?: CheckRunsResponse["check_runs"] }>(
    { brokerUrl: cfg.brokerUrl ?? "", writeAuthFile: cfg.writeAuthFile ?? "" },
    "/v1/read/checks",
    { repo, number: String(number) }
  );
  return summarizeCheckRuns(data.check_runs);
}

async function viewPrThroughBroker(
  cfg: PrPreviewConfig,
  repo: string,
  number: number
): Promise<PrView> {
  const data = await brokerRead<{ pr?: unknown }>(
    { brokerUrl: cfg.brokerUrl ?? "", writeAuthFile: cfg.writeAuthFile ?? "" },
    "/v1/read/pr",
    { repo, number: String(number) }
  );
  const pr = (data.pr ?? {}) as Record<string, unknown>;
  const head = (pr.head ?? {}) as Record<string, unknown>;
  return {
    number: typeof pr.number === "number" ? pr.number : number,
    state: typeof pr.state === "string" ? pr.state : "UNKNOWN",
    isDraft: pr.draft === true,
    mergeStateStatus: typeof pr.mergeable_state === "string" ? pr.mergeable_state : "UNKNOWN",
    headRefOid: typeof head.sha === "string" ? head.sha : "",
    headRefName: typeof head.ref === "string" ? head.ref : "",
    url: typeof pr.html_url === "string" ? pr.html_url : "",
  };
}

interface PrView {
  number: number;
  state: string;
  isDraft: boolean;
  mergeStateStatus?: string;
  headRefOid: string;
  headRefName: string;
  url: string;
}

/**
 * Read a PR's preview links and check states.
 *
 * This is the step between "PR opened" and "user approves the merge": the
 * hosting integration publishes a preview for the pushed branch, and a human
 * wants that URL before saying yes. Read-only — it never changes the PR.
 */
export async function prPreview(
  input: PrPreviewInput,
  cfg: PrPreviewConfig
): Promise<PrPreviewResult> {
  const repo = `${cfg.repoOwner}/${cfg.repoName}`;
  const number = input.pr_number;
  if (!Number.isInteger(number) || number <= 0) {
    throw new GithubRefusedError("bad-pr-number", `pr_number 必须是正整数，收到 ${String(input.pr_number)}`);
  }

  const requested = Number.isFinite(input.wait_seconds) ? Number(input.wait_seconds) : 0;
  const waitSeconds = Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(requested)));

  const useBroker = brokerReadEnabled({
    brokerUrl: cfg.brokerUrl ?? "",
    writeAuthFile: cfg.writeAuthFile ?? "",
  });

  let view: PrView;
  try {
    view = useBroker
      ? await viewPrThroughBroker(cfg, repo, number)
      : (JSON.parse(
          await gh(
            ["pr", "view", String(number), "--repo", repo, "--json", "number,state,isDraft,mergeStateStatus,headRefOid,headRefName,url"],
            cfg.workingDir
          )
        ) as PrView);
  } catch (err) {
    if (err instanceof GithubRefusedError) throw err;
    throw new GithubRefusedError(
      "pr-not-found",
      `无法读取 PR #${number}：${err instanceof Error ? err.message : String(err)}`
    );
  }

  const startedAt = Date.now();
  const snapshotOf = () =>
    useBroker
      ? readChecksThroughBroker(cfg, repo, number)
      : readChecks(repo, view.headRefOid, cfg.workingDir);
  let snapshot = await snapshotOf();
  while (!snapshot.branchPreviewUrl && !snapshot.previewUrl && Date.now() - startedAt < waitSeconds * 1000) {
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, waitSeconds * 1000 - (Date.now() - startedAt))));
    snapshot = await snapshotOf();
  }

  const waited = Math.round((Date.now() - startedAt) / 1000);
  const hasPreview = Boolean(snapshot.branchPreviewUrl ?? snapshot.previewUrl);
  return {
    number: view.number,
    state: view.state,
    is_draft: view.isDraft,
    merge_state: view.mergeStateStatus ?? "UNKNOWN",
    head_ref: view.headRefName,
    head_sha: view.headRefOid,
    html_url: view.url,
    preview_url: snapshot.previewUrl,
    branch_preview_url: snapshot.branchPreviewUrl,
    checks: snapshot.checks,
    waited_seconds: waited,
    note: hasPreview
      ? "分支预览会随新提交变化；给用户看 branch_preview_url。"
      : `还没有预览：${PREVIEW_CHECK_NAME} 的 check 尚未产出链接（等了 ${waited}s）。CI 跑完后用更大的 wait_seconds 再查一次。`,
  };
}
