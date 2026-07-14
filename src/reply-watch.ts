import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fetchReviewThreadComments } from "./github.js";
import { routeToAgent } from "./ateam-conductor.js";
import { appendEvent } from "./events.js";
import { readCache } from "./state-cache.js";
import { isTerminal } from "./state-machine.js";
import type { ShepherdConfig, ReplyWatchRecord } from "./types.js";
import type { ReviewThreadComment } from "./github.js";

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

type ReplyTarget = { number: number; repo: string; title: string; url: string };

function replyWatchPath(dataDir: string): string {
  return join(dataDir, "reply-watch.json");
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [reply-watch] ${msg}`);
}

export function readReplyWatch(dataDir: string): ReplyWatchRecord[] {
  const path = replyWatchPath(dataDir);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ReplyWatchRecord[];
  } catch {
    console.error(`[pr-shepherd] Corrupt reply-watch state at ${path}, treating as empty`);
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

function fetchReviewedPRs(githubUser: string): Array<{
  number: number;
  repository: { nameWithOwner: string };
  title: string;
  url: string;
}> {
  const json = execFileSync(
    "gh",
    [
      "search", "prs",
      `--reviewed-by=${githubUser}`,
      "--state=open",
      "--json", "number,repository,title,url",
      "--limit", "50",
    ],
    { encoding: "utf-8", timeout: 30_000 },
  ).trim();
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

export async function pollReplyWatch(config: ShepherdConfig): Promise<void> {
  if (!config.replyWatch.enabled) return;
  const githubUser = config.reviewInbox.githubUser ?? config.github.authorUsername;
  if (!githubUser) return;

  try {
    const targets = new Map<string, ReplyTarget>();

    for (const pr of fetchReviewedPRs(githubUser)) {
      if (config.reviewInbox.ignoreRepos.includes(pr.repository.nameWithOwner)) continue;
      targets.set(`${pr.repository.nameWithOwner}#${pr.number}`, {
        number: pr.number,
        repo: pr.repository.nameWithOwner,
        title: pr.title,
        url: pr.url,
      });
    }

    for (const pr of readCache(config.dataDir)) {
      if (isTerminal(pr.state)) continue;
      if (config.github.ignoreRepos.includes(pr.repo)) continue;
      targets.set(`${pr.repo}#${pr.number}`, {
        number: pr.number,
        repo: pr.repo,
        title: pr.title,
        url: pr.url,
      });
    }

    const state = readReplyWatch(config.dataDir);
    const byKey = new Map(state.map((r) => [`${r.repo}#${r.number}`, r]));
    const next: ReplyWatchRecord[] = [];
    let updated = false;

    for (const [key, target] of targets) {
      const record = byKey.get(key) ?? {
        number: target.number,
        repo: target.repo,
        lastReplyNotifiedAt: null,
      };
      if (!byKey.has(key)) updated = true;
      next.push(record);

      try {
        const comments = fetchReviewThreadComments(target.number, target.repo);
        const replies = findNewReplies(comments, githubUser, record.lastReplyNotifiedAt);
        if (replies.length === 0) continue;

        if (config.dryRun) {
          log(`[dry-run] would forward ${replies.length} repl${replies.length === 1 ? "y" : "ies"} on PR #${target.number} (${target.repo})`);
          continue;
        }

        const msg = formatReplyMessage(target, replies);
        routeToAgent(config, msg, { transition: "comment_reply" });
        record.lastReplyNotifiedAt = replies[replies.length - 1].createdAt;
        updated = true;
        log(`Forwarded ${replies.length} repl${replies.length === 1 ? "y" : "ies"} on PR #${target.number} (${target.repo})`);

        appendEvent(config.dataDir, {
          ts: new Date().toISOString(),
          pr: target.number,
          repo: target.repo,
          event: "comment_reply",
          from: "OPENED",
          to: "OPENED",
          details: { type: "reply_watch", rootIds: replies.map((r) => r.rootId), authors: replies.map((r) => r.author) },
        });
      } catch (err) {
        log(`Error scanning PR #${target.number} (${target.repo}): ${(err as Error).message}`);
      }
    }

    if (!config.dryRun && (updated || next.length !== state.length)) {
      writeReplyWatch(config.dataDir, next);
    }
  } catch (err) {
    log(`Error polling reply watch: ${(err as Error).message}`);
  }
}
