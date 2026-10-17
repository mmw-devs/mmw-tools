/**
 * dsh-github-engineer MCP server — pr_list tool.
 *
 * Lists pull requests on the bound repository. Lower-priority tool;
 * output is structured and goes through redactTokens before return.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  redactTokens,
  GithubRefusedError,
} from "../guard.js";

const execFileAsync = promisify(execFile);

export interface PrListInput {
  state?: "open" | "closed" | "all";
  base?: string;
}

export interface PrListItem {
  number: number;
  title: string;
  state: string;
  head_branch: string;
  base_branch: string;
  url: string;
  created_at: string;
}

export interface PrListOutput {
  items: PrListItem[];
}

export interface PrListConfig {
  workingDir: string;
  baseBranch: string;
  repoOwner: string;
  repoName: string;
}

export async function prList(
  input: PrListInput,
  cfg: PrListConfig
): Promise<PrListOutput> {
  const state = input.state ?? "open";
  const base = input.base ?? cfg.baseBranch;

  const args = [
    "pr", "list",
    "--state", state,
    "--base", base,
    "--json", "number,title,state,headRefName,baseRefName,url,createdAt",
  ];

  let stdout = "";
  try {
    const result = await execFileAsync("gh", args, {
      cwd: cfg.workingDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    throw new GithubRefusedError(
      "pr-list-failed",
      `gh pr list failed: ${(err as Error).message}`
    );
  }

  // gh returns valid JSON array (possibly empty).
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new GithubRefusedError(
      "pr-list-malformed",
      `gh pr list returned non-JSON: ${stdout.slice(0, 200)}`
    );
  }
  if (!Array.isArray(parsed)) {
    return { items: [] };
  }

  const items: PrListItem[] = [];
  for (const row of parsed) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    items.push({
      number: typeof r.number === "number" ? r.number : 0,
      title: redactTokens(typeof r.title === "string" ? r.title : ""),
      state: typeof r.state === "string" ? r.state : "UNKNOWN",
      head_branch: typeof r.headRefName === "string" ? r.headRefName : "",
      base_branch: typeof r.baseRefName === "string" ? r.baseRefName : "",
      url: typeof r.url === "string" ? r.url : "",
      created_at: typeof r.createdAt === "string" ? r.createdAt : "",
    });
  }

  return { items };
}