import { describe, it, expect, vi } from "vitest";
import { parseChecks, parseReviews, evaluateChecks, evaluateReviews, buildSnapshot, selectNewComments, parseMergeQueueStatus, fetchReviewThreadComments, belongsToOrg } from "../src/github.js";
import type { IssueComment } from "../src/github.js";
import { DEFAULTS } from "../src/config.js";
import type { ShepherdConfig, CheckStatus, ReviewData } from "../src/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Mock node:child_process so execFileSync never shells out
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockedExec = vi.mocked(execFileSync);

const FIXTURES = join(import.meta.dirname, "fixtures");

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as T;
}

function makeConfig(overrides?: Partial<ShepherdConfig>): ShepherdConfig {
  return { ...JSON.parse(JSON.stringify(DEFAULTS)), ...overrides };
}

function makeComment(createdAt: string, body = "hi"): IssueComment {
  return { author: "alice", body, createdAt, hasActionableFindings: /❌/.test(body) };
}

describe("selectNewComments", () => {
  const comments = [
    makeComment("2026-06-01T00:00:00Z"),
    makeComment("2026-06-02T00:00:00Z"),
    makeComment("2026-06-03T00:00:00Z"),
  ];

  it("returns all comments when cutoff is null (never notified)", () => {
    expect(selectNewComments(comments, null)).toHaveLength(3);
  });

  it("returns only comments strictly newer than the cutoff", () => {
    const result = selectNewComments(comments, "2026-06-02T00:00:00Z");
    expect(result).toHaveLength(1);
    expect(result[0].createdAt).toBe("2026-06-03T00:00:00Z");
  });

  it("returns empty when all comments are at or before the cutoff", () => {
    expect(selectNewComments(comments, "2026-06-03T00:00:00Z")).toHaveLength(0);
  });

  it("preserves order (oldest-first) so the last element is the newest cursor", () => {
    const result = selectNewComments(comments, null);
    expect(result[result.length - 1].createdAt).toBe("2026-06-03T00:00:00Z");
  });
});

describe("github", () => {
  describe("belongsToOrg", () => {
    it("matches repos in the configured org", () => {
      expect(belongsToOrg("acme/widgets", "acme")).toBe(true);
    });

    it("rejects repos in other orgs", () => {
      expect(belongsToOrg("megacorp/widgets", "acme")).toBe(false);
    });

    it("is case-insensitive on the owner", () => {
      expect(belongsToOrg("ACME/widgets", "acme")).toBe(true);
    });

    it("does not match an org that is only a prefix of the owner", () => {
      expect(belongsToOrg("acme-fork/widgets", "acme")).toBe(false);
    });

    it("matches everything when org is null or undefined", () => {
      expect(belongsToOrg("megacorp/widgets", null)).toBe(true);
      expect(belongsToOrg("megacorp/widgets", undefined)).toBe(true);
    });
  });

  describe("parseChecks", () => {
    it("parses raw checks into typed structures", () => {
      const raw = loadFixture<Array<{ name: string; state: string; bucket: string; workflow: string }>>(
        "checks-passed.json",
      );
      const config = makeConfig();
      const checks = parseChecks(raw, config);
      expect(checks).toHaveLength(7);
      expect(checks[0].bucket).toBe("pass");
    });

    it("filters out ignored checks", () => {
      const raw = loadFixture<Array<{ name: string; state: string; bucket: string; workflow: string }>>(
        "checks-passed.json",
      );
      const config = makeConfig({
        checks: { requiredChecks: [], ignoreChecks: ["optional-deploy"] },
      });
      const checks = parseChecks(raw, config);
      expect(checks.find((c) => c.name === "optional-deploy")).toBeUndefined();
    });
  });

  describe("parseReviews", () => {
    it("parses approved reviews", () => {
      const raw = loadFixture<{ reviews: Array<{ author: { login: string }; state: string; body: string; submittedAt: string }> }>(
        "reviews-approved.json",
      );
      const config = makeConfig();
      const reviews = parseReviews(raw.reviews, config);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].state).toBe("APPROVED");
      expect(reviews[0].author).toBe("alice");
    });

    it("parses changes-requested reviews", () => {
      const raw = loadFixture<{ reviews: Array<{ author: { login: string }; state: string; body: string; submittedAt: string }> }>(
        "reviews-changes-requested.json",
      );
      const config = makeConfig();
      const reviews = parseReviews(raw.reviews, config);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].state).toBe("CHANGES_REQUESTED");
      expect(reviews[0].body).toContain("Off-by-one");
    });

    it("filters out ignored users", () => {
      const raw = loadFixture<{ reviews: Array<{ author: { login: string }; state: string; body: string; submittedAt: string }> }>(
        "reviews-approved.json",
      );
      const config = makeConfig({
        reviews: { ignoreUsers: ["alice"], botUsers: [] },
      });
      const reviews = parseReviews(raw.reviews, config);
      expect(reviews).toHaveLength(0);
    });
  });

  describe("evaluateChecks", () => {
    it("returns pending when checks are in progress", () => {
      const raw = loadFixture<Array<{ name: string; state: string; bucket: string; workflow: string }>>(
        "checks-pending.json",
      );
      const checks = parseChecks(raw, makeConfig());
      const result = evaluateChecks(checks, makeConfig());
      expect(result.status).toBe("pending");
      expect(result.pending).toContain("test-suite (1)");
      expect(result.pending).toContain("lint");
    });

    it("returns pass when all checks pass", () => {
      const raw = loadFixture<Array<{ name: string; state: string; bucket: string; workflow: string }>>(
        "checks-passed.json",
      );
      const checks = parseChecks(raw, makeConfig());
      const result = evaluateChecks(checks, makeConfig());
      expect(result.status).toBe("pass");
      expect(result.failed).toEqual([]);
      expect(result.pending).toEqual([]);
    });

    it("returns fail when checks have failures", () => {
      const raw = loadFixture<Array<{ name: string; state: string; bucket: string; workflow: string }>>(
        "checks-failed.json",
      );
      const checks = parseChecks(raw, makeConfig());
      const result = evaluateChecks(checks, makeConfig());
      expect(result.status).toBe("fail");
      expect(result.failed).toContain("test-suite (1)");
      expect(result.failed).toContain("lint");
    });

    it("only considers required checks when configured", () => {
      const raw = loadFixture<Array<{ name: string; state: string; bucket: string; workflow: string }>>(
        "checks-failed.json",
      );
      const config = makeConfig({
        checks: { requiredChecks: ["changes", "danger"], ignoreChecks: [] },
      });
      const checks = parseChecks(raw, config);
      const result = evaluateChecks(checks, config);
      expect(result.status).toBe("pass");
    });

    it("skips checks with 'skipping' bucket when no requiredChecks set", () => {
      const checks: CheckStatus[] = [
        { name: "lint", state: "SUCCESS", bucket: "pass", workflow: "CI" },
        { name: "optional", state: "SKIPPED", bucket: "skipping", workflow: "" },
      ];
      const result = evaluateChecks(checks, makeConfig());
      expect(result.status).toBe("pass");
    });
  });

  describe("evaluateReviews", () => {
    it("returns approved when enough approvals", () => {
      const reviews: ReviewData[] = [
        { author: "alice", state: "APPROVED", body: "LGTM", submittedAt: "2026-06-15T19:00:00Z" },
      ];
      const result = evaluateReviews(reviews, makeConfig());
      expect(result.status).toBe("approved");
      expect(result.approvals).toBe(1);
    });

    it("returns changes_requested when reviewer requested changes", () => {
      const reviews: ReviewData[] = [
        { author: "bob", state: "CHANGES_REQUESTED", body: "Fix this", submittedAt: "2026-06-15T19:00:00Z" },
      ];
      const result = evaluateReviews(reviews, makeConfig());
      expect(result.status).toBe("changes_requested");
      expect(result.changesRequested).toHaveLength(1);
    });

    it("returns pending when not enough approvals", () => {
      const config = makeConfig({ requiredApprovals: 2 });
      const reviews: ReviewData[] = [
        { author: "alice", state: "APPROVED", body: "LGTM", submittedAt: "2026-06-15T19:00:00Z" },
      ];
      const result = evaluateReviews(reviews, config);
      expect(result.status).toBe("pending");
      expect(result.approvals).toBe(1);
    });

    it("uses latest review per author", () => {
      const reviews: ReviewData[] = [
        { author: "alice", state: "CHANGES_REQUESTED", body: "Fix", submittedAt: "2026-06-15T18:00:00Z" },
        { author: "alice", state: "APPROVED", body: "Good now", submittedAt: "2026-06-15T19:00:00Z" },
      ];
      const result = evaluateReviews(reviews, makeConfig());
      expect(result.status).toBe("approved");
    });

    it("changes_requested takes priority even with approvals", () => {
      const reviews: ReviewData[] = [
        { author: "alice", state: "APPROVED", body: "LGTM", submittedAt: "2026-06-15T19:00:00Z" },
        { author: "bob", state: "CHANGES_REQUESTED", body: "No", submittedAt: "2026-06-15T19:01:00Z" },
      ];
      const result = evaluateReviews(reviews, makeConfig());
      expect(result.status).toBe("changes_requested");
    });

    it("returns approved with zero required approvals", () => {
      const config = makeConfig({ requiredApprovals: 0 });
      const result = evaluateReviews([], config);
      expect(result.status).toBe("approved");
    });

    it("collects approvalBodies for approvals with substantive bodies (>20 chars)", () => {
      const reviews: ReviewData[] = [
        { author: "canary", state: "APPROVED", body: "Approved, but the retry loop swallows timeout errors.", submittedAt: "2026-06-15T19:00:00Z" },
        { author: "alice", state: "APPROVED", body: "LGTM", submittedAt: "2026-06-15T19:01:00Z" },
      ];
      const result = evaluateReviews(reviews, makeConfig());
      expect(result.status).toBe("approved");
      expect(result.approvalBodies).toEqual([
        { reviewer: "canary", body: "Approved, but the retry loop swallows timeout errors." },
      ]);
    });

    it("ignores whitespace-padded trivial approval bodies", () => {
      const reviews: ReviewData[] = [
        { author: "alice", state: "APPROVED", body: "   LGTM   \n\n          ", submittedAt: "2026-06-15T19:00:00Z" },
      ];
      const result = evaluateReviews(reviews, makeConfig());
      expect(result.status).toBe("approved");
      expect(result.approvalBodies).toEqual([]);
    });

    it("only considers the latest review per author for approvalBodies", () => {
      const reviews: ReviewData[] = [
        { author: "canary", state: "APPROVED", body: "Older approval with a long substantive body.", submittedAt: "2026-06-15T18:00:00Z" },
        { author: "canary", state: "APPROVED", body: "LGTM", submittedAt: "2026-06-15T19:00:00Z" },
      ];
      const result = evaluateReviews(reviews, makeConfig());
      expect(result.status).toBe("approved");
      expect(result.approvalBodies).toEqual([]);
    });

    it("returns empty approvalBodies when changes are requested", () => {
      const reviews: ReviewData[] = [
        { author: "canary", state: "APPROVED", body: "Approved but please tighten null handling in parse().", submittedAt: "2026-06-15T19:00:00Z" },
        { author: "bob", state: "CHANGES_REQUESTED", body: "No", submittedAt: "2026-06-15T19:01:00Z" },
      ];
      const result = evaluateReviews(reviews, makeConfig());
      expect(result.status).toBe("changes_requested");
      expect(result.approvalBodies).toEqual([]);
    });

    it("returns empty approvalBodies while approvals are below threshold", () => {
      const config = makeConfig({ requiredApprovals: 2 });
      const reviews: ReviewData[] = [
        { author: "canary", state: "APPROVED", body: "Approved but please tighten null handling in parse().", submittedAt: "2026-06-15T19:00:00Z" },
      ];
      const result = evaluateReviews(reviews, config);
      expect(result.status).toBe("pending");
      expect(result.approvalBodies).toEqual([]);
    });
  });

  describe("buildSnapshot", () => {
    it("builds a complete snapshot", () => {
      const prView = loadFixture<{ number: number; state: string; reviewDecision: string | null; mergeStateStatus: string; autoMergeRequest: null; mergedAt: null; closedAt: null; headRefOid: string }>(
        "pr-view-open.json",
      );
      const checks: CheckStatus[] = [
        { name: "lint", state: "SUCCESS", bucket: "pass", workflow: "CI" },
      ];
      const reviews: ReviewData[] = [
        { author: "alice", state: "APPROVED", body: "LGTM", submittedAt: "2026-06-15T19:00:00Z" },
      ];
      const snapshot = buildSnapshot(prView as never, checks, reviews);
      expect(snapshot.number).toBe(123);
      expect(snapshot.state).toBe("OPEN");
      expect(snapshot.headSha).toBe("abc123def456");
      expect(snapshot.checks).toHaveLength(1);
      expect(snapshot.reviews).toHaveLength(1);
    });
  });

  describe("parseMergeQueueStatus", () => {
    it("returns true when the PR is in the merge queue", () => {
      const raw = readFileSync(join(FIXTURES, "merge-queue-in-queue.json"), "utf-8");
      expect(parseMergeQueueStatus(raw)).toBe(true);
    });

    it("returns false when the PR is not in the merge queue", () => {
      const raw = readFileSync(join(FIXTURES, "merge-queue-not-in-queue.json"), "utf-8");
      expect(parseMergeQueueStatus(raw)).toBe(false);
    });
  });

  describe("fetchReviewThreadComments", () => {
    it("parses id, in_reply_to_id, path, author, body, createdAt", () => {
      // --paginate --slurp wraps each page's JSON array in an outer array —
      // a single page here.
      mockedExec.mockReturnValueOnce(
        JSON.stringify([
          [
            { id: 100, user: { login: "shepherd" }, body: "finding", created_at: "2026-07-14T10:00:00Z", path: "src/a.ts" },
            { id: 101, in_reply_to_id: 100, user: { login: "alice" }, body: "reply", created_at: "2026-07-14T11:00:00Z", path: "src/a.ts" },
          ],
        ]) as unknown as ReturnType<typeof execFileSync>,
      );
      const comments = fetchReviewThreadComments(42, "acme/widgets");
      expect(comments).toEqual([
        { id: 100, inReplyToId: null, author: "shepherd", body: "finding", createdAt: "2026-07-14T10:00:00Z", path: "src/a.ts" },
        { id: 101, inReplyToId: 100, author: "alice", body: "reply", createdAt: "2026-07-14T11:00:00Z", path: "src/a.ts" },
      ]);
    });

    it("flattens multiple pages returned by --paginate --slurp", () => {
      mockedExec.mockReturnValueOnce(
        JSON.stringify([
          [
            { id: 100, user: { login: "shepherd" }, body: "finding", created_at: "2026-07-14T10:00:00Z", path: "src/a.ts" },
          ],
          [
            { id: 101, in_reply_to_id: 100, user: { login: "alice" }, body: "reply", created_at: "2026-07-14T11:00:00Z", path: "src/a.ts" },
          ],
        ]) as unknown as ReturnType<typeof execFileSync>,
      );
      const comments = fetchReviewThreadComments(42, "acme/widgets");
      expect(comments).toHaveLength(2);
      expect(comments.map((c) => c.id)).toEqual([100, 101]);
      expect(comments[1].inReplyToId).toBe(100);
    });
  });
});
