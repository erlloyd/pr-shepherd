import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findNewReplies, pollReplyWatch, formatReplyMessage } from "../src/reply-watch.js";
import { writeCache } from "../src/state-cache.js";
import type { ReviewThreadComment } from "../src/github.js";
import type { ShepherdConfig, WatchedPR } from "../src/types.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));
vi.mock("../src/ateam-conductor.js", () => ({
  routeToAgent: vi.fn(),
}));

const { execFileSync } = await import("node:child_process");
const { routeToAgent } = await import("../src/ateam-conductor.js");
const mockedExec = vi.mocked(execFileSync);
const mockedRoute = vi.mocked(routeToAgent);

function comment(overrides: Partial<ReviewThreadComment>): ReviewThreadComment {
  return {
    id: 1,
    inReplyToId: null,
    author: "someone",
    body: "a comment",
    createdAt: "2026-07-14T10:00:00Z",
    path: "src/foo.ts",
    ...overrides,
  };
}

describe("findNewReplies", () => {
  it("detects a reply to a thread we rooted", () => {
    const comments = [
      comment({ id: 100, author: "shepherd", createdAt: "2026-07-14T10:00:00Z" }),
      comment({ id: 101, inReplyToId: 100, author: "alice", body: "I disagree", createdAt: "2026-07-14T11:00:00Z" }),
    ];
    const replies = findNewReplies(comments, "shepherd", null);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual({
      rootId: 100,
      path: "src/foo.ts",
      author: "alice",
      body: "I disagree",
      createdAt: "2026-07-14T11:00:00Z",
    });
  });

  it("detects a reply in a thread we joined mid-way (root not ours)", () => {
    const comments = [
      comment({ id: 200, author: "alice", createdAt: "2026-07-14T09:00:00Z" }),
      comment({ id: 201, inReplyToId: 200, author: "shepherd", createdAt: "2026-07-14T10:00:00Z" }),
      comment({ id: 202, inReplyToId: 200, author: "alice", body: "responding to you", createdAt: "2026-07-14T11:00:00Z" }),
    ];
    const replies = findNewReplies(comments, "shepherd", null);
    expect(replies).toHaveLength(1);
    expect(replies[0].rootId).toBe(200);
    expect(replies[0].body).toBe("responding to you");
  });

  it("ignores threads we never participated in", () => {
    const comments = [
      comment({ id: 300, author: "alice", createdAt: "2026-07-14T09:00:00Z" }),
      comment({ id: 301, inReplyToId: 300, author: "bob", createdAt: "2026-07-14T10:00:00Z" }),
    ];
    expect(findNewReplies(comments, "shepherd", null)).toHaveLength(0);
  });

  it("ignores our own comments (loop guard) and matches identity case-insensitively", () => {
    const comments = [
      comment({ id: 400, author: "Shepherd", createdAt: "2026-07-14T10:00:00Z" }),
      comment({ id: 401, inReplyToId: 400, author: "alice", createdAt: "2026-07-14T11:00:00Z" }),
      comment({ id: 402, inReplyToId: 400, author: "SHEPHERD", body: "our in-thread response", createdAt: "2026-07-14T12:00:00Z" }),
    ];
    // Our 12:00 response is the latest OUR comment; alice's 11:00 reply is
    // before it, so nothing is pending.
    expect(findNewReplies(comments, "shepherd", null)).toHaveLength(0);
  });

  it("ignores replies older than our last comment in the thread", () => {
    const comments = [
      comment({ id: 500, author: "shepherd", createdAt: "2026-07-14T10:00:00Z" }),
      comment({ id: 501, inReplyToId: 500, author: "alice", createdAt: "2026-07-14T11:00:00Z" }),
      comment({ id: 502, inReplyToId: 500, author: "shepherd", createdAt: "2026-07-14T12:00:00Z" }),
      comment({ id: 503, inReplyToId: 500, author: "alice", body: "round two", createdAt: "2026-07-14T13:00:00Z" }),
    ];
    const replies = findNewReplies(comments, "shepherd", null);
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toBe("round two");
  });

  it("excludes replies at or before the cursor", () => {
    const comments = [
      comment({ id: 600, author: "shepherd", createdAt: "2026-07-14T10:00:00Z" }),
      comment({ id: 601, inReplyToId: 600, author: "alice", createdAt: "2026-07-14T11:00:00Z" }),
      comment({ id: 602, inReplyToId: 600, author: "alice", body: "newer", createdAt: "2026-07-14T12:00:00Z" }),
    ];
    const replies = findNewReplies(comments, "shepherd", "2026-07-14T11:00:00Z");
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toBe("newer");
  });

  it("returns replies across threads sorted oldest-first", () => {
    const comments = [
      comment({ id: 700, author: "shepherd", createdAt: "2026-07-14T09:00:00Z" }),
      comment({ id: 800, author: "shepherd", createdAt: "2026-07-14T09:00:00Z", path: "src/bar.ts" }),
      comment({ id: 801, inReplyToId: 800, author: "bob", body: "second", createdAt: "2026-07-14T12:00:00Z" }),
      comment({ id: 701, inReplyToId: 700, author: "alice", body: "first", createdAt: "2026-07-14T11:00:00Z" }),
    ];
    const replies = findNewReplies(comments, "shepherd", null);
    expect(replies.map((r) => r.body)).toEqual(["first", "second"]);
  });
});

describe("formatReplyMessage", () => {
  it("quotes multi-line reply bodies line-by-line and includes the thread id in the block header", () => {
    const target = {
      number: 7,
      repo: "acme/widgets",
      title: "feat: sorting",
      url: "https://github.com/acme/widgets/pull/7",
      authored: false,
    };
    const replies = [
      {
        rootId: 100,
        path: "src/a.ts",
        author: "alice",
        body: "line one\nline two\nline three",
        createdAt: "2026-07-14T11:00:00Z",
      },
    ];

    const msg = formatReplyMessage(target, replies);

    expect(msg).toContain("thread 100");
    expect(msg).toContain("> line one");
    expect(msg).toContain("> line two");
    expect(msg).toContain("> line three");
    // Each quoted line appears on its own line, in order.
    const lines = msg.split("\n");
    const idx = lines.indexOf("> line one");
    expect(lines[idx + 1]).toBe("> line two");
    expect(lines[idx + 2]).toBe("> line three");
  });
});

describe("pollReplyWatch", () => {
  const TMP_RW = join(import.meta.dirname, "__tmp_reply_watch");

  function makeConfig(overrides?: Partial<ShepherdConfig>): ShepherdConfig {
    return {
      pollIntervalSeconds: 30,
      staleThresholdHours: 24,
      requiredApprovals: 1,
      mergeStrategy: "squash",
      autoMerge: true,
      dryRun: false,
      dataDir: TMP_RW,
      github: { defaultRepo: null, authorUsername: "shepherd", ignoreRepos: [] },
      reviews: { ignoreUsers: [], botUsers: [], reviewerUsers: [] },
      checks: { requiredChecks: [], ignoreChecks: [] },
      notifications: {
        webhookUrl: null, channel: null, notifyAgent: null,
        onMerge: true, onCIFailure: true, onStale: true, onApproval: true,
      },
      reviewInbox: {
        enabled: false, githubUser: "shepherd", notifyAgent: null, notifyPane: null,
        ignoreRepos: [], ignoreDrafts: true, maxAgeDays: 14, waitForBot: null,
      },
      reviewFollowUp: { enabled: false },
      replyWatch: { enabled: true },
      botFeedback: { maxAttempts: 3 },
      reviewerNudge: { enabled: false, escalateAfterHours: 24, businessDaysOnly: false },
      mergeQueue: { enabled: false },
      ...overrides,
    } as ShepherdConfig;
  }

  const searchResult = JSON.stringify([
    {
      number: 7,
      repository: { name: "widgets", nameWithOwner: "acme/widgets" },
      title: "feat: sorting",
      url: "https://github.com/acme/widgets/pull/7",
    },
  ]);

  const threadWithReply = JSON.stringify([
    { id: 100, user: { login: "shepherd" }, body: "finding", created_at: "2026-07-14T10:00:00Z", path: "src/a.ts" },
    { id: 101, in_reply_to_id: 100, user: { login: "alice" }, body: "I disagree", created_at: "2026-07-14T11:00:00Z", path: "src/a.ts" },
  ]);

  beforeEach(() => {
    mkdirSync(TMP_RW, { recursive: true });
    // resetAllMocks (not clearAllMocks) so leftover queued
    // mockReturnValueOnce values from a prior test's unconsumed queue
    // (e.g. seeding-skip tests that make fewer exec calls than queued)
    // don't bleed into the next test.
    vi.resetAllMocks();
    mockedRoute.mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(TMP_RW, { recursive: true, force: true });
  });

  it("dispatches new replies with transition comment_reply and advances the cursor", async () => {
    // Pre-seed so this PR isn't treated as a first-run discovery (which would
    // seed-and-skip per Fix 5) — exercises the normal scan/dispatch path.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(TMP_RW, "reply-watch.json"),
      JSON.stringify([{ number: 7, repo: "acme/widgets", lastReplyNotifiedAt: "2026-07-14T00:00:00Z" }]),
    );
    mockedExec
      .mockReturnValueOnce(searchResult as unknown as ReturnType<typeof execFileSync>) // reviewed-by search
      .mockReturnValueOnce(threadWithReply as unknown as ReturnType<typeof execFileSync>); // pulls/7/comments

    await pollReplyWatch(makeConfig());

    expect(mockedRoute).toHaveBeenCalledTimes(1);
    const [, msg, opts] = mockedRoute.mock.calls[0];
    expect(msg).toContain("Comment reply: PR #7 (acme/widgets)");
    expect(msg).toContain("@alice");
    expect(msg).toContain("> I disagree");
    expect(msg).toContain("https://github.com/acme/widgets/pull/7");
    expect(opts).toEqual({ transition: "comment_reply" });

    const state = JSON.parse(
      (await import("node:fs")).readFileSync(join(TMP_RW, "reply-watch.json"), "utf-8"),
    ) as Array<{ repo: string; number: number; lastReplyNotifiedAt: string | null }>;
    expect(state).toHaveLength(1);
    expect(state[0].lastReplyNotifiedAt).toBe("2026-07-14T11:00:00Z");
  });

  it("does not re-dispatch replies already behind the cursor", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(TMP_RW, "reply-watch.json"),
      JSON.stringify([{ number: 7, repo: "acme/widgets", lastReplyNotifiedAt: "2026-07-14T11:00:00Z" }]),
    );
    mockedExec
      .mockReturnValueOnce(searchResult as unknown as ReturnType<typeof execFileSync>)
      .mockReturnValueOnce(threadWithReply as unknown as ReturnType<typeof execFileSync>);

    await pollReplyWatch(makeConfig());

    expect(mockedRoute).not.toHaveBeenCalled();
  });

  it("dryRun: no dispatch, no state writes", async () => {
    mockedExec
      .mockReturnValueOnce(searchResult as unknown as ReturnType<typeof execFileSync>)
      .mockReturnValueOnce(threadWithReply as unknown as ReturnType<typeof execFileSync>);

    await pollReplyWatch(makeConfig({ dryRun: true }));

    expect(mockedRoute).not.toHaveBeenCalled();
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(TMP_RW, "reply-watch.json"))).toBe(false);
  });

  it("drops records for PRs that left the discovery union", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(TMP_RW, "reply-watch.json"),
      JSON.stringify([{ number: 999, repo: "acme/old", lastReplyNotifiedAt: "2026-07-01T00:00:00Z" }]),
    );
    mockedExec.mockReturnValueOnce("[]" as unknown as ReturnType<typeof execFileSync>); // search: nothing

    await pollReplyWatch(makeConfig());

    const { readFileSync } = await import("node:fs");
    const state = JSON.parse(readFileSync(join(TMP_RW, "reply-watch.json"), "utf-8"));
    expect(state).toHaveLength(0);
  });

  it("seeds a first-discovered PR without scanning it, and skips no historical backfill", async () => {
    mockedExec.mockReturnValueOnce(searchResult as unknown as ReturnType<typeof execFileSync>); // reviewed-by search only

    await pollReplyWatch(makeConfig());

    // Only the search call — no fetchReviewThreadComments call for the newly
    // discovered PR.
    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(mockedRoute).not.toHaveBeenCalled();

    const { readFileSync } = await import("node:fs");
    const state = JSON.parse(readFileSync(join(TMP_RW, "reply-watch.json"), "utf-8")) as Array<{
      number: number;
      repo: string;
      lastReplyNotifiedAt: string | null;
    }>;
    expect(state).toHaveLength(1);
    expect(state[0].number).toBe(7);
    expect(state[0].lastReplyNotifiedAt).not.toBeNull();
  });

  it("does not advance the cursor when routeToAgent fails, and retries on the next poll", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(TMP_RW, "reply-watch.json"),
      JSON.stringify([{ number: 7, repo: "acme/widgets", lastReplyNotifiedAt: "2026-07-14T00:00:00Z" }]),
    );
    mockedRoute.mockReturnValueOnce(false);
    mockedExec
      .mockReturnValueOnce(searchResult as unknown as ReturnType<typeof execFileSync>)
      .mockReturnValueOnce(threadWithReply as unknown as ReturnType<typeof execFileSync>);

    await pollReplyWatch(makeConfig());

    expect(mockedRoute).toHaveBeenCalledTimes(1);
    const { readFileSync } = await import("node:fs");
    const afterFail = JSON.parse(readFileSync(join(TMP_RW, "reply-watch.json"), "utf-8"));
    expect(afterFail[0].lastReplyNotifiedAt).toBe("2026-07-14T00:00:00Z");

    // Second poll with the same reply still pending (cursor unmoved) —
    // dispatches again.
    mockedRoute.mockReturnValueOnce(true);
    mockedExec
      .mockReturnValueOnce(searchResult as unknown as ReturnType<typeof execFileSync>)
      .mockReturnValueOnce(threadWithReply as unknown as ReturnType<typeof execFileSync>);

    await pollReplyWatch(makeConfig());

    expect(mockedRoute).toHaveBeenCalledTimes(2);
    const afterRetry = JSON.parse(readFileSync(join(TMP_RW, "reply-watch.json"), "utf-8"));
    expect(afterRetry[0].lastReplyNotifiedAt).toBe("2026-07-14T11:00:00Z");
  });

  it("filters out replies from configured reviewerUsers on authored PRs (double-dispatch guard)", async () => {
    const watched: WatchedPR = {
      number: 12,
      repo: "acme/ours",
      title: "our feature",
      url: "https://github.com/acme/ours/pull/12",
      state: "AWAITING_REVIEW",
      headSha: null,
      lastCheckedAt: null,
      lastEventAt: null,
      lastBotCommentNotifiedAt: null,
      botFeedbackCount: 0,
      lastReviewerCommentNotifiedAt: null,
      lastReviewerReviewCommentNotifiedAt: null,
      lastConflictNotifiedAt: null,
    };
    writeCache(TMP_RW, [watched]);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(TMP_RW, "reply-watch.json"),
      JSON.stringify([{ number: 12, repo: "acme/ours", lastReplyNotifiedAt: "2026-07-14T09:00:00Z" }]),
    );

    const threadWithTwoReplies = JSON.stringify([
      { id: 200, user: { login: "shepherd" }, body: "finding", created_at: "2026-07-14T09:00:00Z", path: "src/b.ts" },
      { id: 201, in_reply_to_id: 200, user: { login: "reviewer-bob" }, body: "already handled via review stream", created_at: "2026-07-14T10:00:00Z", path: "src/b.ts" },
      { id: 202, in_reply_to_id: 200, user: { login: "alice" }, body: "a genuine reply-watch reply", created_at: "2026-07-14T11:00:00Z", path: "src/b.ts" },
    ]);

    mockedExec
      .mockReturnValueOnce("[]" as unknown as ReturnType<typeof execFileSync>) // reviewed-by search: empty
      .mockReturnValueOnce(threadWithTwoReplies as unknown as ReturnType<typeof execFileSync>); // pulls/12/comments

    await pollReplyWatch(makeConfig({ reviews: { ignoreUsers: [], botUsers: [], reviewerUsers: ["Reviewer-Bob"] } }));

    expect(mockedRoute).toHaveBeenCalledTimes(1);
    const msg = mockedRoute.mock.calls[0][1];
    expect(msg).toContain("@alice");
    expect(msg).toContain("a genuine reply-watch reply");
    expect(msg).not.toContain("reviewer-bob");
    expect(msg).not.toContain("already handled via review stream");
  });

  it("suppresses dispatch entirely when every reply on an authored PR is from a reviewerUser", async () => {
    const watched: WatchedPR = {
      number: 13,
      repo: "acme/ours",
      title: "our other feature",
      url: "https://github.com/acme/ours/pull/13",
      state: "AWAITING_REVIEW",
      headSha: null,
      lastCheckedAt: null,
      lastEventAt: null,
      lastBotCommentNotifiedAt: null,
      botFeedbackCount: 0,
      lastReviewerCommentNotifiedAt: null,
      lastReviewerReviewCommentNotifiedAt: null,
      lastConflictNotifiedAt: null,
    };
    writeCache(TMP_RW, [watched]);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(TMP_RW, "reply-watch.json"),
      JSON.stringify([{ number: 13, repo: "acme/ours", lastReplyNotifiedAt: "2026-07-14T09:00:00Z" }]),
    );

    const threadReviewerOnly = JSON.stringify([
      { id: 300, user: { login: "shepherd" }, body: "finding", created_at: "2026-07-14T09:00:00Z", path: "src/c.ts" },
      { id: 301, in_reply_to_id: 300, user: { login: "reviewer-bob" }, body: "handled elsewhere", created_at: "2026-07-14T10:00:00Z", path: "src/c.ts" },
    ]);

    mockedExec
      .mockReturnValueOnce("[]" as unknown as ReturnType<typeof execFileSync>)
      .mockReturnValueOnce(threadReviewerOnly as unknown as ReturnType<typeof execFileSync>);

    await pollReplyWatch(makeConfig({ reviews: { ignoreUsers: [], botUsers: [], reviewerUsers: ["reviewer-bob"] } }));

    expect(mockedRoute).not.toHaveBeenCalled();
    const { readFileSync } = await import("node:fs");
    const state = JSON.parse(readFileSync(join(TMP_RW, "reply-watch.json"), "utf-8"));
    expect(state[0].lastReplyNotifiedAt).toBe("2026-07-14T09:00:00Z");
  });

  it("includes watched authored PRs in the scan population", async () => {
    const watched: WatchedPR = {
      number: 12,
      repo: "acme/ours",
      title: "our feature",
      url: "https://github.com/acme/ours/pull/12",
      state: "AWAITING_REVIEW",
      headSha: null,
      lastCheckedAt: null,
      lastEventAt: null,
      lastBotCommentNotifiedAt: null,
      botFeedbackCount: 0,
      lastReviewerCommentNotifiedAt: null,
      lastReviewerReviewCommentNotifiedAt: null,
      lastConflictNotifiedAt: null,
    };
    writeCache(TMP_RW, [watched]);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(TMP_RW, "reply-watch.json"),
      JSON.stringify([{ number: 12, repo: "acme/ours", lastReplyNotifiedAt: "2026-07-14T00:00:00Z" }]),
    );
    mockedExec
      .mockReturnValueOnce("[]" as unknown as ReturnType<typeof execFileSync>) // reviewed-by search: empty
      .mockReturnValueOnce(threadWithReply as unknown as ReturnType<typeof execFileSync>); // pulls/12/comments

    await pollReplyWatch(makeConfig());

    expect(mockedRoute).toHaveBeenCalledTimes(1);
    expect(mockedRoute.mock.calls[0][1]).toContain("PR #12 (acme/ours)");
  });

  it("no-ops when disabled", async () => {
    await pollReplyWatch(makeConfig({ replyWatch: { enabled: false } }));
    expect(mockedExec).not.toHaveBeenCalled();
    expect(mockedRoute).not.toHaveBeenCalled();
  });

  it("passes --owner to the reviewed-by search and drops out-of-org results when org is set", async () => {
    // Search returns an acme PR despite the megacorp --owner qualifier
    mockedExec.mockReturnValueOnce(searchResult as unknown as ReturnType<typeof execFileSync>);

    await pollReplyWatch(
      makeConfig({
        github: { defaultRepo: null, authorUsername: "shepherd", org: "megacorp", ignoreRepos: [] },
      }),
    );

    expect(mockedExec.mock.calls[0][1]).toContain("--owner=megacorp");
    // The out-of-org PR was dropped — no thread fetch for it, never seeded.
    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(mockedRoute).not.toHaveBeenCalled();
  });

  it("omits --owner from the reviewed-by search when org is unset", async () => {
    mockedExec.mockReturnValueOnce("[]" as unknown as ReturnType<typeof execFileSync>);

    await pollReplyWatch(makeConfig());

    expect(
      (mockedExec.mock.calls[0][1] as string[]).some((a) => a.startsWith("--owner")),
    ).toBe(false);
  });

  it("excludes out-of-org cached authored PRs from the scan population", async () => {
    const watched: WatchedPR = {
      number: 12,
      repo: "acme/ours",
      title: "our feature",
      url: "https://github.com/acme/ours/pull/12",
      state: "AWAITING_REVIEW",
      headSha: null,
      lastCheckedAt: null,
      lastEventAt: null,
      lastBotCommentNotifiedAt: null,
      botFeedbackCount: 0,
      lastReviewerCommentNotifiedAt: null,
      lastReviewerReviewCommentNotifiedAt: null,
    };
    writeCache(TMP_RW, [watched]);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(TMP_RW, "reply-watch.json"),
      JSON.stringify([{ number: 12, repo: "acme/ours", lastReplyNotifiedAt: "2026-07-14T00:00:00Z" }]),
    );
    mockedExec.mockReturnValueOnce("[]" as unknown as ReturnType<typeof execFileSync>); // scoped reviewed-by search

    await pollReplyWatch(
      makeConfig({
        github: { defaultRepo: null, authorUsername: "shepherd", org: "megacorp", ignoreRepos: [] },
      }),
    );

    // No thread scan for the out-of-org authored PR.
    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(mockedRoute).not.toHaveBeenCalled();
  });
});
