/**
 * AGENTS.md drift detection.
 *
 * The plugin stores operation rules in two places:
 *
 *   - cordis.patch.yml's repoBinding (the "cache", machine-checkable)
 *   - mmw-devs/ffxiv-race-ops/AGENTS.md (the "authority", free-form)
 *
 * This module fetches AGENTS.md from GitHub and runs a few dumb
 * substring checks. A mismatch warns the operator; it does NOT block.
 *
 * Substring checks are intentionally simple — full parsing would mean
 * committing to an AGENTS.md schema. v2 will introduce a separate
 * machine-readable `.dsh-github-engineer.yaml` instead.
 */

/** Deadline for the AGENTS.md fetch performed at bundle apply. */
const AGENTS_MD_TIMEOUT_MS = 10_000;

export interface RepoBindingLike {
  owner: string;
  name: string;
  branchPrefix: string;
  allowlistPaths: string[];
  preflight?: { cmd?: string };
}

export interface AgentsMdCheck {
  /** True when AGENTS.md was fetched and every check passed. */
  ok: boolean;
  /** True if AGENTS.md was not reachable (treated as a warning, not error). */
  unavailable: boolean;
  /** Per-check results. */
  details: Array<{ label: string; passed: boolean; observed: string }>;
  /** Short summary suitable for logger.warn. */
  summary: string;
}

/**
 * Run the drift check against an already-fetched AGENTS.md body.
 * Exported separately so tests can drive it without HTTP.
 */
export function checkAgentsMd(
  binding: RepoBindingLike,
  agentsMd: string
): AgentsMdCheck {
  const details: AgentsMdCheck["details"] = [];

  // 1. allowlist: every allowlist path must appear in AGENTS.md.
  for (const path of binding.allowlistPaths) {
    const observed = agentsMd.includes(path);
    details.push({
      label: `allowlist contains "${path}"`,
      passed: observed,
      observed: observed ? "yes" : "no",
    });
  }

  // 2. branch prefix.
  const prefixNeedle = binding.branchPrefix.replace(/\/$/, ""); // strip trailing /
  const prefixSeen =
    agentsMd.includes(prefixNeedle) ||
    agentsMd.includes(prefixNeedle.replace(/\/$/, "")) ||
    agentsMd.includes("`" + prefixNeedle + "`");
  details.push({
    label: `branch prefix "${prefixNeedle}" mentioned`,
    passed: prefixSeen,
    observed: prefixSeen ? "yes" : "no",
  });

  // 3. preflight command.
  if (binding.preflight?.cmd) {
    const cmd = binding.preflight.cmd;
    const seen = agentsMd.includes(cmd);
    details.push({
      label: `preflight "${cmd}" mentioned`,
      passed: seen,
      observed: seen ? "yes" : "no",
    });
  }

  const failed = details.filter((d) => !d.passed);
  const ok = failed.length === 0;
  const summary = ok
    ? `AGENTS.md drift check: OK (${details.length} fingerprints matched).`
    : `AGENTS.md drift check: ${failed.length}/${details.length} fingerprints mismatch — review docs/OPERATIONS-SYNC.md: ${failed
        .map((f) => f.label)
        .join("; ")}`;

  return { ok, unavailable: false, details, summary };
}

/**
 * Fetch AGENTS.md from `owner/name@branch` using the supplied token
 * via the GitHub Contents API. Returns `null` on any failure.
 *
 * `token` may be null when the user is not yet authenticated; in that
 * case we still attempt an anonymous read of public repos. GitHub
 * returns 404 for private repos, which is treated as "unavailable".
 */
export async function fetchAgentsMd(
  owner: string,
  name: string,
  branch: string,
  token: string | null
): Promise<string | null> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/AGENTS.md?ref=${encodeURIComponent(branch)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "dsh-github-engineer",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    // Deadline-bound. This runs at bundle apply, and `fetch` has no
    // default timeout: an unreachable api.github.com would leave the
    // drift check pending forever, which holds the process open and
    // silently leaves `engineer_status` reporting "未检查".
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(AGENTS_MD_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: string; encoding?: string };
    if (!data.content || data.encoding !== "base64") return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}