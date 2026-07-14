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
