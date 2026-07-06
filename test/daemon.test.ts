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
