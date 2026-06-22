import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { sendToAgent } from "./notifications.js";
import { routeToAgent } from "./ateam-conductor.js";
import { appendEvent } from "./events.js";
import { fetchBotComments } from "./github.js";
import type { ShepherdConfig, ReviewAssignment, ReviewAssignmentStatus, PREventRecord } from "./types.js";

type RawSearchResult = {
  number: number;
  repository: { name: string; nameWithOwner: string };
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
};

function inboxPath(dataDir: string): string {
  return join(dataDir, "review-inbox.json");
}

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [review-inbox] ${msg}`);
}

export function readInbox(dataDir: string): ReviewAssignment[] {
  const path = inboxPath(dataDir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw) as ReviewAssignment[];
  } catch {
    console.error(`[pr-shepherd] Corrupt review inbox at ${path}, treating as empty`);
    return [];
  }
}

export function writeInbox(dataDir: string, assignments: ReviewAssignment[]): void {
  const path = inboxPath(dataDir);
  ensureDir(path);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(assignments, null, 2) + "\n");
  renameSync(tmp, path);
}

function inboxKey(number: number, repo: string): string {
  return `${repo}#${number}`;
}

export function hasUserReviewed(number: number, repo: string, githubUser: string): boolean {
  try {
    const json = execFileSync(
      "gh",
      ["pr", "view", String(number), "-R", repo, "--json", "reviews"],
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();
    const { reviews } = JSON.parse(json) as {
      reviews: Array<{ author: { login: string }; state: string }>;
    };
    return reviews.some(
      (r) => r.author.login.toLowerCase() === githubUser.toLowerCase(),
    );
  } catch {
    return false;
  }
}

function getPRState(number: number, repo: string): string {
  try {
    const json = execFileSync(
      "gh",
      ["pr", "view", String(number), "-R", repo, "--json", "state"],
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();
    return (JSON.parse(json) as { state: string }).state;
  } catch {
    return "UNKNOWN";
  }
}

function botHasReviewed(number: number, repo: string, botUsername: string): boolean {
  const comments = fetchBotComments(number, repo, [botUsername]);
  return comments.length > 0;
}

function botAutoApproved(number: number, repo: string, botUsername: string): boolean {
  const comments = fetchBotComments(number, repo, [botUsername]);
  if (comments.length === 0) return false;
  const latest = comments[comments.length - 1];
  return /###\s*✅\s*Auto-approved/i.test(latest.body);
}

export function fetchReviewRequests(githubUser: string): RawSearchResult[] {
  const json = execFileSync(
    "gh",
    [
      "search",
      "prs",
      `--review-requested=${githubUser}`,
      "--state=open",
      "--json",
      "number,repository,title,url,isDraft,updatedAt",
      "--limit",
      "50",
    ],
    { encoding: "utf-8", timeout: 30_000 },
  ).trim();
  return JSON.parse(json) as RawSearchResult[];
}

export async function pollReviewInbox(config: ShepherdConfig): Promise<void> {
  if (!config.reviewInbox.enabled || !config.reviewInbox.githubUser) return;

  try {
    const results = fetchReviewRequests(config.reviewInbox.githubUser);
    const inbox = readInbox(config.dataDir);
    const existingKeys = new Set(inbox.map((a) => inboxKey(a.number, a.repo)));
    const username = config.reviewInbox.githubUser;
    const waitForBot = config.reviewInbox.waitForBot;

    const maxAgeMs = config.reviewInbox.maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAgeMs;
    let updated = false;

    // Discover new assignments
    for (const pr of results) {
      if (config.reviewInbox.ignoreDrafts && pr.isDraft) continue;
      if (config.reviewInbox.ignoreRepos.includes(pr.repository.nameWithOwner)) continue;
      if (new Date(pr.updatedAt).getTime() < cutoff) continue;

      const key = inboxKey(pr.number, pr.repository.nameWithOwner);
      if (existingKeys.has(key)) continue;

      if (hasUserReviewed(pr.number, pr.repository.nameWithOwner, username)) {
        log(`Skipping PR #${pr.number} (${pr.repository.nameWithOwner}) — already reviewed`);
        continue;
      }

      const initialStatus: ReviewAssignmentStatus = waitForBot
        ? "pending_bot_review"
        : "dispatched";

      const assignment: ReviewAssignment = {
        number: pr.number,
        repo: pr.repository.nameWithOwner,
        title: pr.title,
        url: pr.url,
        detectedAt: new Date().toISOString(),
        notifiedAt: null,
        completedAt: null,
        status: initialStatus,
      };

      inbox.push(assignment);
      existingKeys.add(key);
      updated = true;

      if (initialStatus === "pending_bot_review") {
        log(`PR #${pr.number} (${pr.repository.nameWithOwner}) — waiting for ${waitForBot} to review first.`);
      }
    }

    // Process each tracked assignment
    for (const assignment of inbox) {
      if (assignment.status === "review_submitted" ||
          assignment.status === "merged_before_review" ||
          assignment.status === "closed") {
        continue;
      }

      try {
        // Check if PR merged or closed
        const prState = getPRState(assignment.number, assignment.repo);

        if (prState === "MERGED" || prState === "CLOSED") {
          if (assignment.status === "dispatched") {
            const msg = [
              `[PR Shepherd] Review no longer needed: PR #${assignment.number} (${assignment.repo})`,
              `"${assignment.title}"`,
              assignment.url,
              "",
              `This PR has been ${prState.toLowerCase()} before our review was posted.`,
              "Please free the worker assigned to this review — it can be reset for other work.",
            ].join("\n");
            log(`PR #${assignment.number} ${prState.toLowerCase()} before review — notifying to free worker.`);
            if (!config.dryRun) {
              await notifyAgent(config, msg);
            }
            appendEvent(config.dataDir, {
              ts: new Date().toISOString(),
              pr: assignment.number,
              repo: assignment.repo,
              event: "closed",
              from: "OPENED",
              to: "CLOSED",
              details: { type: "review_inbox", reason: `${prState.toLowerCase()}_before_review` },
            });
          }
          assignment.status = prState === "MERGED" ? "merged_before_review" : "closed";
          assignment.completedAt = new Date().toISOString();
          updated = true;
          continue;
        }

        // Check if we've submitted our review
        if (assignment.status === "dispatched" && hasUserReviewed(assignment.number, assignment.repo, username)) {
          const msg = [
            `[PR Shepherd] Review complete: PR #${assignment.number} (${assignment.repo})`,
            `"${assignment.title}"`,
            "",
            "Our review has been submitted. Please free the worker assigned to this review.",
          ].join("\n");
          log(`PR #${assignment.number} — our review has been submitted. Notifying to free worker.`);
          if (!config.dryRun) {
            await notifyAgent(config, msg);
          }
          assignment.status = "review_submitted";
          assignment.completedAt = new Date().toISOString();
          updated = true;
          continue;
        }

        // Handle pending_bot_review → check if bot has posted
        if (assignment.status === "pending_bot_review" && waitForBot) {
          if (!botHasReviewed(assignment.number, assignment.repo, waitForBot)) {
            continue;
          }

          if (botAutoApproved(assignment.number, assignment.repo, waitForBot)) {
            log(`PR #${assignment.number} — ${waitForBot} auto-approved. Skipping human review.`);
            assignment.status = "closed";
            assignment.completedAt = new Date().toISOString();
            updated = true;
            continue;
          }

          log(`PR #${assignment.number} — ${waitForBot} reviewed but did not auto-approve. Dispatching for human review.`);
          assignment.status = "dispatched";
        }

        // Dispatch notification for newly dispatched assignments
        if (assignment.status === "dispatched" && assignment.notifiedAt) {
          log(`[pr-shepherd][debug] PR #${assignment.number} (${assignment.repo}) already notified at ${assignment.notifiedAt} — skipping dispatch`);
        } else if (assignment.status === "dispatched" && !assignment.notifiedAt) {
          const msg = formatReviewAssignmentMessage(assignment);
          if (config.dryRun) {
            log(`[pr-shepherd][debug] [dry-run] would dispatch review of PR #${assignment.number} (${assignment.repo}) to ateam — skipping (notifiedAt NOT persisted)`);
          } else {
            log(`[pr-shepherd][debug] dispatching review of PR #${assignment.number} (${assignment.repo}) to ateam`);
            routeToAgent(config, msg, { reviewRequest: true });
            assignment.notifiedAt = new Date().toISOString();
            updated = true;

            log(`Dispatched: PR #${assignment.number} (${assignment.repo}) — ${assignment.title}`);

            appendEvent(config.dataDir, {
              ts: assignment.notifiedAt,
              pr: assignment.number,
              repo: assignment.repo,
              event: "review_requested",
              from: "OPENED",
              to: "OPENED",
              details: { type: "review_inbox", title: assignment.title, url: assignment.url },
            });
          }
        }
      } catch (err) {
        log(`Error processing assignment PR #${assignment.number}: ${(err as Error).message}`);
      }
    }

    // Prune terminal assignments older than 7 days
    const pruneThreshold = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const active = inbox.filter((a) => {
      if (a.status === "pending_bot_review" || a.status === "dispatched") return true;
      if (a.completedAt && new Date(a.completedAt).getTime() < pruneThreshold) return false;
      return true;
    });

    if (!config.dryRun && (updated || active.length !== inbox.length)) {
      writeInbox(config.dataDir, active);
    }

    const pending = active.filter((a) => a.status === "pending_bot_review").length;
    const dispatched = active.filter((a) => a.status === "dispatched").length;
    if (pending > 0 || dispatched > 0) {
      log(`Active: ${dispatched} dispatched, ${pending} waiting for bot review.`);
    }
  } catch (err) {
    log(`Error polling review inbox: ${(err as Error).message}`);
  }
}

async function notifyAgent(config: ShepherdConfig, message: string): Promise<void> {
  const agent = config.reviewInbox.notifyAgent ?? config.notifications.notifyAgent;
  if (!agent) {
    log("No notify agent configured for review inbox");
    return;
  }
  try {
    await sendToAgent(config, agent, message);
  } catch (err) {
    log(`Failed to notify ${agent}: ${(err as Error).message}`);
  }
}

function formatReviewAssignmentMessage(assignment: ReviewAssignment): string {
  return [
    `[PR Shepherd] Review requested: PR #${assignment.number} (${assignment.repo})`,
    `"${assignment.title}"`,
    assignment.url,
    "",
    "You've been requested as a reviewer. Please dispatch a worker to review this PR and prepare a review report.",
  ].join("\n");
}

export { formatReviewAssignmentMessage };
