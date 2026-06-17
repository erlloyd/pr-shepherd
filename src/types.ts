export type PRState =
  | "OPENED"
  | "CI_PENDING"
  | "CI_PASSED"
  | "CI_FAILED"
  | "AWAITING_REVIEW"
  | "CHANGES_REQUESTED"
  | "APPROVED"
  | "AUTO_MERGE_ENABLED"
  | "STALE"
  | "MERGED"
  | "CLOSED";

export type PREvent =
  | "poll_started"
  | "ci_passed"
  | "ci_failed"
  | "ci_pending"
  | "review_posted"
  | "changes_requested"
  | "all_approved"
  | "auto_merge_enabled"
  | "merged"
  | "closed"
  | "new_commit"
  | "stale_detected"
  | "review_requested";

export const TERMINAL_STATES: ReadonlySet<PRState> = new Set([
  "MERGED",
  "CLOSED",
]);

export type WatchedPR = {
  number: number;
  repo: string;
  title: string;
  url: string;
  state: PRState;
  headSha: string | null;
  lastCheckedAt: string | null;
  lastEventAt: string | null;
  lastBotCommentNotifiedAt: string | null;
};

export type PREventRecord = {
  ts: string;
  pr: number;
  repo: string;
  event: PREvent;
  from: PRState;
  to: PRState;
  details: Record<string, unknown>;
};

export type CheckStatus = {
  name: string;
  state: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  workflow: string;
};

export type ReviewData = {
  author: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body: string;
  submittedAt: string;
};

export type PRSnapshot = {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  reviewDecision: string | null;
  mergeStateStatus: string;
  autoMergeRequest: { mergeMethod: string } | null;
  mergedAt: string | null;
  closedAt: string | null;
  headSha: string;
  checks: CheckStatus[];
  reviews: ReviewData[];
};

export type ReviewAssignment = {
  number: number;
  repo: string;
  title: string;
  url: string;
  notifiedAt: string;
};

export type ReviewFollowUp = {
  number: number;
  repo: string;
  title: string;
  url: string;
  ourReviewSubmittedAt: string;
  headShaAtReview: string;
  lastKnownHeadSha: string;
  notifiedForReReviewAt: string | null;
  status: "watching" | "re_review_requested" | "approved" | "closed";
};

export type ReviewerNudge = {
  number: number;
  repo: string;
  reviewer: string;
  fixPushedAt: string;
  commentPostedAt: string | null;
  lastEscalatedAt: string | null;
  escalationCount: number;
  status: "pending_comment" | "waiting" | "responded" | "closed";
};

export type MergeStrategy = "squash" | "merge" | "rebase";

export type ShepherdConfig = {
  pollIntervalSeconds: number;
  staleThresholdHours: number;
  requiredApprovals: number;
  mergeStrategy: MergeStrategy;
  dryRun: boolean;
  dataDir: string;

  github: {
    defaultRepo: string | null;
    authorUsername: string | null;
  };

  reviews: {
    ignoreUsers: string[];
    botUsers: string[];
  };

  checks: {
    requiredChecks: string[];
    ignoreChecks: string[];
  };

  notifications: {
    webhookUrl: string | null;
    channel: string | null;
    notifyAgent: string | null;
    onMerge: boolean;
    onCIFailure: boolean;
    onStale: boolean;
    onApproval: boolean;
  };

  agent: {
    conductorUrl: string | null;
    shepherdPane: string | null;
  };

  reviewInbox: {
    enabled: boolean;
    githubUser: string | null;
    notifyAgent: string | null;
    notifyPane: string | null;
    ignoreRepos: string[];
    ignoreDrafts: boolean;
    maxAgeDays: number;
  };

  reviewFollowUp: {
    enabled: boolean;
  };

  reviewerNudge: {
    enabled: boolean;
    escalateAfterHours: number;
    businessDaysOnly: boolean;
  };
};
