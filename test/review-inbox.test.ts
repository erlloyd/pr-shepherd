import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  readInbox,
  writeInbox,
  formatReviewAssignmentMessage,
  pollReviewInbox,
  latestUserReviewAt,
} from "../src/review-inbox.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewAssignment, ShepherdConfig } from "../src/types.js";

// Mock node:child_process so execFileSync never shells out in pollReviewInbox tests
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Mock ateam-conductor so routeToAgent never execs
vi.mock("../src/ateam-conductor.js", () => ({
  routeToAgent: vi.fn(),
}));

const TMP = join(import.meta.dirname, "__tmp_review_inbox");

function makeAssignment(overrides?: Partial<ReviewAssignment>): ReviewAssignment {
  return {
    number: 42,
    repo: "acme/widgets",
    title: "feat: add widget sorting",
    url: "https://github.com/acme/widgets/pull/42",
    detectedAt: "2026-01-01T00:00:00Z",
    notifiedAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    status: "dispatched",
    ...overrides,
  };
}

describe("review-inbox", () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  describe("readInbox / writeInbox", () => {
    it("returns empty array when no file exists", () => {
      expect(readInbox(TMP)).toEqual([]);
    });

    it("round-trips assignments", () => {
      const assignments = [makeAssignment(), makeAssignment({ number: 43 })];
      writeInbox(TMP, assignments);
      expect(readInbox(TMP)).toEqual(assignments);
    });

    it("recovers from corrupt file", () => {
      writeFileSync(join(TMP, "review-inbox.json"), "{{corrupt");
      expect(readInbox(TMP)).toEqual([]);
    });
  });

  describe("formatReviewAssignmentMessage", () => {
    it("formats a review assignment notification", () => {
      const assignment = makeAssignment();
      const msg = formatReviewAssignmentMessage(assignment);

      expect(msg).toContain("[PR Shepherd] Review requested");
      expect(msg).toContain("PR #42");
      expect(msg).toContain("acme/widgets");
      expect(msg).toContain("feat: add widget sorting");
      expect(msg).toContain("https://github.com/acme/widgets/pull/42");
      expect(msg).toContain("dispatch a worker");
    });
  });

  describe("status tracking", () => {
    it("tracks pending_bot_review status", () => {
      const a = makeAssignment({ status: "pending_bot_review", notifiedAt: null });
      writeInbox(TMP, [a]);
      const inbox = readInbox(TMP);
      expect(inbox[0].status).toBe("pending_bot_review");
      expect(inbox[0].notifiedAt).toBeNull();
    });

    it("tracks dispatched status with notifiedAt", () => {
      const a = makeAssignment({ status: "dispatched", notifiedAt: "2026-01-01T00:05:00Z" });
      writeInbox(TMP, [a]);
      const inbox = readInbox(TMP);
      expect(inbox[0].status).toBe("dispatched");
      expect(inbox[0].notifiedAt).toBe("2026-01-01T00:05:00Z");
    });

    it("tracks terminal statuses with completedAt", () => {
      const a = makeAssignment({
        status: "merged_before_review",
        completedAt: "2026-01-01T01:00:00Z",
      });
      writeInbox(TMP, [a]);
      const inbox = readInbox(TMP);
      expect(inbox[0].status).toBe("merged_before_review");
      expect(inbox[0].completedAt).toBe("2026-01-01T01:00:00Z");
    });
  });

  describe("deduplication", () => {
    it("does not re-add existing assignments", () => {
      const existing = [makeAssignment({ number: 42 })];
      writeInbox(TMP, existing);

      const inbox = readInbox(TMP);
      const keys = new Set(inbox.map((a) => `${a.repo}#${a.number}`));
      expect(keys.has("acme/widgets#42")).toBe(true);
      expect(keys.has("acme/widgets#99")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// pollReviewInbox dry-run tests
// ---------------------------------------------------------------------------

function makePollConfig(overrides?: Partial<ShepherdConfig>): ShepherdConfig {
  return {
    pollIntervalSeconds: 30,
    staleThresholdHours: 24,
    requiredApprovals: 1,
    mergeStrategy: "squash",
    dryRun: true,
    dataDir: TMP,
    github: { defaultRepo: null, authorUsername: null },
    reviews: { ignoreUsers: [], botUsers: [] },
    checks: { requiredChecks: [], ignoreChecks: [] },
    notifications: {
      webhookUrl: null,
      channel: null,
      notifyAgent: null,
      onMerge: true,
      onCIFailure: true,
      onStale: true,
      onApproval: true,
    },
    agent: { conductorUrl: null, shepherdPane: null },
    reviewInbox: {
      enabled: true,
      githubUser: "testuser",
      notifyAgent: null,
      notifyPane: null,
      ignoreRepos: [],
      ignoreDrafts: true,
      maxAgeDays: 14,
      waitForBot: null,
    },
    reviewFollowUp: { enabled: false },
    botFeedback: { maxAttempts: 3 },
    reviewerNudge: { enabled: false, escalateAfterHours: 24, businessDaysOnly: false },
    ...overrides,
  } as ShepherdConfig;
}

const { execFileSync } = await import("node:child_process");
const { routeToAgent } = await import("../src/ateam-conductor.js");
const mockedExec = vi.mocked(execFileSync);
const mockedRoute = vi.mocked(routeToAgent);

describe("pollReviewInbox dry-run", () => {

  const TMP_POLL = join(import.meta.dirname, "__tmp_review_inbox_poll");

  beforeEach(() => {
    mkdirSync(TMP_POLL, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(TMP_POLL, { recursive: true, force: true });
  });

  it("does NOT writeInbox or set notifiedAt when dryRun=true and a new assignment is ready to dispatch", async () => {
    // Inbox has a dispatched assignment with no notifiedAt
    const assignment: ReviewAssignment = {
      number: 3511,
      repo: "acme/widgets",
      title: "feat: test dry-run",
      url: "https://github.com/acme/widgets/pull/3511",
      detectedAt: new Date().toISOString(),
      notifiedAt: null,
      completedAt: null,
      status: "dispatched",
    };
    writeInbox(TMP_POLL, [assignment]);

    // fetchReviewRequests → returns empty (no new PRs to discover)
    // getPRState → "OPEN"
    // hasUserReviewed → false (not reviewed yet)
    mockedExec
      .mockReturnValueOnce("[]" as unknown as ReturnType<typeof execFileSync>) // fetchReviewRequests
      .mockReturnValueOnce(JSON.stringify({ state: "OPEN" }) as unknown as ReturnType<typeof execFileSync>) // getPRState
      .mockReturnValueOnce(JSON.stringify({ reviews: [] }) as unknown as ReturnType<typeof execFileSync>); // hasUserReviewed

    const config = makePollConfig({ dataDir: TMP_POLL });
    await pollReviewInbox(config);

    // routeToAgent must NOT have been called
    expect(mockedRoute).not.toHaveBeenCalled();

    // The inbox file must be unchanged — notifiedAt still null, status still dispatched
    const persisted = readInbox(TMP_POLL);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].notifiedAt).toBeNull();
    expect(persisted[0].status).toBe("dispatched");
  });
});

describe("re-review on re-request", () => {
  const TMP_RR = join(import.meta.dirname, "__tmp_review_inbox_rereview");

  const searchResult = JSON.stringify([
    {
      number: 42,
      repository: { name: "widgets", nameWithOwner: "acme/widgets" },
      title: "feat: add widget sorting",
      url: "https://github.com/acme/widgets/pull/42",
      isDraft: false,
      updatedAt: new Date().toISOString(),
    },
  ]);

  beforeEach(() => {
    mkdirSync(TMP_RR, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(TMP_RR, { recursive: true, force: true });
  });

  it("flips review_submitted to re_review_dispatched and dispatches with transition re_review", async () => {
    writeInbox(TMP_RR, [
      makeAssignment({ status: "review_submitted", completedAt: "2026-07-01T00:00:00Z" }),
    ]);
    mockedExec
      .mockReturnValueOnce(searchResult as unknown as ReturnType<typeof execFileSync>) // fetchReviewRequests
      .mockReturnValueOnce(JSON.stringify({ state: "OPEN" }) as unknown as ReturnType<typeof execFileSync>); // getPRState

    await pollReviewInbox(makePollConfig({ dataDir: TMP_RR, dryRun: false }));

    expect(mockedRoute).toHaveBeenCalledTimes(1);
    const [, msg, opts] = mockedRoute.mock.calls[0];
    expect(msg).toContain("Re-review requested");
    expect(msg).toContain("https://github.com/acme/widgets/pull/42");
    expect(opts).toEqual({ transition: "re_review" });

    const persisted = readInbox(TMP_RR);
    expect(persisted[0].status).toBe("re_review_dispatched");
    expect(persisted[0].reReviewDispatchedAt).toBeTruthy();
  });

  it("does not re-dispatch while a re-review is pending", async () => {
    writeInbox(TMP_RR, [
      makeAssignment({
        status: "re_review_dispatched",
        reReviewDispatchedAt: "2026-07-14T00:00:00Z",
      }),
    ]);
    mockedExec
      .mockReturnValueOnce(searchResult as unknown as ReturnType<typeof execFileSync>) // fetchReviewRequests
      .mockReturnValueOnce(JSON.stringify({ state: "OPEN" }) as unknown as ReturnType<typeof execFileSync>) // getPRState
      .mockReturnValueOnce(
        JSON.stringify({
          reviews: [{ author: { login: "testuser" }, state: "COMMENTED", submittedAt: "2026-07-10T00:00:00Z" }],
        }) as unknown as ReturnType<typeof execFileSync>, // latestUserReviewAt — older than dispatch
      );

    await pollReviewInbox(makePollConfig({ dataDir: TMP_RR, dryRun: false }));

    expect(mockedRoute).not.toHaveBeenCalled();
    expect(readInbox(TMP_RR)[0]?.status ?? "re_review_dispatched").toBe("re_review_dispatched");
  });

  it("completes the re-review when a newer review of ours exists", async () => {
    writeInbox(TMP_RR, [
      makeAssignment({
        status: "re_review_dispatched",
        reReviewDispatchedAt: "2026-07-14T00:00:00Z",
      }),
    ]);
    mockedExec
      .mockReturnValueOnce("[]" as unknown as ReturnType<typeof execFileSync>) // fetchReviewRequests — PR left the search
      .mockReturnValueOnce(JSON.stringify({ state: "OPEN" }) as unknown as ReturnType<typeof execFileSync>) // getPRState
      .mockReturnValueOnce(
        JSON.stringify({
          reviews: [
            { author: { login: "testuser" }, state: "COMMENTED", submittedAt: "2026-07-10T00:00:00Z" },
            { author: { login: "testuser" }, state: "COMMENTED", submittedAt: "2026-07-14T12:00:00Z" },
          ],
        }) as unknown as ReturnType<typeof execFileSync>, // latestUserReviewAt — newer
      );

    await pollReviewInbox(makePollConfig({ dataDir: TMP_RR, dryRun: false }));

    const persisted = readInbox(TMP_RR);
    expect(persisted[0].status).toBe("review_submitted");
    expect(persisted[0].completedAt).toBeTruthy();
  });

  it("creates a re_review_dispatched record when no inbox record exists but we already reviewed", async () => {
    mockedExec
      .mockReturnValueOnce(searchResult as unknown as ReturnType<typeof execFileSync>) // fetchReviewRequests
      .mockReturnValueOnce(
        JSON.stringify({
          reviews: [{ author: { login: "testuser" }, state: "COMMENTED" }],
        }) as unknown as ReturnType<typeof execFileSync>, // hasUserReviewed → true
      )
      .mockReturnValueOnce(JSON.stringify({ state: "OPEN" }) as unknown as ReturnType<typeof execFileSync>); // getPRState

    await pollReviewInbox(makePollConfig({ dataDir: TMP_RR, dryRun: false }));

    expect(mockedRoute).toHaveBeenCalledTimes(1);
    const persisted = readInbox(TMP_RR);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].status).toBe("re_review_dispatched");
    expect(persisted[0].reReviewDispatchedAt).toBeTruthy();
  });

  it("notifies to free the worker when the PR merges during a re-review", async () => {
    writeInbox(TMP_RR, [
      makeAssignment({
        status: "re_review_dispatched",
        reReviewDispatchedAt: "2026-07-14T00:00:00Z",
      }),
    ]);
    mockedExec
      .mockReturnValueOnce("[]" as unknown as ReturnType<typeof execFileSync>) // fetchReviewRequests
      .mockReturnValueOnce(JSON.stringify({ state: "MERGED" }) as unknown as ReturnType<typeof execFileSync>); // getPRState

    // notifyAgent short-circuits without a configured agent — set one so the
    // free-worker message reaches routeToAgent.
    const config = makePollConfig({ dataDir: TMP_RR, dryRun: false });
    config.reviewInbox.notifyAgent = "conductor";
    await pollReviewInbox(config);

    // notifyAgent → sendToAgent → routeToAgent (mocked)
    expect(mockedRoute).toHaveBeenCalledTimes(1);
    expect(mockedRoute.mock.calls[0][1]).toContain("no longer needed");
    expect(readInbox(TMP_RR)[0].status).toBe("merged_before_review");
  });
});

describe("latestUserReviewAt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the newest submittedAt among our reviews", () => {
    mockedExec.mockReturnValueOnce(
      JSON.stringify({
        reviews: [
          { author: { login: "TestUser" }, submittedAt: "2026-07-10T00:00:00Z" },
          { author: { login: "someoneelse" }, submittedAt: "2026-07-15T00:00:00Z" },
          { author: { login: "testuser" }, submittedAt: "2026-07-12T00:00:00Z" },
        ],
      }) as unknown as ReturnType<typeof execFileSync>,
    );
    expect(latestUserReviewAt(42, "acme/widgets", "testuser")).toBe("2026-07-12T00:00:00Z");
  });

  it("returns null when we have no reviews or gh fails", () => {
    mockedExec.mockReturnValueOnce(JSON.stringify({ reviews: [] }) as unknown as ReturnType<typeof execFileSync>);
    expect(latestUserReviewAt(42, "acme/widgets", "testuser")).toBeNull();
    mockedExec.mockImplementationOnce(() => {
      throw new Error("gh failed");
    });
    expect(latestUserReviewAt(42, "acme/widgets", "testuser")).toBeNull();
  });
});
