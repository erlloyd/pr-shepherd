import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pollReviewFollowUps, writeFollowUps, readFollowUps } from "../src/review-followup.js";
import type { ShepherdConfig, ReviewFollowUp } from "../src/types.js";

// Mock node:child_process so execFileSync never shells out
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const { execFileSync } = await import("node:child_process");
const mockedExec = vi.mocked(execFileSync);

const TMP = join(import.meta.dirname, "__tmp_review_followup");

function makeConfig(org: string | null): ShepherdConfig {
  return {
    pollIntervalSeconds: 30,
    staleThresholdHours: 24,
    requiredApprovals: 1,
    mergeStrategy: "squash",
    autoMerge: true,
    dryRun: false,
    dataDir: TMP,
    github: { defaultRepo: null, authorUsername: "shepherd", org, ignoreRepos: [] },
    reviews: { ignoreUsers: [], botUsers: [], reviewerUsers: [] },
    checks: { requiredChecks: [], ignoreChecks: [] },
    notifications: {
      webhookUrl: null, channel: null, notifyAgent: "worker",
      onMerge: true, onCIFailure: true, onStale: true, onApproval: true,
    },
    reviewInbox: {
      enabled: false, githubUser: "shepherd", notifyAgent: null, notifyPane: null,
      ignoreRepos: [], ignoreDrafts: true, maxAgeDays: 14, waitForBot: null,
    },
    reviewFollowUp: { enabled: true },
    replyWatch: { enabled: false },
    botFeedback: { maxAttempts: 3 },
    reviewerNudge: { enabled: false, escalateAfterHours: 24, businessDaysOnly: false },
    mergeQueue: { enabled: false },
  } as ShepherdConfig;
}

function makeFollowUp(repo: string): ReviewFollowUp {
  return {
    number: 9,
    repo,
    title: "feat: legacy",
    url: `https://github.com/${repo}/pull/9`,
    ourReviewSubmittedAt: "2026-07-10T00:00:00Z",
    headShaAtReview: "abc123",
    lastKnownHeadSha: "abc123",
    notifiedForReReviewAt: null,
    status: "watching",
  };
}

describe("pollReviewFollowUps — org scoping", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    vi.resetAllMocks();
  });

  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it("passes --owner to the reviewed-by search when org is set", async () => {
    mockedExec.mockReturnValueOnce("[]" as unknown as ReturnType<typeof execFileSync>);

    await pollReviewFollowUps(makeConfig("acme"));

    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(mockedExec.mock.calls[0][1]).toContain("--owner=acme");
  });

  it("omits --owner when org is unset", async () => {
    mockedExec.mockReturnValueOnce("[]" as unknown as ReturnType<typeof execFileSync>);

    await pollReviewFollowUps(makeConfig(null));

    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(
      (mockedExec.mock.calls[0][1] as string[]).some((a) => a.startsWith("--owner")),
    ).toBe(false);
  });

  it("drops out-of-org search results and skips out-of-org persisted follow-ups", async () => {
    writeFollowUps(TMP, [makeFollowUp("megacorp/legacy")]);

    // Search returns an out-of-org PR despite the --owner qualifier
    mockedExec.mockReturnValueOnce(
      JSON.stringify([
        {
          number: 21,
          repository: { nameWithOwner: "megacorp/widgets" },
          title: "feat: out of org",
          url: "https://github.com/megacorp/widgets/pull/21",
          isDraft: false,
          updatedAt: new Date().toISOString(),
          state: "OPEN",
        },
      ]) as unknown as ReturnType<typeof execFileSync>,
    );

    await pollReviewFollowUps(makeConfig("acme"));

    // Only the search ran — no review/PR lookups for either out-of-org entry,
    // and the search result was never tracked.
    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(readFollowUps(TMP)).toHaveLength(1);
    expect(readFollowUps(TMP)[0].repo).toBe("megacorp/legacy");
  });
});
