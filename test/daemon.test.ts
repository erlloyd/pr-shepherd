import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { filterAuthoredPRs, pollAll } from "../src/daemon.js";
import { DEFAULTS } from "../src/config.js";
import { upsertCachedPR, readCache } from "../src/state-cache.js";
import type { ShepherdConfig, WatchedPR } from "../src/types.js";

// Mock node:child_process so execFileSync never shells out in pollAll tests
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Mock ateam-conductor so routeToAgent never execs
vi.mock("../src/ateam-conductor.js", () => ({
  routeToAgent: vi.fn(),
}));

function makePR(nameWithOwner: string, isDraft = false, number = 1) {
  return {
    number,
    repository: { name: nameWithOwner.split("/")[1], nameWithOwner },
    title: "test PR",
    url: `https://github.com/${nameWithOwner}/pull/${number}`,
    isDraft,
    updatedAt: new Date().toISOString(),
  };
}

describe("filterAuthoredPRs", () => {
  it("keeps PRs from non-ignored repos", () => {
    const prs = [makePR("erlloyd/agent-teams", false, 1)];
    const result = filterAuthoredPRs(prs, ["erlloyd/cardtable2"]);
    expect(result).toHaveLength(1);
    expect(result[0].repository.nameWithOwner).toBe("erlloyd/agent-teams");
  });

  it("drops PRs from ignored repos", () => {
    const prs = [
      makePR("erlloyd/cardtable2", false, 5),
      makePR("erlloyd/vscode-remote-demo1", false, 6),
      makePR("erlloyd/agent-teams", false, 7),
    ];
    const result = filterAuthoredPRs(prs, [
      "erlloyd/cardtable2",
      "erlloyd/vscode-remote-demo1",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].repository.nameWithOwner).toBe("erlloyd/agent-teams");
  });

  it("drops draft PRs regardless of ignoreRepos", () => {
    const prs = [
      makePR("erlloyd/agent-teams", true, 10),
      makePR("erlloyd/agent-teams", false, 11),
    ];
    const result = filterAuthoredPRs(prs, []);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(11);
  });

  it("passes all PRs through when ignoreRepos is empty", () => {
    const prs = [
      makePR("erlloyd/cardtable2", false, 1),
      makePR("erlloyd/agent-teams", false, 2),
    ];
    const result = filterAuthoredPRs(prs, []);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when all PRs are ignored", () => {
    const prs = [
      makePR("erlloyd/cardtable2", false, 1),
      makePR("erlloyd/vscode-remote-demo1", false, 2),
    ];
    const result = filterAuthoredPRs(prs, [
      "erlloyd/cardtable2",
      "erlloyd/vscode-remote-demo1",
    ]);
    expect(result).toHaveLength(0);
  });

  it("drops PRs outside the configured org", () => {
    const prs = [
      makePR("acme/widgets", false, 1),
      makePR("megacorp/widgets", false, 2),
    ];
    const result = filterAuthoredPRs(prs, [], "acme");
    expect(result).toHaveLength(1);
    expect(result[0].repository.nameWithOwner).toBe("acme/widgets");
  });

  it("passes PRs from any org when org is null", () => {
    const prs = [
      makePR("acme/widgets", false, 1),
      makePR("megacorp/widgets", false, 2),
    ];
    expect(filterAuthoredPRs(prs, [], null)).toHaveLength(2);
    expect(filterAuthoredPRs(prs, [])).toHaveLength(2);
  });
});

describe("pollAll — reconciling PRs that dropped out of the open set", () => {
  const TMP = join(import.meta.dirname, "__tmp_daemon_reconcile");

  let mockedExec: ReturnType<typeof vi.mocked<any>>;
  let mockedRoute: ReturnType<typeof vi.mocked<any>>;

  beforeEach(async () => {
    mkdirSync(TMP, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    const { routeToAgent } = await import("../src/ateam-conductor.js");
    mockedExec = vi.mocked(execFileSync);
    mockedRoute = vi.mocked(routeToAgent);
    mockedExec.mockReset();
    mockedRoute.mockReset();
  });

  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  function makeConfig(): ShepherdConfig {
    return {
      ...JSON.parse(JSON.stringify(DEFAULTS)),
      dataDir: TMP,
      dryRun: false,
      github: { defaultRepo: null, authorUsername: "erlloyd", ignoreRepos: [] },
      notifications: { ...DEFAULTS.notifications, notifyAgent: "worker" },
    };
  }

  function cachedPR(overrides?: Partial<WatchedPR>): WatchedPR {
    return {
      number: 3883,
      repo: "acme/widgets",
      title: "feat: something",
      url: "https://github.com/acme/widgets/pull/3883",
      state: "AUTO_MERGE_ENABLED",
      headSha: "abc123",
      lastCheckedAt: "2026-07-03T16:01:42.000Z",
      lastEventAt: "2026-07-03T16:01:42.000Z",
      lastBotCommentNotifiedAt: null,
      botFeedbackCount: 0,
      lastReviewerCommentNotifiedAt: null,
      lastReviewerReviewCommentNotifiedAt: null,
      ...overrides,
    };
  }

  it("notifies and removes from cache when a PR merged between polls (missed the open-PR search)", async () => {
    const config = makeConfig();
    upsertCachedPR(TMP, cachedPR());

    mockedExec
      .mockReturnValueOnce("[]" as any) // discoverAuthoredPRs — nothing open anymore
      .mockReturnValueOnce(
        JSON.stringify({ number: 3883, state: "MERGED", headRefOid: "abc123" }) as any,
      ); // fetchPRView for the cached PR

    await pollAll(config);

    expect(readCache(TMP)).toHaveLength(0);
    expect(mockedRoute).toHaveBeenCalledTimes(1);
    expect(mockedRoute.mock.calls[0][1]).toContain("Merged");
  });

  it("removes from cache silently (no notification) when the PR was closed without merging", async () => {
    const config = makeConfig();
    upsertCachedPR(TMP, cachedPR());

    mockedExec
      .mockReturnValueOnce("[]" as any)
      .mockReturnValueOnce(
        JSON.stringify({ number: 3883, state: "CLOSED", headRefOid: "abc123" }) as any,
      );

    await pollAll(config);

    expect(readCache(TMP)).toHaveLength(0);
    expect(mockedRoute).not.toHaveBeenCalled();
  });

  it("leaves the PR cached if its live state unexpectedly still reads OPEN", async () => {
    const config = makeConfig();
    upsertCachedPR(TMP, cachedPR());

    mockedExec
      .mockReturnValueOnce("[]" as any)
      .mockReturnValueOnce(
        JSON.stringify({ number: 3883, state: "OPEN", headRefOid: "abc123" }) as any,
      );

    await pollAll(config);

    expect(readCache(TMP)).toHaveLength(1);
    expect(mockedRoute).not.toHaveBeenCalled();
  });

  it("falls back to silent removal when the live state can't be fetched", async () => {
    const config = makeConfig();
    upsertCachedPR(TMP, cachedPR());

    mockedExec.mockReturnValueOnce("[]" as any).mockImplementationOnce(() => {
      throw new Error("gh: repository not found");
    });

    await pollAll(config);

    expect(readCache(TMP)).toHaveLength(0);
    expect(mockedRoute).not.toHaveBeenCalled();
  });
});

describe("pollAll — org scoping", () => {
  const TMP = join(import.meta.dirname, "__tmp_daemon_org");

  let mockedExec: ReturnType<typeof vi.mocked<any>>;
  let mockedRoute: ReturnType<typeof vi.mocked<any>>;

  beforeEach(async () => {
    mkdirSync(TMP, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    const { routeToAgent } = await import("../src/ateam-conductor.js");
    mockedExec = vi.mocked(execFileSync);
    mockedRoute = vi.mocked(routeToAgent);
    mockedExec.mockReset();
    mockedRoute.mockReset();
  });

  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  function makeConfig(org: string | null): ShepherdConfig {
    return {
      ...JSON.parse(JSON.stringify(DEFAULTS)),
      dataDir: TMP,
      dryRun: false,
      github: { defaultRepo: null, authorUsername: "erlloyd", org, ignoreRepos: [] },
      notifications: { ...DEFAULTS.notifications, notifyAgent: "worker" },
    };
  }

  function cachedPR(repo: string): WatchedPR {
    return {
      number: 12,
      repo,
      title: "feat: something",
      url: `https://github.com/${repo}/pull/12`,
      state: "AWAITING_REVIEW",
      headSha: "abc123",
      lastCheckedAt: "2026-07-03T16:01:42.000Z",
      lastEventAt: "2026-07-03T16:01:42.000Z",
      lastBotCommentNotifiedAt: null,
      botFeedbackCount: 0,
      lastReviewerCommentNotifiedAt: null,
      lastReviewerReviewCommentNotifiedAt: null,
    };
  }

  it("passes --owner to the authored-PR search when org is set", async () => {
    mockedExec.mockReturnValueOnce("[]" as any);
    await pollAll(makeConfig("acme"));
    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(mockedExec.mock.calls[0][1]).toContain("--owner=acme");
  });

  it("omits --owner when org is unset", async () => {
    mockedExec.mockReturnValueOnce("[]" as any);
    await pollAll(makeConfig(null));
    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(mockedExec.mock.calls[0][1]).not.toContain("--owner=acme");
    expect(
      (mockedExec.mock.calls[0][1] as string[]).some((a) => a.startsWith("--owner")),
    ).toBe(false);
  });

  it("re-filters out-of-org search results defensively (never polls them)", async () => {
    mockedExec.mockReturnValueOnce(
      JSON.stringify([
        {
          number: 12,
          repository: { name: "widgets", nameWithOwner: "megacorp/widgets" },
          title: "feat: something",
          url: "https://github.com/megacorp/widgets/pull/12",
          isDraft: false,
          updatedAt: new Date().toISOString(),
        },
      ]) as any,
    );

    await pollAll(makeConfig("acme"));

    // Only the search itself ran — no fetchPRView/checks/reviews for the
    // out-of-org PR, and it never entered the cache.
    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(readCache(TMP)).toHaveLength(0);
    expect(mockedRoute).not.toHaveBeenCalled();
  });

  it("drains a cached out-of-org PR silently instead of polling it forever", async () => {
    upsertCachedPR(TMP, cachedPR("megacorp/widgets"));

    mockedExec.mockReturnValueOnce("[]" as any); // scoped search — nothing

    await pollAll(makeConfig("acme"));

    // Removed from cache without fetching its live state or notifying.
    expect(mockedExec).toHaveBeenCalledTimes(1);
    expect(readCache(TMP)).toHaveLength(0);
    expect(mockedRoute).not.toHaveBeenCalled();
  });

  it("still reconciles in-org cached PRs when org is set", async () => {
    upsertCachedPR(TMP, cachedPR("acme/widgets"));

    mockedExec
      .mockReturnValueOnce("[]" as any) // scoped search — nothing open anymore
      .mockReturnValueOnce(
        JSON.stringify({ number: 12, state: "MERGED", headRefOid: "abc123" }) as any,
      ); // fetchPRView for the cached in-org PR

    await pollAll(makeConfig("acme"));

    expect(readCache(TMP)).toHaveLength(0);
    expect(mockedRoute).toHaveBeenCalledTimes(1);
    expect(mockedRoute.mock.calls[0][1]).toContain("Merged");
  });
});

describe("pollAll — merge queue entered from AWAITING_REVIEW (manual override)", () => {
  const TMP = join(import.meta.dirname, "__tmp_daemon_mergequeue");

  let mockedExec: ReturnType<typeof vi.mocked<any>>;
  let mockedRoute: ReturnType<typeof vi.mocked<any>>;

  beforeEach(async () => {
    mkdirSync(TMP, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    const { routeToAgent } = await import("../src/ateam-conductor.js");
    mockedExec = vi.mocked(execFileSync);
    mockedRoute = vi.mocked(routeToAgent);
    mockedExec.mockReset();
    mockedRoute.mockReset();
  });

  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  function makeConfig(): ShepherdConfig {
    return {
      ...JSON.parse(JSON.stringify(DEFAULTS)),
      dataDir: TMP,
      dryRun: false,
      autoMerge: false,
      requiredApprovals: 2,
      github: { defaultRepo: null, authorUsername: "erlloyd", ignoreRepos: [] },
      notifications: { ...DEFAULTS.notifications, notifyAgent: "worker" },
      mergeQueue: { enabled: true },
    };
  }

  function cachedPR(): WatchedPR {
    return {
      number: 4107,
      repo: "acme/widgets",
      title: "fix: something",
      url: "https://github.com/acme/widgets/pull/4107",
      state: "AWAITING_REVIEW",
      headSha: "abc123",
      lastCheckedAt: "2026-07-15T13:20:21.000Z",
      lastEventAt: "2026-07-15T13:20:21.000Z",
      lastBotCommentNotifiedAt: null,
      botFeedbackCount: 0,
      lastReviewerCommentNotifiedAt: null,
      lastReviewerReviewCommentNotifiedAt: null,
    };
  }

  it("synthesizes all_approved (with the real, sub-threshold approval count) before entering the queue, and logs both", async () => {
    const config = makeConfig();
    upsertCachedPR(TMP, cachedPR());

    mockedExec
      .mockReturnValueOnce(
        JSON.stringify([
          {
            number: 4107,
            repository: { name: "widgets", nameWithOwner: "acme/widgets" },
            title: "fix: something",
            url: "https://github.com/acme/widgets/pull/4107",
            isDraft: false,
            updatedAt: new Date().toISOString(),
          },
        ]) as any,
      ) // discoverAuthoredPRs
      .mockReturnValueOnce(
        JSON.stringify({
          number: 4107,
          state: "OPEN",
          reviewDecision: "APPROVED",
          mergeStateStatus: "CLEAN",
          mergeable: "MERGEABLE",
          autoMergeRequest: null,
          mergedAt: null,
          closedAt: null,
          headRefOid: "abc123",
        }) as any,
      ) // fetchPRView
      .mockReturnValueOnce("[]" as any) // fetchChecks
      .mockReturnValueOnce(
        JSON.stringify({
          reviews: [
            {
              author: { login: "bloedorn-" },
              state: "APPROVED",
              body: "",
              submittedAt: "2026-07-15T13:19:04Z",
            },
          ],
        }) as any,
      ) // fetchReviews — only 1 approval, below requiredApprovals: 2
      .mockReturnValueOnce(
        JSON.stringify({
          data: { repository: { pullRequest: { isInMergeQueue: true } } },
        }) as any,
      ); // fetchMergeQueueStatus

    await pollAll(config);

    const cached = readCache(TMP);
    expect(cached).toHaveLength(1);
    expect(cached[0].state).toBe("IN_MERGE_QUEUE");

    // Both the (manual-override) approval notification and the merge-queue
    // notification must go out — entering the queue implies approval.
    expect(mockedRoute).toHaveBeenCalledTimes(2);
    expect(mockedRoute.mock.calls[0][1]).toContain("Approved");
    expect(mockedRoute.mock.calls[1][1]).toContain("merge queue");
  });
});
