import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { sendToAgent } from "./notifications.js";
import { appendEvent } from "./events.js";
import {
  postComment,
  fetchPRView,
  hasReviewerRespondedSince,
  belongsToOrg,
} from "./github.js";
import { createLogger } from "./log.js";
import type { ShepherdConfig, ReviewerNudge, PREventRecord } from "./types.js";

const log = createLogger("reviewer-nudge");

function nudgePath(dataDir: string): string {
  return join(dataDir, "reviewer-nudges.json");
}

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readNudges(dataDir: string): ReviewerNudge[] {
  const path = nudgePath(dataDir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw) as ReviewerNudge[];
  } catch {
    log.warn(`Corrupt reviewer-nudges file, treating as empty`);
    return [];
  }
}

export function writeNudges(dataDir: string, items: ReviewerNudge[]): void {
  const path = nudgePath(dataDir);
  ensureDir(path);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(items, null, 2) + "\n");
  renameSync(tmp, path);
}

function nudgeKey(number: number, repo: string, reviewer: string): string {
  return `${repo}#${number}:${reviewer}`;
}

function isBusinessDay(date: Date): boolean {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

function businessHoursSince(since: string, now: Date): number {
  const start = new Date(since);
  let hours = 0;
  const cursor = new Date(start);

  while (cursor < now) {
    if (isBusinessDay(cursor)) {
      const remaining = Math.min(
        (now.getTime() - cursor.getTime()) / (1000 * 60 * 60),
        24,
      );
      hours += remaining;
      cursor.setTime(cursor.getTime() + remaining * 60 * 60 * 1000);
    } else {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
    }
  }

  return hours;
}

function wallHoursSince(since: string, now: Date): number {
  return (now.getTime() - new Date(since).getTime()) / (1000 * 60 * 60);
}

export function registerNudge(
  dataDir: string,
  number: number,
  repo: string,
  reviewer: string,
  fixPushedAt: string,
): void {
  const nudges = readNudges(dataDir);
  const key = nudgeKey(number, repo, reviewer);
  const existing = nudges.find(
    (n) => nudgeKey(n.number, n.repo, n.reviewer) === key,
  );

  if (existing) {
    existing.fixPushedAt = fixPushedAt;
    existing.commentPostedAt = null;
    existing.lastEscalatedAt = null;
    existing.escalationCount = 0;
    existing.status = "pending_comment";
  } else {
    nudges.push({
      number,
      repo,
      reviewer,
      fixPushedAt,
      commentPostedAt: null,
      lastEscalatedAt: null,
      escalationCount: 0,
      status: "pending_comment",
    });
  }

  writeNudges(dataDir, nudges);
}

export async function pollReviewerNudges(config: ShepherdConfig): Promise<number | null> {
  if (!config.reviewerNudge.enabled) return null;

  const nudges = readNudges(config.dataDir);
  const now = new Date();
  let updated = false;

  for (const nudge of nudges) {
    if (!belongsToOrg(nudge.repo, config.github.org)) continue;
    if (nudge.status === "responded" || nudge.status === "closed") continue;

    try {
      const prView = fetchPRView(nudge.number, nudge.repo);

      if (prView.state !== "OPEN") {
        nudge.status = "closed";
        updated = true;
        log.info(`PR #${nudge.number} (${nudge.repo}) closed/merged — removing nudge for @${nudge.reviewer}.`);
        continue;
      }

      if (
        nudge.commentPostedAt &&
        hasReviewerRespondedSince(nudge.number, nudge.repo, nudge.reviewer, nudge.commentPostedAt)
      ) {
        nudge.status = "responded";
        updated = true;
        log.info(`@${nudge.reviewer} responded on PR #${nudge.number} — nudge complete.`);
        continue;
      }

      if (nudge.status === "pending_comment") {
        const comment = `@${nudge.reviewer} — the feedback from your review has been addressed. This PR is ready for re-review when you have a moment.`;

        log.info(`Posting @mention to @${nudge.reviewer} on PR #${nudge.number}.`);
        if (!config.dryRun) {
          try {
            postComment(nudge.number, nudge.repo, comment);
            nudge.commentPostedAt = now.toISOString();
            nudge.status = "waiting";
            updated = true;
          } catch (err) {
            log.error(`Failed to post comment on PR #${nudge.number}: ${(err as Error).message}`);
          }
        } else {
          nudge.commentPostedAt = now.toISOString();
          nudge.status = "waiting";
          updated = true;
        }
        continue;
      }

      if (nudge.status === "waiting" && nudge.commentPostedAt) {
        const reference = nudge.lastEscalatedAt ?? nudge.commentPostedAt;
        const hoursFn = config.reviewerNudge.businessDaysOnly
          ? businessHoursSince
          : wallHoursSince;
        const hours = hoursFn(reference, now);

        if (hours >= config.reviewerNudge.escalateAfterHours) {
          const agent = config.notifications.notifyAgent!;
          const msg = [
            `[PR Shepherd] Reviewer unresponsive: PR #${nudge.number} (${nudge.repo})`,
            "",
            `@${nudge.reviewer} was notified ${nudge.escalationCount > 0 ? `${nudge.escalationCount + 1} times` : "on GitHub"} that review feedback has been addressed, but has not responded after ${Math.round(hours)}h.`,
            "",
            "Please follow up with them directly (e.g., Slack, DM) to unblock this PR.",
          ].join("\n");

          log.info(`Escalating: @${nudge.reviewer} unresponsive on PR #${nudge.number} (${Math.round(hours)}h).`);

          if (!config.dryRun) {
            await sendToAgent(config, agent, msg);
          }

          nudge.lastEscalatedAt = now.toISOString();
          nudge.escalationCount++;
          updated = true;

          const event: PREventRecord = {
            ts: now.toISOString(),
            pr: nudge.number,
            repo: nudge.repo,
            event: "stale_detected",
            from: "AWAITING_REVIEW",
            to: "STALE",
            details: {
              type: "reviewer_nudge_escalation",
              reviewer: nudge.reviewer,
              escalationCount: nudge.escalationCount,
            },
          };
          appendEvent(config.dataDir, event);
        }
      }
    } catch (err) {
      log.error(`Error processing nudge for PR #${nudge.number}: ${(err as Error).message}`);
    }
  }

  const active = nudges.filter(
    (n) => n.status !== "responded" && n.status !== "closed",
  );

  if (updated) {
    writeNudges(config.dataDir, active);
  }

  if (active.length > 0) {
    log.debug(`Tracking ${active.length} reviewer nudge(s).`);
  }

  return active.length;
}
