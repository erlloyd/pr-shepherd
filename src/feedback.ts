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

function isAuthor(author: string, config: ShepherdConfig): boolean {
  return !!config.github.authorUsername && author.toLowerCase() === config.github.authorUsername.toLowerCase();
}

// List membership for comment senders: the reviews.reviewerUsers allowlist
// (humans) and the reviews.botUsers list (bots). The PR author's own identity
// is never a sender. Matching is case-insensitive.
export function feedbackSenderRole(author: string, config: ShepherdConfig): SenderRole | null {
  if (isAuthor(author, config)) return null;
  const a = author.toLowerCase();
  if (config.reviews.botUsers.some((u) => u.toLowerCase() === a)) return "bot";
  if (config.reviews.reviewerUsers.some((u) => u.toLowerCase() === a)) return "reviewer";
  return null;
}

// True when the listed-bot attempt cap governs this item: a comment or inline
// comment from a botUsers sender. Formal reviews are never capped.
export function isCappedBotFeedback(item: Pick<FeedbackItem, "kind" | "author">, config: ShepherdConfig): boolean {
  return item.kind !== "review" && feedbackSenderRole(item.author, config) === "bot";
}

// The sender filter, split by surface:
// - Formal reviews (any verdict) with a non-empty body are forwarded from any
//   sender except the PR author. A formal review is a deliberate act, so it
//   is never list-gated, ❌-gated, or capped.
// - PR comments and inline comments are forwarded from reviews.reviewerUsers,
//   and from reviews.botUsers only when the body carries an actionable
//   finding (❌). The bot attempt cap is applied in forwardFeedback because it
//   depends on per-PR state.
// Reply-watch uses this same predicate (with kind "inline") to drop the
// replies this forwarder owns.
export function isForwardableFeedback(
  item: Pick<FeedbackItem, "kind" | "author" | "body">,
  config: ShepherdConfig,
): boolean {
  if (item.body.trim().length === 0) return false;
  if (item.kind === "review") return !isAuthor(item.author, config);
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
    const bot = isCappedBotFeedback(item, config) ? `, ${attempt}` : "";
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
    (i) => !seenSet.has(i.key) && !(botCapped && isCappedBotFeedback(i, config)),
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

  const hasBot = fresh.some((i) => isCappedBotFeedback(i, config));
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
