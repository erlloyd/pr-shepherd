import { execFileSync } from "node:child_process";
import {
  fetchPRView,
  fetchChecks,
  fetchReviews,
  parseChecks,
  parseReviews,
  evaluateChecks,
  evaluateReviews,
  enableAutoMerge,
  updateBranch,
  fetchCommentsByUsers,
  selectNewComments,
  fetchMergeQueueStatus,
} from "./github.js";
import { readCache, upsertCachedPR, removeCachedPR, getCachedPR } from "./state-cache.js";
import { appendEvent } from "./events.js";
import { transition, isTerminal } from "./state-machine.js";
import { sendToAgent } from "./notifications.js";
import { createLogger } from "./log.js";
import { pollReviewInbox } from "./review-inbox.js";
import { pollReviewFollowUps } from "./review-followup.js";
import { pollReplyWatch } from "./reply-watch.js";
import { pollReviewerNudges, registerNudge } from "./reviewer-nudge.js";
import {
  formatCIFailureMessage,
  formatReviewMessage,
  formatApprovalMessage,
  formatMergeMessage,
  formatStaleMessage,
  formatMergeQueueEnteredMessage,
  formatMergeQueueLeftMessage,
} from "./notifications.js";
import type { ShepherdConfig, WatchedPR, PREvent, PRState, PREventRecord } from "./types.js";

const log = createLogger("daemon");

type RawSearchResult = {
  number: number;
  repository: { name: string; nameWithOwner: string };
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
};

function now(): string {
  return new Date().toISOString();
}

function emitEvent(
  config: ShepherdConfig,
  pr: WatchedPR,
  event: PREvent,
  toState: PRState,
  details: Record<string, unknown> = {},
): void {
  const record: PREventRecord = {
    ts: now(),
    pr: pr.number,
    repo: pr.repo,
    event,
    from: pr.state,
    to: toState,
    details,
  };
  appendEvent(config.dataDir, record);
  log.info(`PR #${pr.number} (${pr.repo}): ${pr.state} → ${toState} [${event}]`);
}

function tryTransition(
  config: ShepherdConfig,
  pr: WatchedPR,
  event: PREvent,
  details: Record<string, unknown> = {},
): PRState | null {
  const next = transition(pr.state, event);
  if (!next) return null;

  emitEvent(config, pr, event, next, details);
  pr.state = next;
  pr.lastEventAt = now();
  pr.lastCheckedAt = now();
  upsertCachedPR(config.dataDir, pr);
  return next;
}

export function filterAuthoredPRs(prs: RawSearchResult[], ignoreRepos: string[]): RawSearchResult[] {
  return prs.filter((pr) => !pr.isDraft && !ignoreRepos.includes(pr.repository.nameWithOwner));
}

export function discoverAuthoredPRs(username: string): RawSearchResult[] {
  const json = execFileSync(
    "gh",
    [
      "search",
      "prs",
      `--author=${username}`,
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

async function handleTransition(
  config: ShepherdConfig,
  pr: WatchedPR,
  toState: PRState,
  details: Record<string, unknown>,
): Promise<void> {
  const agent = config.notifications.notifyAgent!;

  try {
    switch (toState) {
      case "CI_FAILED": {
        const failedChecks = (details.failedChecks as string[]) ?? [];
        const msg = formatCIFailureMessage(pr.number, pr.repo, failedChecks);
        if (!config.dryRun) await sendToAgent(config, agent, msg);
        break;
      }
      case "CHANGES_REQUESTED": {
        const reviewer = (details.reviewer as string) ?? "unknown";
        const body = (details.body as string) ?? "";
        const msg = formatReviewMessage(pr.number, pr.repo, reviewer, "CHANGES_REQUESTED", body);
        if (!config.dryRun) await sendToAgent(config, agent, msg);
        break;
      }
      case "APPROVED": {
        const approvals = (details.approvals as number) ?? 0;
        const msg = formatApprovalMessage(pr.number, pr.repo, approvals, config.autoMerge);
        if (config.autoMerge) {
          log.info(`Enabling auto-merge for PR #${pr.number}`);
          if (!config.dryRun) {
            try {
              enableAutoMerge(pr.number, pr.repo, config.mergeStrategy);
            } catch (err) {
              log.error(`Failed to enable auto-merge: ${(err as Error).message}`);
            }
          }
        } else {
          log.info(`PR #${pr.number} approved — flagging for manual merge (auto-merge disabled)`);
        }
        if (!config.dryRun) await sendToAgent(config, agent, msg);
        break;
      }
      case "MERGED": {
        const msg = formatMergeMessage(pr.number, pr.repo);
        removeCachedPR(config.dataDir, pr.number, pr.repo);
        if (!config.dryRun) await sendToAgent(config, agent, msg);
        break;
      }
      case "CLOSED": {
        removeCachedPR(config.dataDir, pr.number, pr.repo);
        break;
      }
      case "STALE": {
        const hoursStale = (details.hoursStale as number) ?? 0;
        const msg = formatStaleMessage(pr.number, pr.repo, hoursStale);
        if (!config.dryRun) await sendToAgent(config, agent, msg);
        break;
      }
    }
  } catch (err) {
    log.error(`Error handling ${toState} for PR #${pr.number}: ${(err as Error).message}`);
  }
}

// Surface new actionable (❌) findings from configured review bots. Capped at
// botFeedback.maxAttempts so a stuck PR doesn't notify forever. Returns true if
// new feedback was found (whether or not it was sent — dry-run reports without
// consuming the cursor). Mutates + persists pr on a real (non-dry) run.
async function handleBotComments(config: ShepherdConfig, pr: WatchedPR): Promise<boolean> {
  if (pr.botFeedbackCount >= config.botFeedback.maxAttempts) {
    log.debug(`PR #${pr.number} — bot feedback limit reached (${config.botFeedback.maxAttempts}), ignoring further bot findings.`);
    return false;
  }
  const comments = fetchCommentsByUsers(pr.number, pr.repo, config.reviews.botUsers);
  const newActionable = selectNewComments(comments, pr.lastBotCommentNotifiedAt).filter(
    (c) => c.hasActionableFindings,
  );
  if (newActionable.length === 0) return false;

  for (const comment of newActionable) {
    const msg = [
      `[PR Shepherd] PR #${pr.number} (${pr.repo}) — Bot Review Feedback (attempt ${pr.botFeedbackCount + 1}/${config.botFeedback.maxAttempts})`,
      "",
      `Bot: ${comment.author}`,
      "",
      comment.body,
      "",
      "This bot review has actionable findings (❌) that need to be addressed before the PR can be approved.",
    ].join("\n");
    log.info(`Bot feedback from ${comment.author} on PR #${pr.number} (attempt ${pr.botFeedbackCount + 1}/${config.botFeedback.maxAttempts})`);
    if (!config.dryRun) {
      await sendToAgent(config, config.notifications.notifyAgent!, msg);
    }
  }

  if (!config.dryRun) {
    pr.botFeedbackCount++;
    pr.lastBotCommentNotifiedAt = newActionable[newActionable.length - 1].createdAt;
    upsertCachedPR(config.dataDir, pr);
  }
  return true;
}

// Surface new PR comments from whitelisted human reviewers. Unlike bots, every
// comment is forwarded (humans don't use the ❌ convention) and there is no
// attempt cap — dedup is purely by the lastReviewerCommentNotifiedAt cursor.
async function handleReviewerComments(config: ShepherdConfig, pr: WatchedPR): Promise<boolean> {
  // Two independent comment streams with separate cursors: PR conversation
  // comments and inline diff-thread review comments. A reviewer's actionable
  // feedback often lands inline on an approving review, so both must be scanned.
  const issueComments = selectNewComments(
    fetchCommentsByUsers(pr.number, pr.repo, config.reviews.reviewerUsers, "issue"),
    pr.lastReviewerCommentNotifiedAt,
  );
  const reviewComments = selectNewComments(
    fetchCommentsByUsers(pr.number, pr.repo, config.reviews.reviewerUsers, "review"),
    pr.lastReviewerReviewCommentNotifiedAt,
  );
  if (issueComments.length === 0 && reviewComments.length === 0) return false;

  for (const comment of [...issueComments, ...reviewComments]) {
    const msg = [
      `[PR Shepherd] PR #${pr.number} (${pr.repo}) — Reviewer Comment from @${comment.author}`,
      "",
      comment.body,
    ].join("\n");
    log.info(`Reviewer comment from @${comment.author} on PR #${pr.number}`);
    if (!config.dryRun) {
      await sendToAgent(config, config.notifications.notifyAgent!, msg);
    }
  }

  if (!config.dryRun) {
    if (issueComments.length > 0) {
      pr.lastReviewerCommentNotifiedAt = issueComments[issueComments.length - 1].createdAt;
    }
    if (reviewComments.length > 0) {
      pr.lastReviewerReviewCommentNotifiedAt =
        reviewComments[reviewComments.length - 1].createdAt;
    }
    upsertCachedPR(config.dataDir, pr);
  }
  return true;
}

// Handles a live PR view showing MERGED/CLOSED, whatever our cached state.
// Returns true if it matched (and was therefore fully handled + removed from
// cache) so callers can skip further processing for this PR.
async function checkMergedOrClosed(
  config: ShepherdConfig,
  pr: WatchedPR,
  prView: { state: string },
): Promise<boolean> {
  if (prView.state === "MERGED") {
    tryTransition(config, pr, "merged");
    await handleTransition(config, pr, "MERGED", {});
    return true;
  }

  if (prView.state === "CLOSED") {
    tryTransition(config, pr, "closed");
    await handleTransition(config, pr, "CLOSED", {});
    return true;
  }

  return false;
}

export async function pollPR(config: ShepherdConfig, pr: WatchedPR): Promise<void> {
  if (isTerminal(pr.state)) return;

  try {
    const prView = fetchPRView(pr.number, pr.repo);
    const rawChecks = fetchChecks(pr.number, pr.repo);
    const rawReviews = fetchReviews(pr.number, pr.repo);

    const checks = parseChecks(rawChecks, config);
    const reviews = parseReviews(rawReviews, config);

    const reviewSnapshot = evaluateReviews(reviews, config);
    if (reviewSnapshot.approvals > 0) {
      log.info(`PR #${pr.number} (${pr.repo}) has ${reviewSnapshot.approvals}/${config.requiredApprovals} approval(s) — review status: ${reviewSnapshot.status}, PR state: ${pr.state}`);
    }

    if (await checkMergedOrClosed(config, pr, prView)) return;

    if (pr.headSha && prView.headRefOid !== pr.headSha) {
      pr.headSha = prView.headRefOid;
      upsertCachedPR(config.dataDir, pr);
      tryTransition(config, pr, "new_commit");

      if (config.reviewerNudge.enabled) {
        const reviews = parseReviews(rawReviews, config);
        const changesRequestedBy = reviews
          .filter((r) => r.state === "CHANGES_REQUESTED")
          .map((r) => r.author);
        const uniqueReviewers = [...new Set(changesRequestedBy)];
        for (const reviewer of uniqueReviewers) {
          registerNudge(config.dataDir, pr.number, pr.repo, reviewer, new Date().toISOString());
          log.info(`Registered reviewer nudge for @${reviewer} on PR #${pr.number}`);
        }
      }
    }

    if (pr.state === "OPENED") {
      tryTransition(config, pr, "poll_started");
    }

    if (!pr.headSha) {
      pr.headSha = prView.headRefOid;
      upsertCachedPR(config.dataDir, pr);
    }

    if (prView.mergeable === "CONFLICTING") {
      if (!pr.lastConflictNotifiedAt) {
        const msg = `[PR Shepherd] PR #${pr.number} (${pr.repo}) — Merge conflicts detected. The branch cannot be merged or updated automatically. Please resolve conflicts manually.`;
        log.info(`PR #${pr.number} has merge conflicts — escalating.`);
        if (!config.dryRun) {
          await sendToAgent(config, config.notifications.notifyAgent!, msg);
          pr.lastConflictNotifiedAt = now();
          upsertCachedPR(config.dataDir, pr);
        }
      }
    } else if (pr.lastConflictNotifiedAt) {
      pr.lastConflictNotifiedAt = null;
      upsertCachedPR(config.dataDir, pr);
    }

    if (pr.state === "CI_PENDING") {
      if (!config.mergeQueue.enabled && prView.autoMergeRequest && prView.mergeStateStatus === "BEHIND" && prView.mergeable === "MERGEABLE") {
        log.info(`PR #${pr.number} is behind base branch while CI is running — updating branch now (CI will restart).`);
        if (!config.dryRun) {
          try {
            updateBranch(pr.number, pr.repo);
            log.info(`Branch updated for PR #${pr.number}.`);
          } catch (err) {
            log.error(`Failed to update branch for PR #${pr.number}: ${(err as Error).message}`);
          }
        }
      } else {
        const checkResult = evaluateChecks(checks, config);
        if (checkResult.status === "pass") {
          tryTransition(config, pr, "ci_passed");
        } else if (checkResult.status === "fail") {
          const details = { failedChecks: checkResult.failed };
          tryTransition(config, pr, "ci_failed", details);
          await handleTransition(config, pr, "CI_FAILED", details);
        }
      }
    }

    if (pr.state === "APPROVED" && prView.autoMergeRequest) {
      tryTransition(config, pr, "auto_merge_enabled");
    }

    if (pr.state === "AUTO_MERGE_ENABLED") {
      const checkResult = evaluateChecks(checks, config);
      if (checkResult.status === "fail") {
        const details = { failedChecks: checkResult.failed };
        tryTransition(config, pr, "ci_failed", details);
        await handleTransition(config, pr, "CI_FAILED", details);
      }

      if (prView.mergeStateStatus === "BEHIND" && prView.mergeable === "MERGEABLE") {
        if (config.mergeQueue.enabled) {
          log.debug(`PR #${pr.number} is behind base branch — merge queue handles rebasing, skipping update-branch.`);
        } else {
          log.info(`PR #${pr.number} is behind base branch — updating branch.`);
          if (!config.dryRun) {
            try {
              updateBranch(pr.number, pr.repo);
              log.info(`Branch updated for PR #${pr.number}.`);
            } catch (err) {
              log.error(`Failed to update branch for PR #${pr.number}: ${(err as Error).message}`);
            }
          }
        }
      }
    }

    // Merge queue membership is a GitHub-side fact, not something shepherd
    // drives — a human can queue a PR themselves after reviewing it (even
    // with fewer approvals than `requiredApprovals`), independent of our own
    // AUTO_MERGE_ENABLED gating. Queue entry implies approval, so if we
    // haven't modeled that yet (PR still AWAITING_REVIEW/STALE), synthesize
    // the all_approved transition first — same side effects a normal
    // approval gets.
    if (config.mergeQueue.enabled && pr.state !== "IN_MERGE_QUEUE") {
      if (fetchMergeQueueStatus(pr.number, pr.repo)) {
        if (pr.state === "AWAITING_REVIEW" || pr.state === "STALE") {
          const reviewResult = evaluateReviews(reviews, config);
          const details = { approvals: reviewResult.approvals };
          tryTransition(config, pr, "all_approved", details);
          await handleTransition(config, pr, "APPROVED", details);
        }

        const next = tryTransition(config, pr, "entered_merge_queue");
        if (next) {
          log.info(`PR #${pr.number} entered the merge queue.`);
          const msg = formatMergeQueueEnteredMessage(pr.number, pr.repo);
          if (!config.dryRun) await sendToAgent(config, config.notifications.notifyAgent!, msg);
        } else {
          log.warn(`PR #${pr.number} is in the merge queue but shepherd's state (${pr.state}) can't model queue entry — skipping transition.`);
        }
      }
    } else if (config.mergeQueue.enabled && !fetchMergeQueueStatus(pr.number, pr.repo)) {
      tryTransition(config, pr, "left_queue");
      log.info(`PR #${pr.number} left the merge queue without merging — escalating.`);
      const msg = formatMergeQueueLeftMessage(pr.number, pr.repo);
      if (!config.dryRun) await sendToAgent(config, config.notifications.notifyAgent!, msg);
    }

    if (
      pr.state === "CI_PASSED" ||
      pr.state === "AWAITING_REVIEW" ||
      pr.state === "STALE"
    ) {
      const ciRecheck = evaluateChecks(checks, config);
      if (ciRecheck.status === "fail") {
        const details = { failedChecks: ciRecheck.failed };
        tryTransition(config, pr, "ci_failed", details);
        await handleTransition(config, pr, "CI_FAILED", details);
      }

      const currentState = pr.state as string;
      if (isTerminal(pr.state) || currentState === "CI_FAILED" || currentState === "CI_PENDING") {
        // CI regressed or PR closed — skip review processing
      } else {
      const reviewResult = evaluateReviews(reviews, config);

      if (reviewResult.status === "changes_requested") {
        const reviewer = reviewResult.changesRequested[0];
        const details = { reviewer: reviewer.author, body: reviewer.body };
        tryTransition(config, pr, "changes_requested", details);
        await handleTransition(config, pr, "CHANGES_REQUESTED", details);
      } else if (reviewResult.status === "approved") {
        if (prView.autoMergeRequest) {
          tryTransition(config, pr, "all_approved", { approvals: reviewResult.approvals });
          tryTransition(config, pr, "auto_merge_enabled");
        } else {
          const details = { approvals: reviewResult.approvals };
          tryTransition(config, pr, "all_approved", details);
          await handleTransition(config, pr, "APPROVED", details);
        }
      } else if (pr.state === "CI_PASSED") {
        if (reviews.length > 0) {
          tryTransition(config, pr, "review_posted");
        }

        const botNotified = await handleBotComments(config, pr);
        const reviewerNotified = await handleReviewerComments(config, pr);
        if (pr.state === "CI_PASSED" && (botNotified || reviewerNotified)) {
          tryTransition(config, pr, "review_posted");
        }
      } else if (pr.state === "AWAITING_REVIEW") {
        await handleBotComments(config, pr);
        await handleReviewerComments(config, pr);

        const staleHours =
          (Date.now() - new Date(pr.lastEventAt ?? now()).getTime()) /
          (1000 * 60 * 60);
        if (staleHours >= config.staleThresholdHours) {
          const details = { hoursStale: Math.round(staleHours) };
          tryTransition(config, pr, "stale_detected", details);
          await handleTransition(config, pr, "STALE", details);
        }
      }
      }
    }

    pr.lastCheckedAt = now();
    upsertCachedPR(config.dataDir, pr);
  } catch (err) {
    log.error(`Error polling PR #${pr.number} (${pr.repo}): ${(err as Error).message}`);
  }
}

export async function pollAll(config: ShepherdConfig): Promise<number> {
  const username = config.github.authorUsername!;
  log.debug(`Discovering open PRs by @${username}...`);

  let discovered: RawSearchResult[];
  try {
    discovered = discoverAuthoredPRs(username);
  } catch (err) {
    log.error(`Error discovering PRs: ${(err as Error).message}`);
    return 0;
  }

  const openPRs = filterAuthoredPRs(discovered, config.github.ignoreRepos);
  log.debug(`Found ${openPRs.length} open non-draft PR(s).`);

  for (const raw of openPRs) {
    const cached = getCachedPR(config.dataDir, raw.number, raw.repository.nameWithOwner);
    const pr: WatchedPR = cached ?? {
      number: raw.number,
      repo: raw.repository.nameWithOwner,
      title: raw.title,
      url: raw.url,
      state: "OPENED",
      headSha: null,
      lastCheckedAt: null,
      lastEventAt: null,
      lastBotCommentNotifiedAt: null,
      botFeedbackCount: 0,
      lastReviewerCommentNotifiedAt: null,
      lastReviewerReviewCommentNotifiedAt: null,
      lastConflictNotifiedAt: null,
    };

    await pollPR(config, pr);
  }

  // Reconcile cached PRs that dropped out of the open set — this happens
  // whenever a PR merges or closes fast enough (e.g. via a merge queue) that
  // it's already gone from `--state=open` search results by the next poll,
  // meaning pollPR never runs for it again and never sees the MERGED/CLOSED
  // transition. Fetch its live state directly so it still gets notified
  // instead of vanishing from the cache with no signal.
  const openKeys = new Set(openPRs.map((p) => `${p.repository.nameWithOwner}#${p.number}`));
  const cached = readCache(config.dataDir);
  for (const pr of cached) {
    const key = `${pr.repo}#${pr.number}`;
    if (openKeys.has(key) || isTerminal(pr.state)) continue;

    try {
      const prView = fetchPRView(pr.number, pr.repo);
      const handled = await checkMergedOrClosed(config, pr, prView);
      if (!handled) {
        log.info(`PR #${pr.number} (${pr.repo}) missing from open search but still ${prView.state} — leaving cached for next poll.`);
      }
    } catch (err) {
      log.error(`PR #${pr.number} (${pr.repo}) no longer open and its live state could not be fetched (${(err as Error).message}) — removing from cache.`);
      removeCachedPR(config.dataDir, pr.number, pr.repo);
    }
  }

  return openPRs.length;
}

export async function startDaemon(config: ShepherdConfig): Promise<void> {
  log.info(
    `PR Shepherd daemon starting. Poll interval: ${config.pollIntervalSeconds}s, dry-run: ${config.dryRun}`,
  );
  log.info(`Watching PRs by @${config.github.authorUsername}`);
  log.info(`Routing issues to agent: ${config.notifications.notifyAgent}`);
  if (config.reviewInbox.enabled) {
    log.info(`Review inbox enabled for @${config.reviewInbox.githubUser}`);
  }
  if (config.reviewFollowUp.enabled) {
    log.info(`Review follow-up tracking enabled`);
  }
  if (config.reviewerNudge.enabled) {
    log.info(`Reviewer nudge enabled (escalate after ${config.reviewerNudge.escalateAfterHours}h${config.reviewerNudge.businessDaysOnly ? ", business days only" : ""})`);
  }
  if (config.replyWatch.enabled) {
    log.info(`Reply watch enabled for @${config.reviewInbox.githubUser ?? config.github.authorUsername}`);
  }

  async function runCycle(): Promise<void> {
    let failures = 0;

    const safe = async <T>(name: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        log.error(`${name} poll failed: ${(err as Error).message}`);
        failures++;
        return fallback;
      }
    };

    const authored = await safe("authored", 0, () => pollAll(config));
    const inbox = await safe("inbox", null, () => pollReviewInbox(config));
    const followups = await safe("followups", null, () => pollReviewFollowUps(config));
    const nudges = await safe("nudges", null, () => pollReviewerNudges(config));
    const replyTargets = await safe("reply-watch", null, () => pollReplyWatch(config));

    const parts = [`${authored} authored`];
    if (inbox !== null) parts.push(`${inbox.active} inbox${inbox.reReviews > 0 ? ` (${inbox.reReviews} re-review pending)` : ""}`);
    if (followups !== null) parts.push(`${followups} followups`);
    if (nudges !== null) parts.push(`${nudges} nudges`);
    if (replyTargets !== null) parts.push(`${replyTargets} reply-watch`);

    if (failures === 0) {
      log.info(`poll ok — ${parts.join(", ")}`);
    } else {
      log.warn(`poll degraded (${failures} poller(s) failed) — ${parts.join(", ")}`);
    }
  }

  await runCycle();

  setInterval(runCycle, config.pollIntervalSeconds * 1000);
}
