import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ShepherdConfig, MergeStrategy } from "./types.js";

const DEFAULTS: ShepherdConfig = {
  pollIntervalSeconds: 180,
  staleThresholdHours: 4,
  requiredApprovals: 1,
  mergeStrategy: "squash",
  autoMerge: true,
  dryRun: false,
  dataDir: "./data",

  github: {
    defaultRepo: null,
    authorUsername: null,
    ignoreRepos: [],
  },

  reviews: {
    ignoreUsers: [],
    botUsers: [],
    reviewerUsers: [],
  },

  checks: {
    requiredChecks: [],
    ignoreChecks: [],
  },

  notifications: {
    webhookUrl: null,
    channel: null,
    notifyAgent: null,
    onMerge: true,
    onCIFailure: true,
    onStale: true,
    onApproval: true,
  },

  reviewInbox: {
    enabled: false,
    githubUser: null,
    notifyAgent: null,
    notifyPane: null,
    ignoreRepos: [],
    ignoreDrafts: true,
    maxAgeDays: 5,
    waitForBot: null,
  },

  reviewFollowUp: {
    enabled: false,
  },

  botFeedback: {
    maxAttempts: 2,
  },

  reviewerNudge: {
    enabled: false,
    escalateAfterHours: 24,
    businessDaysOnly: true,
  },

  mergeQueue: {
    enabled: false,
  },
};

const VALID_MERGE_STRATEGIES: ReadonlySet<string> = new Set([
  "squash",
  "merge",
  "rebase",
]);

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>,
): T {
  const result = { ...base };
  for (const key of Object.keys(override) as Array<keyof T>) {
    const val = override[key];
    if (
      val !== undefined &&
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof base[key] === "object" &&
      base[key] !== null &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(
        base[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      ) as T[keyof T];
    } else if (val !== undefined) {
      result[key] = val as T[keyof T];
    }
  }
  return result;
}

function applyEnvOverrides(config: ShepherdConfig): ShepherdConfig {
  const env = process.env;

  if (env.PR_SHEPHERD_DATA_DIR) config.dataDir = env.PR_SHEPHERD_DATA_DIR;
  if (env.PR_SHEPHERD_WEBHOOK_URL)
    config.notifications.webhookUrl = env.PR_SHEPHERD_WEBHOOK_URL;
  if (env.PR_SHEPHERD_POLL_INTERVAL) {
    const v = parseInt(env.PR_SHEPHERD_POLL_INTERVAL, 10);
    if (!isNaN(v)) config.pollIntervalSeconds = v;
  }
  if (env.PR_SHEPHERD_STALE_HOURS) {
    const v = parseInt(env.PR_SHEPHERD_STALE_HOURS, 10);
    if (!isNaN(v)) config.staleThresholdHours = v;
  }
  if (env.PR_SHEPHERD_REQUIRED_APPROVALS) {
    const v = parseInt(env.PR_SHEPHERD_REQUIRED_APPROVALS, 10);
    if (!isNaN(v)) config.requiredApprovals = v;
  }
  if (env.PR_SHEPHERD_DRY_RUN) config.dryRun = env.PR_SHEPHERD_DRY_RUN === "true";
  if (env.PR_SHEPHERD_DEFAULT_REPO)
    config.github.defaultRepo = env.PR_SHEPHERD_DEFAULT_REPO;
  if (env.PR_SHEPHERD_AUTHOR_USERNAME)
    config.github.authorUsername = env.PR_SHEPHERD_AUTHOR_USERNAME;
  if (env.PR_SHEPHERD_NOTIFY_AGENT)
    config.notifications.notifyAgent = env.PR_SHEPHERD_NOTIFY_AGENT;
  if (env.PR_SHEPHERD_REVIEW_INBOX_USER)
    config.reviewInbox.githubUser = env.PR_SHEPHERD_REVIEW_INBOX_USER;
  if (env.PR_SHEPHERD_REVIEW_INBOX_AGENT)
    config.reviewInbox.notifyAgent = env.PR_SHEPHERD_REVIEW_INBOX_AGENT;
  if (env.PR_SHEPHERD_REVIEW_INBOX_PANE)
    config.reviewInbox.notifyPane = env.PR_SHEPHERD_REVIEW_INBOX_PANE;
  if (env.PR_SHEPHERD_REVIEW_INBOX_ENABLED)
    config.reviewInbox.enabled = env.PR_SHEPHERD_REVIEW_INBOX_ENABLED === "true";

  return config;
}

function validate(config: ShepherdConfig): string[] {
  const errors: string[] = [];

  if (config.pollIntervalSeconds < 10)
    errors.push("pollIntervalSeconds must be >= 10");
  if (config.staleThresholdHours < 0)
    errors.push("staleThresholdHours must be >= 0");
  if (config.requiredApprovals < 0)
    errors.push("requiredApprovals must be >= 0");
  if (!VALID_MERGE_STRATEGIES.has(config.mergeStrategy))
    errors.push(
      `mergeStrategy must be one of: ${[...VALID_MERGE_STRATEGIES].join(", ")}`,
    );
  if (!config.github.authorUsername)
    errors.push("github.authorUsername is required — set it in config or PR_SHEPHERD_AUTHOR_USERNAME");
  if (config.reviewInbox.enabled && !config.reviewInbox.githubUser)
    errors.push(
      "reviewInbox.githubUser is required when reviewInbox is enabled",
    );

  return errors;
}

export function loadConfig(
  configPath?: string,
  cliOverrides?: Partial<ShepherdConfig>,
): ShepherdConfig {
  let fileConfig: Partial<ShepherdConfig> = {};

  const resolvedPath = configPath
    ? resolve(configPath)
    : resolve("shepherd.config.json");

  if (existsSync(resolvedPath)) {
    const raw = readFileSync(resolvedPath, "utf-8");
    fileConfig = JSON.parse(raw) as Partial<ShepherdConfig>;
  }

  const defaults = JSON.parse(JSON.stringify(DEFAULTS)) as ShepherdConfig;
  let config = deepMerge(defaults, fileConfig);
  config = applyEnvOverrides(config);

  if (cliOverrides) {
    config = deepMerge(config, cliOverrides);
  }

  const errors = validate(config);
  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  ${errors.join("\n  ")}`);
  }

  return config;
}

export { DEFAULTS };
