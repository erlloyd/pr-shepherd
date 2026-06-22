import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import type { ShepherdConfig } from "../src/types.js";

// Mock node:child_process so execFileSync never shells out
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Import the module under test AFTER mocking so it picks up the mock
const { routeToAgent } = await import("../src/ateam-conductor.js");
const { execFileSync } = await import("node:child_process");
const mockedExec = vi.mocked(execFileSync);

function makeConfig(overrides?: Partial<ShepherdConfig>): ShepherdConfig {
  return {
    pollIntervalSeconds: 30,
    staleThresholdHours: 24,
    requiredApprovals: 1,
    mergeStrategy: "squash",
    dryRun: false,
    dataDir: "/tmp/test-shepherd",
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
      enabled: false,
      githubUser: null,
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

describe("ateam-conductor", () => {
  const originalEnv = process.env.PR_SHEPHERD_ATEAM_PATH;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PR_SHEPHERD_ATEAM_PATH;
    // gh head branch lookup returns "feature-x"; ateam exec returns ""
    mockedExec.mockReturnValue("feature-x\n" as unknown as ReturnType<typeof execFileSync>);
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.PR_SHEPHERD_ATEAM_PATH = originalEnv;
    } else {
      delete process.env.PR_SHEPHERD_ATEAM_PATH;
    }
  });

  describe("PR identity parsing — GitHub URL", () => {
    it("parses owner/repo/number and prUrl from a GitHub URL in the message", () => {
      const msg = [
        "[PR Shepherd] Review requested: PR #7 (acme/widgets)",
        '"feat: add sorting"',
        "https://github.com/acme/widgets/pull/7",
        "",
        "You've been requested as a reviewer.",
      ].join("\n");

      routeToAgent(makeConfig(), msg);

      // First call: gh to fetch head branch
      expect(mockedExec).toHaveBeenNthCalledWith(
        1,
        "gh",
        ["pr", "view", "7", "-R", "acme/widgets", "--json", "headRefName", "-q", ".headRefName"],
        expect.objectContaining({ encoding: "utf-8" }),
      );

      // Second call: ateam route-pr-event
      const [bin, args] = mockedExec.mock.calls[1] as [string, string[]];
      expect(bin).toBe("ateam");
      expect(args[0]).toBe("route-pr-event");
      expect(args).toContain("--repo");
      expect(args[args.indexOf("--repo") + 1]).toBe("acme/widgets");
      expect(args).toContain("--pr-number");
      expect(args[args.indexOf("--pr-number") + 1]).toBe("7");
      expect(args).toContain("--head-branch");
      expect(args[args.indexOf("--head-branch") + 1]).toBe("feature-x");
      expect(args).toContain("--transition");
      expect(args[args.indexOf("--transition") + 1]).toBe("other");
      expect(args).toContain("--pr-url");
      expect(args[args.indexOf("--pr-url") + 1]).toBe("https://github.com/acme/widgets/pull/7");
      expect(args).toContain("--body-file");
    });
  });

  describe("PR identity parsing — short form", () => {
    it("parses owner/repo/number from #N (owner/repo) form", () => {
      const msg = "[PR Shepherd] PR #42 (acme/widgets) — CI Failed\n\nThe following checks failed:\n\n- lint\n";

      routeToAgent(makeConfig(), msg);

      const [bin, args] = mockedExec.mock.calls[1] as [string, string[]];
      expect(bin).toBe("ateam");
      expect(args[args.indexOf("--repo") + 1]).toBe("acme/widgets");
      expect(args[args.indexOf("--pr-number") + 1]).toBe("42");
      expect(args).not.toContain("--pr-url");
    });
  });

  describe("transition flag", () => {
    it("passes review_requested when reviewRequest=true", () => {
      const msg = "[PR Shepherd] PR #10 (org/repo) — Review requested";

      routeToAgent(makeConfig(), msg, { reviewRequest: true });

      const [, args] = mockedExec.mock.calls[1] as [string, string[]];
      expect(args[args.indexOf("--transition") + 1]).toBe("review_requested");
    });

    it("passes other when reviewRequest is omitted", () => {
      const msg = "[PR Shepherd] PR #10 (org/repo) — CI Failed";

      routeToAgent(makeConfig(), msg);

      const [, args] = mockedExec.mock.calls[1] as [string, string[]];
      expect(args[args.indexOf("--transition") + 1]).toBe("other");
    });
  });

  describe("ateam binary resolution", () => {
    it("uses PR_SHEPHERD_ATEAM_PATH env var when set", () => {
      process.env.PR_SHEPHERD_ATEAM_PATH = "/usr/local/bin/my-ateam";
      const msg = "[PR Shepherd] PR #5 (x/y) — Merged successfully.";

      routeToAgent(makeConfig(), msg);

      const [bin] = mockedExec.mock.calls[1] as [string, string[]];
      expect(bin).toBe("/usr/local/bin/my-ateam");
    });

    it("defaults to 'ateam' when env var not set", () => {
      const msg = "[PR Shepherd] PR #5 (x/y) — Merged successfully.";

      routeToAgent(makeConfig(), msg);

      const [bin] = mockedExec.mock.calls[1] as [string, string[]];
      expect(bin).toBe("ateam");
    });
  });

  describe("dry-run", () => {
    it("skips exec and logs dry-run message", () => {
      const config = makeConfig({ dryRun: true });
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const msg = "[PR Shepherd] PR #99 (a/b) — CI Failed";

      routeToAgent(config, msg);

      expect(mockedExec).not.toHaveBeenCalledWith("ateam", expect.anything(), expect.anything());
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[dry-run]"),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("unparseable message", () => {
    it("logs and returns without exec when PR identity cannot be parsed", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const msg = "Hello world — no PR reference here";

      routeToAgent(makeConfig(), msg);

      // Only one exec (none at all — gh head fetch shouldn't happen either)
      expect(mockedExec).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("couldn't parse PR identity"),
      );
      consoleSpy.mockRestore();
    });
  });

  describe("ateam exec error", () => {
    it("logs but does not throw on ateam exec failure", () => {
      // First call (gh) succeeds; second call (ateam) throws
      mockedExec
        .mockReturnValueOnce("feature-x\n" as unknown as ReturnType<typeof execFileSync>)
        .mockImplementationOnce(() => { throw new Error("ateam not found"); });

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const msg = "[PR Shepherd] PR #3 (foo/bar) — CI Failed";

      expect(() => routeToAgent(makeConfig(), msg)).not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("ateam route-pr-event failed"));
      consoleSpy.mockRestore();
    });
  });

  describe("tmp file cleanup", () => {
    it("cleans up the tmp body file after exec", () => {
      const msg = "[PR Shepherd] PR #1 (a/b) — CI Failed";
      routeToAgent(makeConfig(), msg);

      // Find the --body-file arg
      const [, args] = mockedExec.mock.calls[1] as [string, string[]];
      const bodyFile = args[args.indexOf("--body-file") + 1];
      // File should have been deleted already
      expect(existsSync(bodyFile)).toBe(false);
    });
  });
});
