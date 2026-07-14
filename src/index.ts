#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig } from "./config.js";
import { startDaemon, discoverAuthoredPRs } from "./daemon.js";
import { readEvents, readEventsForPR } from "./events.js";
import { readCache } from "./state-cache.js";
import { readInbox } from "./review-inbox.js";
import { setVerbose } from "./log.js";
import { existsSync } from "node:fs";

// Auto-load .env (e.g. PR_SHEPHERD_ATEAM_PATH) from the working dir if present.
// Existing process.env values take precedence.
if (existsSync(".env")) process.loadEnvFile(".env");

const program = new Command();

program
  .name("pr-shepherd")
  .description("Automated PR lifecycle management for AI coding agents")
  .version("0.2.0");

program
  .command("start")
  .description("Start the polling daemon")
  .option("-c, --config <path>", "Path to shepherd.config.json")
  .option("--dry-run", "Log actions without executing them")
  .option("--verbose", "Enable verbose (debug-level) logging")
  .option("--interval <seconds>", "Poll interval in seconds", parseInt)
  .action(async (opts) => {
    const overrides: Record<string, unknown> = {};
    if (opts.dryRun) overrides.dryRun = true;
    if (opts.interval) overrides.pollIntervalSeconds = opts.interval;

    setVerbose(Boolean(opts.verbose) || process.env.PR_SHEPHERD_VERBOSE === "true");
    const config = loadConfig(opts.config, overrides);
    await startDaemon(config);
  });

program
  .command("status")
  .description("Show open PRs being watched and their current state")
  .option("-c, --config <path>", "Path to shepherd.config.json")
  .action((opts) => {
    const config = loadConfig(opts.config);
    const cached = readCache(config.dataDir);

    if (cached.length === 0) {
      console.log("No PRs in state cache. Run 'pr-shepherd start' to begin watching.");
      return;
    }

    console.log(
      `\n${"PR".padEnd(8)} ${"Repo".padEnd(30)} ${"State".padEnd(22)} ${"Title"}`,
    );
    console.log("-".repeat(100));
    for (const pr of cached) {
      const title = pr.title.length > 38 ? pr.title.slice(0, 37) + "…" : pr.title;
      console.log(
        `#${String(pr.number).padEnd(7)} ${pr.repo.padEnd(30)} ${pr.state.padEnd(22)} ${title}`,
      );
    }
    console.log();
  });

program
  .command("events")
  .description("Show event log")
  .option("--pr <number>", "Filter by PR number", parseInt)
  .option("--repo <repo>", "Filter by repository")
  .option("-n, --last <count>", "Show last N events", parseInt)
  .option("-c, --config <path>", "Path to shepherd.config.json")
  .action((opts) => {
    const config = loadConfig(opts.config);
    let events = opts.pr
      ? readEventsForPR(config.dataDir, opts.pr, opts.repo)
      : readEvents(config.dataDir);

    if (opts.last) {
      events = events.slice(-opts.last);
    }

    if (events.length === 0) {
      console.log("No events recorded.");
      return;
    }

    console.log(
      `\n${"Time".padEnd(22)} ${"PR".padEnd(8)} ${"Event".padEnd(22)} ${"From".padEnd(22)} → To`,
    );
    console.log("-".repeat(100));
    for (const e of events) {
      console.log(
        `${e.ts.slice(0, 19).padEnd(22)} #${String(e.pr).padEnd(7)} ${e.event.padEnd(22)} ${e.from.padEnd(22)} → ${e.to}`,
      );
    }
    console.log();
  });

program
  .command("inbox")
  .description("Show pending review assignments")
  .option("-c, --config <path>", "Path to shepherd.config.json")
  .action((opts) => {
    const config = loadConfig(opts.config);
    const assignments = readInbox(config.dataDir);

    if (assignments.length === 0) {
      console.log("No pending review assignments.");
      return;
    }

    console.log(
      `\n${"PR".padEnd(8)} ${"Repo".padEnd(30)} ${"Status".padEnd(22)} ${"Title"}`,
    );
    console.log("-".repeat(100));
    for (const a of assignments) {
      const title = a.title.length > 38 ? a.title.slice(0, 37) + "…" : a.title;
      console.log(
        `#${String(a.number).padEnd(7)} ${a.repo.padEnd(30)} ${a.status.padEnd(22)} ${title}`,
      );
    }
    console.log();
  });

program.parse();
