import { fetchPRFeedback } from "./github.js";
import { sendToAgent } from "./notifications.js";
import { upsertCachedPR } from "./state-cache.js";
import { createLogger } from "./log.js";
import type { FeedbackItem } from "./github.js";
import type { ShepherdConfig, WatchedPR } from "./types.js";

const log = createLogger("feedback");

// The single path that delivers review feedback text on watched authored PRs
// to the agent. It covers all three GitHub surfaces (formal review bodies of
// every verdict, PR conversation comments, inline review comments), runs in
// every watched non-terminal state, and dedups by item key so each piece of
// feedback is delivered exactly once. State-transition messages (changes
// requested, approved, ...) carry status only, never body text.

type SenderRole = "reviewer" | "bot";

// Who gets forwarded: the reviews.reviewerUsers allowlist (humans) and the
// reviews.botUsers list (bots). Everyone else, including the PR author's own
// identity, is not forwarded. Matching is case-insensitive.
export function feedbackSenderRole(author: string, config: ShepherdConfig): SenderRole | null {
  const a = author.toLowerCase();
  if (config.github.authorUsername && a === config.github.authorUsername.toLowerCase()) return null;
  if (config.reviews.botUsers.some((u) => u.toLowerCase() === a)) return "bot";
  if (config.reviews.reviewerUsers.some((u) => u.toLowerCase() === a)) return "reviewer";
  return null;
}

// Sender filter plus content gates, applied the same way to every surface.
// Listed bots only count when their body carries an actionable finding (❌).
// The bot attempt cap is applied separately, in forwardFeedback, because it
// depends on per-PR state.
export function isForwardableFeedback(
  item: { author: string; body: string },
  config: ShepherdConfig,
): boolean {
  if (item.body.trim().length === 0) return false;
  const role = feedbackSenderRole(item.author, config);
  if (role === "reviewer") return true;
  if (role === "bot") return /❌/.test(item.body);
  return false;
}

// Rollout seed for cache entries written before unified forwarding (no
// forwardedFeedbackIds). Items at or before the seed are recorded as already
// handled; items after it are forwarded.
//
// The seed is the latest legacy comment cursor: the old forwarders were
// scanning this PR and are known to have delivered their surfaces up to that
// point, so anything newer is either undelivered or on a surface they never
// read (such as an approval body below requiredApprovals). With no cursor at
// all, the old forwarders never fired on this PR, and lastEventAt bounds the
// only bodies that could have gone out (those embedded in a transition).
// Timestamps are compared as instants: the legacy cursors are second-precision
// GitHub strings and lastEventAt carries milliseconds.
export function legacyFeedbackSeed(pr: WatchedPR): string | null {
  const cursors = [
    pr.lastCommentedReviewNotifiedAt,
    pr.lastReviewerCommentNotifiedAt,
    pr.lastReviewerReviewCommentNotifiedAt,
    pr.lastBotCommentNotifiedAt,
  ].filter((c): c is string => !!c);
  if (cursors.length > 0) {
    return cursors.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  }
  return pr.lastEventAt ?? null;
}

export function feedbackLabel(item: FeedbackItem): string {
  switch (item.kind) {
    case "review":
      return `${item.verdict ?? "UNKNOWN"} review from @${item.author}`;
    case "comment":
      return `comment from @${item.author}`;
    case "inline": {
      const where = item.path ? ` on ${item.path}${item.line != null ? `:${item.line}` : ""}` : "";
      return `inline comment from @${item.author}${where} (thread ${item.threadId})`;
    }
  }
}

export function formatFeedbackMessage(
  pr: WatchedPR,
  items: FeedbackItem[],
  config: ShepherdConfig,
): string {
  const attempt = `bot feedback attempt ${pr.botFeedbackCount + 1}/${config.botFeedback.maxAttempts}`;
  const blocks = items.map((item) => {
    const bot = feedbackSenderRole(item.author, config) === "bot" ? `, ${attempt}` : "";
    return [`### ${feedbackLabel(item)} (${item.createdAt}${bot})`, "", item.body.trim()].join("\n");
  });
  const [owner, name] = pr.repo.split("/");
  const footer = ["Address anything actionable."];
  if (items.some((i) => i.kind === "inline")) {
    footer.push(
      `Reply to an inline comment in its thread: gh api repos/${owner}/${name}/pulls/${pr.number}/comments --method POST -f body="..." -F in_reply_to=<thread id>`,
    );
  }
  return [
    `[PR Shepherd] PR #${pr.number} (${pr.repo}) — New review feedback (${items.length} item${items.length === 1 ? "" : "s"})`,
    "",
    blocks.join("\n\n---\n\n"),
    "",
    ...footer,
  ].join("\n");
}

// Forwards every not-yet-forwarded feedback item on the PR in one message.
// Returns the number of items forwarded (or, on a dry run, that would be).
// Records the forwarded keys only after delivery succeeds, so a failed route
// retries on the next poll. Throws only if the GitHub fetch fails.
export async function forwardFeedback(config: ShepherdConfig, pr: WatchedPR): Promise<number> {
  const items = fetchPRFeedback(pr.number, pr.repo).filter((i) => isForwardableFeedback(i, config));

  let seen = pr.forwardedFeedbackIds;
  const seeding = seen === undefined;
  if (seen === undefined) {
    const seed = legacyFeedbackSeed(pr);
    const cutoff = seed ? Date.parse(seed) : -Infinity;
    seen = items.filter((i) => Date.parse(i.createdAt) <= cutoff).map((i) => i.key);
    log.info(`PR #${pr.number} (${pr.repo}): seeding feedback dedup at ${seed ?? "(none)"}; ${seen.length} earlier item(s) marked as already handled.`);
  }

  const seenSet = new Set(seen);
  const botCapped = pr.botFeedbackCount >= config.botFeedback.maxAttempts;
  const fresh = items.filter(
    (i) => !seenSet.has(i.key) && !(botCapped && feedbackSenderRole(i.author, config) === "bot"),
  );

  const persistSeen = (keys: string[]) => {
    if (config.dryRun) return;
    pr.forwardedFeedbackIds = keys;
    upsertCachedPR(config.dataDir, pr);
  };

  if (fresh.length === 0) {
    if (seeding) persistSeen(seen);
    return 0;
  }

  const labels = fresh.map(feedbackLabel).join("; ");
  if (config.dryRun) {
    log.info(`[dry-run] would forward ${fresh.length} feedback item(s) on PR #${pr.number}: ${labels}`);
    return fresh.length;
  }

  const hasBot = fresh.some((i) => feedbackSenderRole(i.author, config) === "bot");
  const msg = formatFeedbackMessage(pr, fresh, config);
  const delivered = await sendToAgent(config, config.notifications.notifyAgent!, msg);
  if (!delivered) {
    log.warn(`Feedback delivery failed for PR #${pr.number} (${pr.repo}); will retry next poll.`);
    if (seeding) persistSeen(seen);
    return 0;
  }

  log.info(`Forwarded ${fresh.length} feedback item(s) on PR #${pr.number} (${pr.repo}): ${labels}`);
  if (hasBot) pr.botFeedbackCount++;
  persistSeen([...seen, ...fresh.map((i) => i.key)]);
  return fresh.length;
}
