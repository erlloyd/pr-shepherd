import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pollAll } from "../src/daemon.js";
import {
  feedbackSenderRole,
  isForwardableFeedback,
  legacyFeedbackSeed,
  feedbackLabel,
} from "../src/feedback.js";
import { DEFAULTS } from "../src/config.js";
import { upsertCachedPR, readCache } from "../src/state-cache.js";
import type { FeedbackItem } from "../src/github.js";
import type { PRState, ShepherdConfig, WatchedPR } from "../src/types.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("../src/ateam-conductor.js", () => ({
  routeToAgent: vi.fn(),
  reapClosedReviews: vi.fn(),
}));

function makeConfig(overrides?: Partial<ShepherdConfig>): ShepherdConfig {
  return {
    ...JSON.parse(JSON.stringify(DEFAULTS)),
    dryRun: false,
    github: { defaultRepo: null, authorUsername: "erlloyd", org: null, ignoreRepos: [] },
    notifications: { ...DEFAULTS.notifications, notifyAgent: "worker" },
    reviews: { ignoreUsers: [], botUsers: ["mgt-canary[bot]"], reviewerUsers: ["jbarneson", "Zach-MGT", "ian"] },
    ...overrides,
  };
}

describe("feedback sender filter", () => {
  const config = makeConfig();

  it("allows listed reviewers (case-insensitive) and listed bots; nobody else", () => {
    expect(feedbackSenderRole("zach-mgt", config)).toBe("reviewer");
    expect(feedbackSenderRole("MGT-Canary[bot]", config)).toBe("bot");
    expect(feedbackSenderRole("stranger", config)).toBeNull();
    expect(feedbackSenderRole("vercel[bot]", config)).toBeNull();
  });

  it("excludes the PR author's own identity even if listed", () => {
    const c = makeConfig({ reviews: { ignoreUsers: [], botUsers: [], reviewerUsers: ["erlloyd"] } });
    expect(feedbackSenderRole("ErLloyd", c)).toBeNull();
  });

  it("gates listed bots on ❌ and drops empty bodies", () => {
    expect(isForwardableFeedback({ author: "mgt-canary[bot]", body: "all good" }, config)).toBe(false);
    expect(isForwardableFeedback({ author: "mgt-canary[bot]", body: "❌ missing guard" }, config)).toBe(true);
    expect(isForwardableFeedback({ author: "jbarneson", body: "   \n " }, config)).toBe(false);
    expect(isForwardableFeedback({ author: "jbarneson", body: "nit" }, config)).toBe(true);
  });
});

describe("legacyFeedbackSeed", () => {
  const base = { lastEventAt: "2026-10-06T00:36:43.476Z", botFeedbackCount: 0 } as WatchedPR;

  it("uses the latest legacy comment cursor, ignoring lastEventAt", () => {
    expect(
      legacyFeedbackSeed({
        ...base,
        lastBotCommentNotifiedAt: "2026-10-06T00:17:35Z",
        lastCommentedReviewNotifiedAt: "2026-10-06T00:10:00Z",
        lastReviewerCommentNotifiedAt: null,
      }),
    ).toBe("2026-10-06T00:17:35Z");
  });

  it("falls back to lastEventAt when no legacy cursor is set", () => {
    expect(legacyFeedbackSeed({ ...base })).toBe("2026-10-06T00:36:43.476Z");
  });

  it("compares mixed-precision timestamps as instants", () => {
    expect(
      legacyFeedbackSeed({
        ...base,
        lastBotCommentNotifiedAt: "2026-10-06T00:17:35.500Z",
        lastReviewerCommentNotifiedAt: "2026-10-06T00:17:35Z",
      }),
    ).toBe("2026-10-06T00:17:35.500Z");
  });
});

describe("feedbackLabel", () => {
  const item = (o: Partial<FeedbackItem>): FeedbackItem => ({
    key: "x", kind: "comment", id: 1, author: "ian", body: "b", createdAt: "t",
    verdict: null, path: null, line: null, threadId: null, ...o,
  });
  it("labels each surface with kind and verdict", () => {
    expect(feedbackLabel(item({ kind: "review", verdict: "APPROVED" }))).toBe("APPROVED review from @ian");
    expect(feedbackLabel(item({ kind: "comment" }))).toBe("comment from @ian");
    expect(feedbackLabel(item({ kind: "inline", path: "src/a.ts", line: 9, threadId: 5 }))).toBe(
      "inline comment from @ian on src/a.ts:9 (thread 5)",
    );
  });
});

// ── pollAll integration: one forwarding path across surfaces and states ──

type RestReview = { id: number; user: { login: string }; state: string; body: string; submitted_at: string };
type RestComment = { id: number; user: { login: string }; body: string; created_at: string };
type RestInline = RestComment & { path: string; line: number | null; in_reply_to_id?: number };

type World = {
  reviews: RestReview[];
  comments: RestComment[];
  inline: RestInline[];
  checks: Array<{ name: string; state: string; bucket: string; workflow: string }>;
  autoMergeRequest: { mergeMethod: string } | null;
};

const PR_NUMBER = 10314;
const REPO = "acme/widgets";

describe("pollAll — unified feedback forwarding", () => {
  const TMP = join(import.meta.dirname, "__tmp_feedback");
  let mockedExec: ReturnType<typeof vi.mocked<any>>;
  let mockedRoute: ReturnType<typeof vi.mocked<any>>;
  let world: World;

  const pendingChecks = [{ name: "build", state: "IN_PROGRESS", bucket: "pending", workflow: "ci" }];
  const passingChecks = [{ name: "build", state: "SUCCESS", bucket: "pass", workflow: "ci" }];

  beforeEach(async () => {
    mkdirSync(TMP, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    const { routeToAgent } = await import("../src/ateam-conductor.js");
    mockedExec = vi.mocked(execFileSync);
    mockedRoute = vi.mocked(routeToAgent);
    mockedExec.mockReset();
    mockedRoute.mockReset();
    mockedRoute.mockReturnValue(true);
    world = { reviews: [], comments: [], inline: [], checks: pendingChecks, autoMergeRequest: null };

    // Route each gh invocation by its arguments so the test does not depend
    // on call order.
    mockedExec.mockImplementation(((_cmd: string, args: string[]) => {
      const page = (items: unknown[]) => JSON.stringify([items]);
      if (args[0] === "search") {
        return JSON.stringify([
          {
            number: PR_NUMBER,
            repository: { name: "widgets", nameWithOwner: REPO },
            title: "feat: zip",
            url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
            isDraft: false,
            updatedAt: new Date().toISOString(),
          },
        ]);
      }
      if (args[0] === "pr" && args[1] === "view") {
        if (args.includes("reviews")) {
          return JSON.stringify({
            reviews: world.reviews.map((r) => ({
              author: { login: r.user.login }, state: r.state, body: r.body, submittedAt: r.submitted_at,
            })),
          });
        }
        return JSON.stringify({
          number: PR_NUMBER, state: "OPEN", reviewDecision: null, mergeStateStatus: "BLOCKED",
          mergeable: "MERGEABLE", autoMergeRequest: world.autoMergeRequest, mergedAt: null, closedAt: null,
          headRefOid: "abc123",
        });
      }
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify(world.checks);
      if (args[0] === "api") {
        const path = args[1];
        if (path === "graphql") return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: false } } } });
        if (path.includes(`/pulls/${PR_NUMBER}/reviews`)) return page(world.reviews);
        if (path.includes(`/issues/${PR_NUMBER}/comments`)) return page(world.comments);
        if (path.includes(`/pulls/${PR_NUMBER}/comments`)) return page(world.inline);
      }
      return "";
    }) as any);
  });

  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  function cachedPR(overrides?: Partial<WatchedPR>): WatchedPR {
    return {
      number: PR_NUMBER,
      repo: REPO,
      title: "feat: zip",
      url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      state: "AWAITING_REVIEW",
      headSha: "abc123",
      lastCheckedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString(),
      botFeedbackCount: 0,
      forwardedFeedbackIds: [],
      lastConflictNotifiedAt: null,
      ...overrides,
    };
  }

  const messages = (): string[] => mockedRoute.mock.calls.map((c: unknown[]) => c[1] as string);
  const feedbackMessages = () => messages().filter((m) => m.includes("New review feedback"));
  const review = (id: number, login: string, state: string, body: string, at: string): RestReview => ({
    id, user: { login }, state, body, submitted_at: at,
  });
  const comment = (id: number, login: string, body: string, at: string): RestComment => ({
    id, user: { login }, body, created_at: at,
  });
  const inline = (id: number, login: string, body: string, at: string, replyTo?: number): RestInline => ({
    id, user: { login }, body, created_at: at, path: "src/zip.ts", line: 42,
    ...(replyTo ? { in_reply_to_id: replyTo } : {}),
  });

  it("forwards an approval body while approvals are below requiredApprovals", async () => {
    const config = makeConfig({ dataDir: TMP, requiredApprovals: 2 });
    upsertCachedPR(TMP, cachedPR());
    world.checks = passingChecks;
    world.reviews = [review(1, "jbarneson", "APPROVED", "The zip stream is never closed on error.", "2026-10-06T00:29:44Z")];

    await pollAll(config);

    expect(readCache(TMP)[0].state).toBe("AWAITING_REVIEW");
    expect(feedbackMessages()).toHaveLength(1);
    expect(feedbackMessages()[0]).toContain("APPROVED review from @jbarneson");
    expect(feedbackMessages()[0]).toContain("The zip stream is never closed on error.");
  });

  it("forwards review bodies of every verdict", async () => {
    const config = makeConfig({ dataDir: TMP, reviews: { ignoreUsers: [], botUsers: [], reviewerUsers: ["a", "b", "c", "d"] } });
    upsertCachedPR(TMP, cachedPR());
    world.reviews = [
      review(1, "a", "APPROVED", "approve body", "2026-10-01T00:00:01Z"),
      review(2, "b", "CHANGES_REQUESTED", "changes body", "2026-10-01T00:00:02Z"),
      review(3, "c", "COMMENTED", "comment body", "2026-10-01T00:00:03Z"),
      review(4, "d", "DISMISSED", "dismissed body", "2026-10-01T00:00:04Z"),
    ];

    await pollAll(config);

    const [msg] = feedbackMessages();
    for (const label of [
      "APPROVED review from @a",
      "CHANGES_REQUESTED review from @b",
      "COMMENTED review from @c",
      "DISMISSED review from @d",
    ]) {
      expect(msg).toContain(label);
    }
  });

  const watchedStates: PRState[] = [
    "CI_PENDING", "CI_FAILED", "CI_PASSED", "AWAITING_REVIEW", "STALE",
    "CHANGES_REQUESTED", "APPROVED", "AUTO_MERGE_ENABLED", "IN_MERGE_QUEUE",
  ];

  it.each(watchedStates)("forwards every surface while the PR is %s", async (state) => {
    const config = makeConfig({ dataDir: TMP, mergeQueue: { enabled: false } });
    upsertCachedPR(TMP, cachedPR({ state }));
    world.checks = state === "CI_FAILED" ? [{ name: "build", state: "FAILURE", bucket: "fail", workflow: "ci" }] : pendingChecks;
    world.reviews = [review(1, "ian", "COMMENTED", "review body", "2026-10-01T00:00:01Z")];
    world.comments = [comment(2, "ian", "issue body", "2026-10-01T00:00:02Z")];
    world.inline = [inline(3, "ian", "inline body", "2026-10-01T00:00:03Z")];

    await pollAll(config);

    const fb = feedbackMessages();
    expect(fb).toHaveLength(1);
    expect(fb[0]).toContain("COMMENTED review from @ian");
    expect(fb[0]).toContain("comment from @ian");
    expect(fb[0]).toContain("inline comment from @ian on src/zip.ts:42 (thread 3)");
    expect(fb[0]).toContain("in_reply_to=<thread id>");
  });

  it("never forwards the same item twice across polls, and forwards only new items later", async () => {
    const config = makeConfig({ dataDir: TMP });
    upsertCachedPR(TMP, cachedPR());
    world.comments = [comment(1, "ian", "first", "2026-10-01T00:00:01Z")];

    await pollAll(config);
    await pollAll(config);
    expect(feedbackMessages()).toHaveLength(1);

    world.inline = [inline(2, "ian", "second", "2026-10-01T00:00:02Z")];
    await pollAll(config);

    const fb = feedbackMessages();
    expect(fb).toHaveLength(2);
    expect(fb[1]).toContain("second");
    expect(fb[1]).not.toContain("first");
    expect(readCache(TMP)[0].forwardedFeedbackIds).toEqual(["comment:1", "inline:2"]);
  });

  it("forwards an inline comment drafted before a newer item once its review is submitted", async () => {
    // A pending review's inline comments carry their draft time; per-item
    // dedup (not a timestamp cursor) still delivers them.
    const config = makeConfig({ dataDir: TMP });
    upsertCachedPR(TMP, cachedPR());
    world.comments = [comment(1, "ian", "newer", "2026-10-01T00:10:00Z")];
    await pollAll(config);

    world.inline = [inline(2, "zach-mgt", "drafted earlier", "2026-10-01T00:05:00Z")];
    await pollAll(config);

    expect(feedbackMessages()).toHaveLength(2);
    expect(feedbackMessages()[1]).toContain("drafted earlier");
  });

  it("keeps review bodies out of transition messages so each body is sent once", async () => {
    const config = makeConfig({ dataDir: TMP });
    upsertCachedPR(TMP, cachedPR());
    world.checks = passingChecks;
    world.reviews = [review(1, "ian", "CHANGES_REQUESTED", "Please split this PR.", "2026-10-01T00:00:01Z")];

    await pollAll(config);

    expect(readCache(TMP)[0].state).toBe("CHANGES_REQUESTED");
    const all = messages();
    expect(all).toHaveLength(2);
    expect(all[0]).toContain("Changes Requested by @ian");
    expect(all[0]).not.toContain("Please split this PR.");
    expect(all.filter((m) => m.includes("Please split this PR."))).toHaveLength(1);
  });

  it("keeps approval bodies out of the approval message", async () => {
    const config = makeConfig({ dataDir: TMP });
    upsertCachedPR(TMP, cachedPR());
    world.checks = passingChecks;
    world.reviews = [review(1, "ian", "APPROVED", "Approved, but the retry loop swallows timeouts.", "2026-10-01T00:00:01Z")];

    await pollAll(config);
    await pollAll(config);

    expect(readCache(TMP)[0].state).toBe("APPROVED");
    const all = messages();
    expect(all.some((m) => m.includes("Approved (1 approval)"))).toBe(true);
    expect(all.filter((m) => m.includes("swallows timeouts"))).toHaveLength(1);
  });

  it("still transitions on a review from an unlisted sender but does not forward its body", async () => {
    const config = makeConfig({ dataDir: TMP });
    upsertCachedPR(TMP, cachedPR());
    world.checks = passingChecks;
    world.reviews = [review(1, "stranger", "CHANGES_REQUESTED", "unlisted body", "2026-10-01T00:00:01Z")];

    await pollAll(config);

    expect(readCache(TMP)[0].state).toBe("CHANGES_REQUESTED");
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain("Changes Requested by @stranger");
    expect(messages()[0]).not.toContain("unlisted body");
  });

  it("excludes the author, unlisted humans, and unlisted bots", async () => {
    const config = makeConfig({ dataDir: TMP });
    upsertCachedPR(TMP, cachedPR());
    world.comments = [
      comment(1, "erlloyd", "author note", "2026-10-01T00:00:01Z"),
      comment(2, "vercel[bot]", "preview ready", "2026-10-01T00:00:02Z"),
      comment(3, "stranger", "drive-by", "2026-10-01T00:00:03Z"),
    ];
    world.inline = [inline(4, "erlloyd", "author reply", "2026-10-01T00:00:04Z")];

    await pollAll(config);

    expect(feedbackMessages()).toHaveLength(0);
  });

  it("forwards a listed bot only with ❌, on any surface, and honors the attempt cap", async () => {
    const config = makeConfig({ dataDir: TMP, botFeedback: { maxAttempts: 1 } });
    upsertCachedPR(TMP, cachedPR());
    world.comments = [comment(1, "mgt-canary[bot]", "Summary: all good", "2026-10-01T00:00:01Z")];
    world.reviews = [review(2, "mgt-canary[bot]", "COMMENTED", "❌ unchecked null", "2026-10-01T00:00:02Z")];

    await pollAll(config);

    expect(feedbackMessages()).toHaveLength(1);
    expect(feedbackMessages()[0]).toContain("COMMENTED review from @mgt-canary[bot]");
    expect(feedbackMessages()[0]).toContain("bot feedback attempt 1/1");
    expect(feedbackMessages()[0]).not.toContain("all good");
    expect(readCache(TMP)[0].botFeedbackCount).toBe(1);

    // Cap reached: a new ❌ finding is dropped, a listed human still flows.
    world.inline = [
      inline(3, "mgt-canary[bot]", "❌ another", "2026-10-01T00:00:03Z"),
      inline(4, "ian", "human note", "2026-10-01T00:00:04Z"),
    ];
    await pollAll(config);

    expect(feedbackMessages()).toHaveLength(2);
    expect(feedbackMessages()[1]).toContain("human note");
    expect(feedbackMessages()[1]).not.toContain("another");
  });

  it("moves a CI_PASSED PR to AWAITING_REVIEW when feedback is forwarded", async () => {
    const config = makeConfig({ dataDir: TMP });
    upsertCachedPR(TMP, cachedPR({ state: "CI_PASSED" }));
    world.checks = passingChecks;
    world.comments = [comment(1, "ian", "question", "2026-10-01T00:00:01Z")];

    await pollAll(config);

    expect(readCache(TMP)[0].state).toBe("AWAITING_REVIEW");
  });

  it("does not record items when delivery fails, and retries next poll", async () => {
    const config = makeConfig({ dataDir: TMP });
    upsertCachedPR(TMP, cachedPR());
    world.comments = [comment(1, "ian", "retry me", "2026-10-01T00:00:01Z")];
    mockedRoute.mockReturnValueOnce(false);

    await pollAll(config);
    expect(readCache(TMP)[0].forwardedFeedbackIds).toEqual([]);

    await pollAll(config);
    expect(feedbackMessages()).toHaveLength(2);
    expect(readCache(TMP)[0].forwardedFeedbackIds).toEqual(["comment:1"]);
  });

  it("dry-run reports without sending or recording", async () => {
    const config = makeConfig({ dataDir: TMP, dryRun: true });
    upsertCachedPR(TMP, cachedPR());
    world.comments = [comment(1, "ian", "x", "2026-10-01T00:00:01Z")];

    await pollAll(config);

    expect(mockedRoute).not.toHaveBeenCalled();
    expect(readCache(TMP)[0].forwardedFeedbackIds).toEqual([]);
  });

  describe("rollout seeding of legacy cache entries", () => {
    // The shape of midgard#10314 at deploy time: canary's ❌ comment was
    // forwarded (bot cursor), then jbarneson approved below requiredApprovals,
    // then CI passed (lastEventAt) — the approval body never went out.
    function legacy(overrides?: Partial<WatchedPR>): WatchedPR {
      const pr = cachedPR({
        lastEventAt: "2026-10-06T00:36:43.476Z",
        botFeedbackCount: 1,
        lastBotCommentNotifiedAt: "2026-10-06T00:17:35Z",
        lastReviewerCommentNotifiedAt: null,
        lastReviewerReviewCommentNotifiedAt: null,
        lastCommentedReviewNotifiedAt: null,
        ...overrides,
      });
      delete pr.forwardedFeedbackIds;
      return pr;
    }

    it("forwards the missed approval and nothing already delivered", async () => {
      const config = makeConfig({ dataDir: TMP, requiredApprovals: 2, botFeedback: { maxAttempts: 2 } });
      upsertCachedPR(TMP, legacy());
      world.checks = passingChecks;
      world.comments = [
        comment(11, "mgt-canary[bot]", "❌ finding", "2026-10-06T00:17:35Z"),
        comment(12, "erlloyd", "addressed", "2026-10-06T00:27:18Z"),
        comment(13, "vercel[bot]", "preview", "2026-10-06T00:24:38Z"),
      ];
      world.reviews = [review(21, "jbarneson", "APPROVED", "Real finding in the zip path.", "2026-10-06T00:29:44Z")];

      await pollAll(config);

      const fb = feedbackMessages();
      expect(fb).toHaveLength(1);
      expect(fb[0]).toContain("APPROVED review from @jbarneson");
      expect(fb[0]).not.toContain("❌ finding");
      expect(readCache(TMP)[0].forwardedFeedbackIds).toEqual(["comment:11", "review:21"]);

      await pollAll(config);
      expect(feedbackMessages()).toHaveLength(1);
    });

    it("persists the seed even when nothing is new, so later items are judged per item", async () => {
      const config = makeConfig({ dataDir: TMP });
      upsertCachedPR(TMP, legacy());
      world.comments = [comment(11, "ian", "old", "2026-10-06T00:10:00Z")];

      await pollAll(config);

      expect(feedbackMessages()).toHaveLength(0);
      expect(readCache(TMP)[0].forwardedFeedbackIds).toEqual(["comment:11"]);
    });

    it("falls back to lastEventAt when the entry has no legacy cursor", async () => {
      const config = makeConfig({ dataDir: TMP });
      upsertCachedPR(TMP, legacy({ lastBotCommentNotifiedAt: null, lastEventAt: "2026-10-06T00:20:00.000Z" }));
      world.comments = [
        comment(1, "ian", "before last event", "2026-10-06T00:19:59Z"),
        comment(2, "ian", "after last event", "2026-10-06T00:20:01Z"),
      ];

      await pollAll(config);

      expect(feedbackMessages()).toHaveLength(1);
      expect(feedbackMessages()[0]).toContain("after last event");
      expect(feedbackMessages()[0]).not.toContain("before last event");
    });

    it("forwards all existing feedback for a newly discovered PR", async () => {
      const config = makeConfig({ dataDir: TMP });
      world.comments = [comment(1, "ian", "early", "2026-01-01T00:00:00Z")];

      await pollAll(config);

      expect(feedbackMessages()).toHaveLength(1);
      expect(readCache(TMP)[0].forwardedFeedbackIds).toEqual(["comment:1"]);
    });
  });
});
