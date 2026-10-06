import { execFileSync } from "node:child_process";
import type { CheckStatus, ReviewData, PRSnapshot, ShepherdConfig } from "./types.js";

type RawCheck = {
  name: string;
  state: string;
  bucket: string;
  workflow: string;
};

type RawReview = {
  author: { login: string };
  state: string;
  body: string;
  submittedAt: string;
};

type RawPRView = {
  number: number;
  state: string;
  reviewDecision: string | null;
  mergeStateStatus: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  autoMergeRequest: { mergeMethod: string } | null;
  mergedAt: string | null;
  closedAt: string | null;
  headRefOid: string;
};

function gh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
}

// Defensive re-filter behind the `--owner` search qualifier — gh search
// qualifiers can be lossy. A null/unset org matches everything, preserving
// pre-scoping behavior.
export function belongsToOrg(nameWithOwner: string, org: string | null | undefined): boolean {
  if (!org) return true;
  const owner = nameWithOwner.split("/")[0] ?? "";
  return owner.toLowerCase() === org.toLowerCase();
}

export function fetchPRView(number: number, repo: string): RawPRView {
  const json = gh([
    "pr",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "number,state,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,mergedAt,closedAt,headRefOid",
  ]);
  return JSON.parse(json) as RawPRView;
}

export function fetchChecks(number: number, repo: string): RawCheck[] {
  try {
    const json = gh([
      "pr",
      "checks",
      String(number),
      "-R",
      repo,
      "--json",
      "name,state,bucket,workflow",
    ]);
    return JSON.parse(json) as RawCheck[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no checks reported")) return [];
    throw err;
  }
}

export function fetchReviews(number: number, repo: string): RawReview[] {
  const json = gh([
    "pr",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "reviews",
  ]);
  const data = JSON.parse(json) as { reviews: RawReview[] };
  return data.reviews;
}

export function parseMergeQueueStatus(json: string): boolean {
  const data = JSON.parse(json) as {
    data: { repository: { pullRequest: { isInMergeQueue: boolean } } };
  };
  return data.data.repository.pullRequest.isInMergeQueue;
}

// isInMergeQueue is only exposed via GraphQL, not gh pr view --json.
export function fetchMergeQueueStatus(number: number, repo: string): boolean {
  const [owner, name] = repo.split("/");
  const query =
    "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){isInMergeQueue}}}";
  const json = gh([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ]);
  return parseMergeQueueStatus(json);
}

export function enableAutoMerge(
  number: number,
  repo: string,
  strategy: string,
): void {
  const flag = `--${strategy}`;
  gh(["pr", "merge", String(number), "-R", repo, "--auto", flag]);
}

export function updateBranch(number: number, repo: string): void {
  gh(["pr", "update-branch", String(number), "-R", repo]);
}

export function postComment(number: number, repo: string, body: string): void {
  gh(["pr", "comment", String(number), "-R", repo, "--body", body]);
}

export type IssueComment = {
  author: string;
  body: string;
  createdAt: string;
  hasActionableFindings: boolean;
};

// PR conversation comments (issues/{n}/comments) by the given users. Used by
// the review inbox's waitForBot gate; authored-PR feedback uses fetchPRFeedback.
export function fetchCommentsByUsers(
  number: number,
  repo: string,
  users: string[],
): IssueComment[] {
  if (users.length === 0) return [];
  const [owner, name] = repo.split("/");
  const json = gh(["api", `repos/${owner}/${name}/issues/${number}/comments`, "--jq", "."]);
  const comments = JSON.parse(json) as Array<{
    user: { login: string };
    body: string;
    created_at: string;
  }>;

  const userSet = new Set(users.map((u) => u.toLowerCase()));
  return comments
    .filter((c) => userSet.has(c.user.login.toLowerCase()))
    .map((c) => ({
      author: c.user.login,
      body: c.body,
      createdAt: c.created_at,
      hasActionableFindings: /❌/.test(c.body),
    }));
}

// One piece of feedback text on a PR, from any of the three surfaces GitHub
// stores it on. `key` is unique across surfaces (the three id spaces are
// separate tables, so the surface is part of the key) and is what the unified
// forwarder dedups on.
export type FeedbackItem = {
  key: string;
  kind: "review" | "comment" | "inline";
  id: number;
  author: string;
  body: string;
  createdAt: string;
  // Formal reviews only: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, ...
  verdict: string | null;
  // Inline comments only. threadId is the thread root (what in_reply_to takes).
  path: string | null;
  line: number | null;
  threadId: number | null;
};

type RawUser = { login: string } | null;

function ghPages<T>(path: string): T[] {
  const json = gh(["api", `${path}?per_page=100`, "--paginate", "--slurp"]);
  return (JSON.parse(json) as T[][]).flat();
}

// Every formal review, PR conversation comment, and inline review comment on a
// PR, oldest first. Deleted ("ghost") users come back as user: null and
// unsubmitted reviews have no submitted_at; both are dropped.
export function fetchPRFeedback(number: number, repo: string): FeedbackItem[] {
  const [owner, name] = repo.split("/");
  const base = `repos/${owner}/${name}`;

  type RawReviewItem = { id: number; user: RawUser; state: string; body: string | null; submitted_at: string | null };
  type RawIssueComment = { id: number; user: RawUser; body: string | null; created_at: string };
  type RawInline = RawIssueComment & { in_reply_to_id?: number; path: string; line?: number | null; original_line?: number | null };

  const items: FeedbackItem[] = [];
  for (const r of ghPages<RawReviewItem>(`${base}/pulls/${number}/reviews`)) {
    if (!r.user || !r.submitted_at) continue;
    items.push({
      key: `review:${r.id}`, kind: "review", id: r.id, author: r.user.login, body: r.body ?? "",
      createdAt: r.submitted_at, verdict: r.state, path: null, line: null, threadId: null,
    });
  }
  for (const c of ghPages<RawIssueComment>(`${base}/issues/${number}/comments`)) {
    if (!c.user) continue;
    items.push({
      key: `comment:${c.id}`, kind: "comment", id: c.id, author: c.user.login, body: c.body ?? "",
      createdAt: c.created_at, verdict: null, path: null, line: null, threadId: null,
    });
  }
  for (const c of ghPages<RawInline>(`${base}/pulls/${number}/comments`)) {
    if (!c.user) continue;
    items.push({
      key: `inline:${c.id}`, kind: "inline", id: c.id, author: c.user.login, body: c.body ?? "",
      createdAt: c.created_at, verdict: null, path: c.path,
      line: c.line ?? c.original_line ?? null, threadId: c.in_reply_to_id ?? c.id,
    });
  }
  return items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

export type ReviewThreadComment = {
  id: number;
  inReplyToId: number | null;
  author: string;
  body: string;
  createdAt: string;
  path: string;
};

type RawReviewThreadComment = {
  id: number;
  in_reply_to_id?: number;
  user: { login: string };
  body: string;
  created_at: string;
  path: string;
};

// All inline review-comment thread comments for a PR. Replies carry
// in_reply_to_id pointing at the thread ROOT comment (GitHub flattens
// nesting), so thread grouping is `inReplyToId ?? id`.
//
// `per_page=100` alone caps at one page — on busy PRs the newest comments
// (added last) would fall off first. Paginate with `--slurp`, which is
// available on this gh version (`gh api --help`): it wraps each page's JSON
// array into an outer array, so the result is an array of pages that we
// flatten. (If `--slurp` weren't available, the fallback would be
// `--paginate --jq '.[]'` producing NDJSON, parsed line-by-line.)
export function fetchReviewThreadComments(
  number: number,
  repo: string,
): ReviewThreadComment[] {
  const [owner, name] = repo.split("/");
  const json = gh([
    "api",
    `repos/${owner}/${name}/pulls/${number}/comments?per_page=100`,
    "--paginate",
    "--slurp",
  ]);
  const pages = JSON.parse(json) as RawReviewThreadComment[][];
  const comments = pages.flat();
  return comments.map((c) => ({
    id: c.id,
    inReplyToId: c.in_reply_to_id ?? null,
    author: c.user.login,
    body: c.body,
    createdAt: c.created_at,
    path: c.path,
  }));
}

export function fetchCommits(
  number: number,
  repo: string,
): Array<{ sha: string; date: string; message: string }> {
  const json = gh([
    "pr",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "commits",
  ]);
  const data = JSON.parse(json) as {
    commits: Array<{ oid: string; committedDate: string; messageHeadline: string }>;
  };
  return data.commits.map((c) => ({
    sha: c.oid,
    date: c.committedDate,
    message: c.messageHeadline,
  }));
}

export function fetchUserReviews(
  number: number,
  repo: string,
  username: string,
): Array<{ state: string; submittedAt: string; body: string }> {
  const rawReviews = fetchReviews(number, repo);
  return rawReviews
    .filter((r) => r.author.login.toLowerCase() === username.toLowerCase())
    .map((r) => ({ state: r.state, submittedAt: r.submittedAt, body: r.body }));
}

export function hasNewCommitsSince(
  number: number,
  repo: string,
  since: string,
): boolean {
  const commits = fetchCommits(number, repo);
  const sinceTime = new Date(since).getTime();
  return commits.some((c) => new Date(c.date).getTime() > sinceTime);
}

export function hasReviewerRespondedSince(
  number: number,
  repo: string,
  reviewer: string,
  since: string,
): boolean {
  const reviews = fetchReviews(number, repo);
  const sinceTime = new Date(since).getTime();
  return reviews.some(
    (r) =>
      r.author.login.toLowerCase() === reviewer.toLowerCase() &&
      new Date(r.submittedAt).getTime() > sinceTime,
  );
}

export function parseChecks(
  rawChecks: RawCheck[],
  config: ShepherdConfig,
): CheckStatus[] {
  return rawChecks
    .filter((c) => !config.checks.ignoreChecks.includes(c.name))
    .map((c) => ({
      name: c.name,
      state: c.state,
      bucket: c.bucket as CheckStatus["bucket"],
      workflow: c.workflow,
    }));
}

export function parseReviews(
  rawReviews: RawReview[],
  config: ShepherdConfig,
): ReviewData[] {
  return rawReviews
    .filter((r) => !config.reviews.ignoreUsers.includes(r.author.login))
    .map((r) => ({
      author: r.author.login,
      state: r.state as ReviewData["state"],
      body: r.body,
      submittedAt: r.submittedAt,
    }));
}

export function evaluateChecks(checks: CheckStatus[], config: ShepherdConfig): {
  status: "pass" | "fail" | "pending";
  failed: string[];
  pending: string[];
} {
  const relevant =
    config.checks.requiredChecks.length > 0
      ? checks.filter((c) => config.checks.requiredChecks.includes(c.name))
      : checks.filter((c) => c.bucket !== "skipping");

  const failed = relevant
    .filter((c) => c.bucket === "fail" || c.bucket === "cancel")
    .map((c) => c.name);
  const pending = relevant
    .filter((c) => c.bucket === "pending")
    .map((c) => c.name);

  if (failed.length > 0) return { status: "fail", failed, pending };
  if (pending.length > 0) return { status: "pending", failed, pending };
  return { status: "pass", failed, pending };
}

export function evaluateReviews(reviews: ReviewData[], config: ShepherdConfig): {
  status: "approved" | "changes_requested" | "pending";
  approvals: number;
  changesRequested: ReviewData[];
} {
  const latestByAuthor = new Map<string, ReviewData>();
  for (const review of reviews) {
    const existing = latestByAuthor.get(review.author);
    if (!existing || review.submittedAt > existing.submittedAt) {
      latestByAuthor.set(review.author, review);
    }
  }

  const latest = [...latestByAuthor.values()];
  const approved = latest.filter((r) => r.state === "APPROVED");
  const approvals = approved.length;
  const changesRequested = latest.filter(
    (r) => r.state === "CHANGES_REQUESTED",
  );
  // Review bodies are not surfaced here: the unified feedback forwarder
  // (src/feedback.ts) delivers every review body, of every verdict, itself.
  if (changesRequested.length > 0) {
    return { status: "changes_requested", approvals, changesRequested };
  }
  if (approvals >= config.requiredApprovals) {
    return { status: "approved", approvals, changesRequested: [] };
  }
  return { status: "pending", approvals, changesRequested: [] };
}

export function buildSnapshot(
  prView: RawPRView,
  checks: CheckStatus[],
  reviews: ReviewData[],
): PRSnapshot {
  return {
    number: prView.number,
    state: prView.state as PRSnapshot["state"],
    reviewDecision: prView.reviewDecision,
    mergeStateStatus: prView.mergeStateStatus,
    autoMergeRequest: prView.autoMergeRequest,
    mergedAt: prView.mergedAt,
    closedAt: prView.closedAt,
    headSha: prView.headRefOid,
    checks,
    reviews,
  };
}
