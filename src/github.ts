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

export type BotComment = {
  author: string;
  body: string;
  createdAt: string;
  hasActionableFindings: boolean;
};

export function fetchBotComments(
  number: number,
  repo: string,
  botUsers: string[],
): BotComment[] {
  if (botUsers.length === 0) return [];
  const [owner, name] = repo.split("/");
  const json = gh([
    "api",
    `repos/${owner}/${name}/issues/${number}/comments`,
    "--jq",
    ".",
  ]);
  const comments = JSON.parse(json) as Array<{
    user: { login: string };
    body: string;
    created_at: string;
  }>;

  const botSet = new Set(botUsers.map((u) => u.toLowerCase()));
  return comments
    .filter((c) => botSet.has(c.user.login.toLowerCase()))
    .map((c) => ({
      author: c.user.login,
      body: c.body,
      createdAt: c.created_at,
      hasActionableFindings: /❌/.test(c.body),
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
  const approvals = latest.filter((r) => r.state === "APPROVED").length;
  const changesRequested = latest.filter(
    (r) => r.state === "CHANGES_REQUESTED",
  );

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
