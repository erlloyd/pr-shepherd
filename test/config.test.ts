import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, DEFAULTS } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TMP = join(import.meta.dirname, "__tmp_config");

function writeJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function clearShepherdEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PR_SHEPHERD_")) delete process.env[key];
  }
}

function withRequiredFields(overrides?: Record<string, unknown>) {
  return {
    github: { authorUsername: "testuser", defaultRepo: null },
    ...overrides,
  };
}

describe("config", () => {
  beforeEach(() => {
    clearShepherdEnv();
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    clearShepherdEnv();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists (with required fields via env)", () => {
    process.env.PR_SHEPHERD_AUTHOR_USERNAME = "testuser";
    const config = loadConfig(join(TMP, "nonexistent.json"));
    expect(config.pollIntervalSeconds).toBe(180);
    expect(config.mergeStrategy).toBe("squash");
    expect(config.autoMerge).toBe(true);
    expect(config.dryRun).toBe(false);
  });

  it("allows disabling auto-merge", () => {
    const path = join(TMP, "no-automerge.json");
    writeJson(path, { autoMerge: false, github: { authorUsername: "testuser" } });
    const config = loadConfig(path);
    expect(config.autoMerge).toBe(false);
  });

  it("accepts minimal config with only authorUsername", () => {
    const path = join(TMP, "minimal.json");
    writeJson(path, { github: { authorUsername: "testuser" } });
    const config = loadConfig(path);
    expect(config.github.authorUsername).toBe("testuser");
    expect(config.reviewInbox.enabled).toBe(false);
  });

  it("merges file config over defaults", () => {
    const path = join(TMP, "test.json");
    writeJson(path, {
      pollIntervalSeconds: 60,
      ...withRequiredFields(),
    });
    const config = loadConfig(path);
    expect(config.pollIntervalSeconds).toBe(60);
    expect(config.github.authorUsername).toBe("testuser");
    expect(config.mergeStrategy).toBe("squash");
  });

  it("applies env overrides over file config", () => {
    const path = join(TMP, "test.json");
    writeJson(path, { pollIntervalSeconds: 60, ...withRequiredFields() });
    process.env.PR_SHEPHERD_POLL_INTERVAL = "30";
    process.env.PR_SHEPHERD_WEBHOOK_URL = "https://hooks.example.com/test";
    const config = loadConfig(path);
    expect(config.pollIntervalSeconds).toBe(30);
    expect(config.notifications.webhookUrl).toBe("https://hooks.example.com/test");
  });

  it("applies CLI overrides last", () => {
    const path = join(TMP, "test.json");
    writeJson(path, { pollIntervalSeconds: 60, ...withRequiredFields() });
    process.env.PR_SHEPHERD_POLL_INTERVAL = "30";
    const config = loadConfig(path, { pollIntervalSeconds: 15 });
    expect(config.pollIntervalSeconds).toBe(15);
  });

  it("validates pollIntervalSeconds >= 10", () => {
    const path = join(TMP, "test.json");
    writeJson(path, { pollIntervalSeconds: 5, ...withRequiredFields() });
    expect(() => loadConfig(path)).toThrowError("pollIntervalSeconds must be >= 10");
  });

  it("validates mergeStrategy", () => {
    const path = join(TMP, "test.json");
    writeJson(path, { mergeStrategy: "yolo", ...withRequiredFields() });
    expect(() => loadConfig(path)).toThrowError("mergeStrategy must be one of");
  });

  it("validates authorUsername is required", () => {
    expect(() => loadConfig(join(TMP, "nonexistent.json"))).toThrowError(
      "github.authorUsername is required",
    );
  });

  it("handles PR_SHEPHERD_DRY_RUN env var", () => {
    process.env.PR_SHEPHERD_DRY_RUN = "true";
    process.env.PR_SHEPHERD_AUTHOR_USERNAME = "testuser";
    const config = loadConfig(join(TMP, "nonexistent.json"));
    expect(config.dryRun).toBe(true);
  });

  it("deep merges nested objects without clobbering sibling keys", () => {
    const path = join(TMP, "test.json");
    writeJson(path, {
      github: { authorUsername: "testuser", defaultRepo: null },
      notifications: { onMerge: false },
    });
    const config = loadConfig(path);
    expect(config.notifications.onMerge).toBe(false);
    expect(config.notifications.onCIFailure).toBe(true);
    expect(config.notifications.webhookUrl).toBeNull();
  });

  it("validates reviewInbox requires githubUser when enabled", () => {
    const path = join(TMP, "test.json");
    writeJson(path, {
      ...withRequiredFields(),
      reviewInbox: {
        enabled: true,
        githubUser: null,
        ignoreRepos: [],
        ignoreDrafts: true,
        maxAgeDays: 5,
      },
    });
    expect(() => loadConfig(path)).toThrowError("reviewInbox.githubUser is required");
  });
});
