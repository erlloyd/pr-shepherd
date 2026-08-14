import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { sendToAgent } from "./notifications.js";
import { appendEvent } from "./events.js";
import {
  fetchPRView,
  fetchUserReviews,
  hasNewCommitsSince,
  belongsToOrg,
} from "./github.js";
import { createLogger } from "./log.js";
import type { ShepherdConfig, ReviewFollowUp, PREventRecord } from "./types.js";

const log = createLogger("review-followup");

function followUpPath(dataDir: string): string {
  return join(dataDir, "review-followups.json");
}

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readFollowUps(dataDir: string): ReviewFollowUp[] {
  const path = followUpPath(dataDir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw) as ReviewFollowUp[];
  } catch {
    log.warn(`Corrupt review-followups file, treating as empty`);
    return [];
  }
}

export function writeFollowUps(dataDir: string, items: ReviewFollowUp[]): void {
  const path = followUpPath(dataDir);
  ensureDir(path);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(items, null, 2) + "\n");
  renameSync(tmp, path);
}

function followUpKey(number: number, repo: string): string {
  return `${repo}#${number}`;
}

type RawSearchResult = {
  number: number;
  repository: { nameWithOwner: string };
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  state: string;
};

function discoverReviewedPRs(username: string, org?: string | null): RawSearchResult[] {
  const args = [
    "search",
    "prs",
    `--reviewed-by=${username}`,
    "--state=open",
    "--json",
    "number,repository,title,url,isDraft,updatedAt,state",
    "--limit",
    "50",
  ];
  if (org) args.push(`--owner=${org}`);
  const json = execFileSync("gh", args, { encoding: "utf-8", timeout: 30_000 }).trim();
  return JSON.parse(json) as RawSearchResult[];
}

export async function pollReviewFollowUps(config: ShepherdConfig): Promise<number | null> {
  if (!config.reviewFollowUp.enabled || !config.reviewInbox.githubUser) return null;

  const username = config.reviewInbox.githubUser;

  try {
    const org = config.github.org;
    const reviewed = discoverReviewedPRs(username, org).filter((pr) =>
      belongsToOrg(pr.repository.nameWithOwner, org),
    );
    const existing = readFollowUps(config.dataDir);
    const existingKeys = new Set(existing.map((f) => followUpKey(f.number, f.repo)));

    let updated = false;

    for (const pr of reviewed) {
      if (pr.isDraft) continue;

      const key = followUpKey(pr.number, pr.repository.nameWithOwner);

      if (existingKeys.has(key)) continue;

      const userReviews = fetchUserReviews(
        pr.number,
        pr.repository.nameWithOwner,
        username,
      );
      const changesRequested = userReviews
        .filter((r) => r.state === "CHANGES_REQUESTED")
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

      if (changesRequested.length === 0) continue;

      const latestApproval = userReviews
        .filter((r) => r.state === "APPROVED")
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];

      if (
        latestApproval &&
        latestApproval.submittedAt > changesRequested[0].submittedAt
      ) {
        continue;
      }

      const prView = fetchPRView(pr.number, pr.repository.nameWithOwner);

      const followUp: ReviewFollowUp = {
        number: pr.number,
        repo: pr.repository.nameWithOwner,
        title: pr.title,
        url: pr.url,
        ourReviewSubmittedAt: changesRequested[0].submittedAt,
        headShaAtReview: prView.headRefOid,
        lastKnownHeadSha: prView.headRefOid,
        notifiedForReReviewAt: null,
        status: "watching",
      };

      existing.push(followUp);
      existingKeys.add(key);
      updated = true;
      log.info(`Now tracking PR #${pr.number} (${pr.repository.nameWithOwner}) for re-review follow-up.`);
    }

    for (const followUp of existing) {
      if (!belongsToOrg(followUp.repo, org)) continue;
      if (followUp.status !== "watching" && followUp.status !== "re_review_requested") continue;

      try {
        const prView = fetchPRView(followUp.number, followUp.repo);

        if (prView.state !== "OPEN") {
          followUp.status = "closed";
          updated = true;
          log.info(`PR #${followUp.number} (${followUp.repo}) closed/merged — removing from follow-up.`);
          continue;
        }

        const userReviews = fetchUserReviews(followUp.number, followUp.repo, username);
        const latestApproval = userReviews
          .filter((r) => r.state === "APPROVED")
          .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];

        if (
          latestApproval &&
          latestApproval.submittedAt > followUp.ourReviewSubmittedAt
        ) {
          followUp.status = "approved";
          updated = true;
          log.info(`PR #${followUp.number} (${followUp.repo}) — we approved. Removing from follow-up.`);
          continue;
        }

        if (hasNewCommitsSince(followUp.number, followUp.repo, followUp.ourReviewSubmittedAt)) {
          if (prView.headRefOid !== followUp.lastKnownHeadSha) {
            followUp.lastKnownHeadSha = prView.headRefOid;
            updated = true;
          }

          if (!followUp.notifiedForReReviewAt || prView.headRefOid !== followUp.lastKnownHeadSha) {
            const agent = config.reviewInbox.notifyAgent ?? config.notifications.notifyAgent!;
            const msg = formatReReviewMessage(followUp);

            log.info(`PR #${followUp.number} (${followUp.repo}) has new commits since our review — requesting scoped re-review.`);

            if (!config.dryRun) {
              await sendToAgent(config, agent, msg);
            }

            followUp.notifiedForReReviewAt = new Date().toISOString();
            followUp.status = "re_review_requested";
            updated = true;

            const event: PREventRecord = {
              ts: new Date().toISOString(),
              pr: followUp.number,
              repo: followUp.repo,
              event: "review_requested",
              from: "OPENED",
              to: "OPENED",
              details: { type: "re_review", title: followUp.title, url: followUp.url },
            };
            appendEvent(config.dataDir, event);
          }
        }
      } catch (err) {
        log.error(`Error checking follow-up for PR #${followUp.number}: ${(err as Error).message}`);
      }
    }

    const active = existing.filter(
      (f) => f.status === "watching" || f.status === "re_review_requested",
    );

    if (updated) {
      writeFollowUps(config.dataDir, active);
    }

    if (active.length > 0) {
      log.debug(`Tracking ${active.length} PR(s) for re-review follow-up.`);
    }

    return active.length;
  } catch (err) {
    log.error(`Error polling review follow-ups: ${(err as Error).message}`);
    return null;
  }
}

function formatReReviewMessage(followUp: ReviewFollowUp): string {
  return [
    `[PR Shepherd] Re-review needed: PR #${followUp.number} (${followUp.repo})`,
    `"${followUp.title}"`,
    followUp.url,
    "",
    `We previously requested changes (reviewed at ${followUp.ourReviewSubmittedAt}).`,
    "The author has pushed new commits since our review.",
    "",
    "Please dispatch a worker to do a SCOPED re-review:",
    "- ONLY evaluate whether the issues from our previous review have been addressed",
    "- Do NOT raise new issues or expand scope",
    "- If all critical/important issues are resolved or acknowledged, approve the PR",
    "- If the author explicitly declined to fix a non-critical issue, accept it and approve",
  ].join("\n");
}
