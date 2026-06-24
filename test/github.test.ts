import { describe, it, expect } from "vitest";
import { parseChecks, parseReviews, evaluateChecks, evaluateReviews, buildSnapshot, selectNewComments } from "../src/github.js";
import type { IssueComment } from "../src/github.js";
import { DEFAULTS } from "../src/config.js";
import type { ShepherdConfig, CheckStatus, ReviewData } from "../src/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
});
