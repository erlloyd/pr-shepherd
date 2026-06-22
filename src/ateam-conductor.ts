import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ShepherdConfig } from "./types.js";

// Parses PR identity from pr-shepherd formatted messages.
// Tries GitHub URL first, then the "#N (owner/repo)" form present in all format* messages.
function parsePRIdentity(
  message: string,
): { owner: string; repo: string; prNumber: number; prUrl?: string } | null {
  // Try GitHub PR URL: https://github.com/<owner>/<repo>/pull/<n>
  const urlMatch = message.match(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      prNumber: parseInt(urlMatch[3], 10),
      prUrl: urlMatch[0],
    };
  }

  // Try "#N (owner/repo)" form used by formatCI/Review/etc. messages
  const shortMatch = message.match(/#(\d+)\s+\(([\w.-]+\/[\w.-]+)\)/);
  if (shortMatch) {
    const [ownerPart, repoPart] = shortMatch[2].split("/");
    return {
      owner: ownerPart,
      repo: repoPart,
      prNumber: parseInt(shortMatch[1], 10),
    };
  }

  return null;
}

function fetchHeadBranch(prNumber: number, nameWithOwner: string): string {
  try {
    const result = execFileSync(
      "gh",
      ["pr", "view", String(prNumber), "-R", nameWithOwner, "--json", "headRefName", "-q", ".headRefName"],
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
    return result || "unknown";
  } catch (err) {
    console.log(`[pr-shepherd] failed to fetch head branch for #${prNumber} (${nameWithOwner}): ${(err as Error).message}`);
    return "unknown";
  }
}

export function routeToAgent(
  config: ShepherdConfig,
  message: string,
  opts?: { reviewRequest?: boolean },
): void {
  const identity = parsePRIdentity(message);
  if (!identity) {
    console.log("[pr-shepherd] couldn't parse PR identity from message; skipping ateam route-pr-event");
    return;
  }

  const { owner, repo, prNumber, prUrl } = identity;
  const nameWithOwner = `${owner}/${repo}`;
  const transition = opts?.reviewRequest ? "review_requested" : "other";
  const headBranch = fetchHeadBranch(prNumber, nameWithOwner);
  const ateam = process.env.PR_SHEPHERD_ATEAM_PATH ?? "ateam";

  if (config.dryRun) {
    console.log(`[pr-shepherd] [dry-run] would route PR #${prNumber} (${nameWithOwner}) to ateam route-pr-event`);
    return;
  }

  const tmpFile = join(tmpdir(), `pr-shepherd-body-${Date.now()}-${prNumber}.txt`);
  try {
    writeFileSync(tmpFile, message, "utf-8");

    const args = [
      "route-pr-event",
      "--repo", nameWithOwner,
      "--pr-number", String(prNumber),
      "--head-branch", headBranch,
      "--transition", transition,
      "--body-file", tmpFile,
    ];

    if (prUrl) {
      args.push("--pr-url", prUrl);
    }

    execFileSync(ateam, args, { encoding: "utf-8", timeout: 30_000 });
  } catch (err) {
    console.log(`[pr-shepherd] ateam route-pr-event failed for PR #${prNumber}: ${(err as Error).message}`);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}
