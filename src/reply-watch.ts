import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fetchReviewThreadComments, belongsToOrg } from "./github.js";
import { routeToAgent } from "./ateam-conductor.js";
import { appendEvent } from "./events.js";
import { readCache } from "./state-cache.js";
import { isTerminal } from "./state-machine.js";
import { createLogger } from "./log.js";
import type { ShepherdConfig, ReplyWatchRecord } from "./types.js";
import type { ReviewThreadComment } from "./github.js";

const log = createLogger("reply-watch");

export type NewReply = {
  rootId: number;
  path: string;
  author: string;
  body: string;
  createdAt: string;
};

// Thread-participation detection. A thread is ours if any comment in it is
// authored by githubUser; a new reply is a comment by someone else that is
// newer than BOTH our last comment in that thread (the loop guard — our own
// in-thread response silences the thread until they answer again) and the
// per-PR cursor.
export function findNewReplies(
  comments: ReviewThreadComment[],
  githubUser: string,
  cursor: string | null,
): NewReply[] {
  const user = githubUser.toLowerCase();
  const since = cursor ?? "1970-01-01T00:00:00Z";

  const threads = new Map<number, ReviewThreadComment[]>();
  for (const c of comments) {
    const root = c.inReplyToId ?? c.id;
    const thread = threads.get(root);
    if (thread) thread.push(c);
    else threads.set(root, [c]);
  }

  const replies: NewReply[] = [];
  for (const [rootId, thread] of threads) {
    let ourLast: string | null = null;
    for (const c of thread) {
      if (c.author.toLowerCase() === user && (ourLast === null || c.createdAt > ourLast)) {
        ourLast = c.createdAt;
      }
    }
    if (ourLast === null) continue;

    for (const c of thread) {
      if (c.author.toLowerCase() === user) continue;
      if (c.createdAt <= ourLast) continue;
      if (c.createdAt <= since) continue;
      replies.push({ rootId, path: c.path, author: c.author, body: c.body, createdAt: c.createdAt });
    }
  }

  return replies.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

// authored: true when this target was sourced from the authored-PR state
// cache. daemon.ts's reviewer-comment stream (handleReviewerComments) already
// forwards every inline comment from config.reviews.reviewerUsers on authored
// PRs; reply-watch scanning the same PRs would double-dispatch those replies,
// so authored targets filter them out before dispatch.
type ReplyTarget = { number: number; repo: string; title: string; url: string; authored: boolean };

function replyWatchPath(dataDir: string): string {
  return join(dataDir, "reply-watch.json");
}

export function readReplyWatch(dataDir: string): ReplyWatchRecord[] {
  const path = replyWatchPath(dataDir);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ReplyWatchRecord[];
  } catch {
    log.warn(`Corrupt reply-watch state at ${path}, treating as empty`);
    return [];
  }
}

export function writeReplyWatch(dataDir: string, records: ReplyWatchRecord[]): void {
  const path = replyWatchPath(dataDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n");
  renameSync(tmp, path);
}

function fetchReviewedPRs(githubUser: string, org?: string | null): Array<{
  number: number;
  repository: { nameWithOwner: string };
  title: string;
  url: string;
}> {
  const args = [
    "search", "prs",
    `--reviewed-by=${githubUser}`,
    "--state=open",
    "--json", "number,repository,title,url",
    "--limit", "50",
  ];
  if (org) args.push(`--owner=${org}`);
  const json = execFileSync("gh", args, { encoding: "utf-8", timeout: 30_000 }).trim();
  return JSON.parse(json) as Array<{
    number: number;
    repository: { nameWithOwner: string };
    title: string;
    url: string;
  }>;
}

export function formatReplyMessage(target: ReplyTarget, replies: NewReply[]): string {
  const [owner, name] = target.repo.split("/");
  const blocks = replies.map((r) =>
    [
      `@${r.author} replied in a review-comment thread you participated in (${r.path}, thread ${r.rootId}):`,
      ...r.body.split("\n").map((line) => `> ${line}`),
    ].join("\n"),
  );
  return [
    `[PR Shepherd] Comment reply: PR #${target.number} (${target.repo})`,
    `"${target.title}"`,
    target.url,
    "",
    blocks.join("\n\n"),
    "",
    `Respond in-thread on GitHub: gh api repos/${owner}/${name}/pulls/${target.number}/comments --method POST -f body="..." -F in_reply_to=<thread id above>`,
    "Evaluate before agreeing: check each claim against the actual code — concede only if verified correct, otherwise hold position with the evidence. Answer questions concretely. Do not raise new findings or start new threads.",
  ].join("\n");
}

export async function pollReplyWatch(config: ShepherdConfig): Promise<number | null> {
  if (!config.replyWatch.enabled) return null;
  const githubUser = config.reviewInbox.githubUser ?? config.github.authorUsername;
  if (!githubUser) return null;

  try {
    const org = config.github.org;
    const targets = new Map<string, ReplyTarget>();

    for (const pr of fetchReviewedPRs(githubUser, org)) {
      if (config.reviewInbox.ignoreRepos.includes(pr.repository.nameWithOwner)) continue;
      if (!belongsToOrg(pr.repository.nameWithOwner, org)) continue;
      targets.set(`${pr.repository.nameWithOwner}#${pr.number}`, {
        number: pr.number,
        repo: pr.repository.nameWithOwner,
        title: pr.title,
        url: pr.url,
        authored: false,
      });
    }

    // Runs second so authored targets win when a PR is in both populations —
    // the authored-PR stream owns whitelisted reviewer comments on that PR.
    for (const pr of readCache(config.dataDir)) {
      if (isTerminal(pr.state)) continue;
      if (config.github.ignoreRepos.includes(pr.repo)) continue;
      if (!belongsToOrg(pr.repo, org)) continue;
      targets.set(`${pr.repo}#${pr.number}`, {
        number: pr.number,
        repo: pr.repo,
        title: pr.title,
        url: pr.url,
        authored: true,
      });
    }

    const state = readReplyWatch(config.dataDir);
    const byKey = new Map(state.map((r) => [`${r.repo}#${r.number}`, r]));
    const next: ReplyWatchRecord[] = [];
    let updated = false;

    const reviewerUsers = new Set((config.reviews.reviewerUsers ?? []).map((u) => u.toLowerCase()));

    for (const [key, target] of targets) {
      const existing = byKey.get(key);

      // First-run seeding: with no state file the first poll would dispatch
      // every historically unanswered reply across up to 50 PRs — a
      // thundering herd of reopened initiatives. Seed the cursor to now and
      // skip scanning this poll; replies arriving after discovery flow
      // normally on the next poll.
      if (!existing) {
        next.push({
          number: target.number,
          repo: target.repo,
          lastReplyNotifiedAt: new Date().toISOString(),
        });
        updated = true;
        continue;
      }

      const record = existing;
      next.push(record);

      try {
        const comments = fetchReviewThreadComments(target.number, target.repo);
        let replies = findNewReplies(comments, githubUser, record.lastReplyNotifiedAt);
        if (replies.length === 0) continue;

        // The reviewer-comment stream in daemon.ts owns whitelisted
        // reviewers' comments on authored PRs; reply-watch would
        // double-dispatch them if it forwarded the same replies here.
        if (target.authored) {
          replies = replies.filter((r) => !reviewerUsers.has(r.author.toLowerCase()));
          if (replies.length === 0) continue;
        }

        if (config.dryRun) {
          log.info(`[dry-run] would forward ${replies.length} repl${replies.length === 1 ? "y" : "ies"} on PR #${target.number} (${target.repo})`);
          continue;
        }

        const msg = formatReplyMessage(target, replies);
        if (routeToAgent(config, msg, { transition: "comment_reply" })) {
          record.lastReplyNotifiedAt = replies[replies.length - 1].createdAt;
          updated = true;
          log.info(`Forwarded ${replies.length} repl${replies.length === 1 ? "y" : "ies"} on PR #${target.number} (${target.repo})`);

          appendEvent(config.dataDir, {
            ts: new Date().toISOString(),
            pr: target.number,
            repo: target.repo,
            event: "comment_reply",
            from: "OPENED",
            to: "OPENED",
            details: { type: "reply_watch", rootIds: replies.map((r) => r.rootId), authors: replies.map((r) => r.author) },
          });
        } else {
          log.info(`Dispatch failed for PR #${target.number} (${target.repo}) — will retry next poll`);
        }
      } catch (err) {
        log.error(`Error scanning PR #${target.number} (${target.repo}): ${(err as Error).message}`);
      }
    }

    if (!config.dryRun && (updated || next.length !== state.length)) {
      writeReplyWatch(config.dataDir, next);
    }

    return targets.size;
  } catch (err) {
    log.error(`Error polling reply watch: ${(err as Error).message}`);
    return null;
  }
}
