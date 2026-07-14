# Console Logging Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One consistent, leveled, verbosity-gated console format across the daemon, with a single heartbeat line per quiet poll cycle.

**Architecture:** New `src/log.ts` logger (`createLogger(subsystem)` → info/warn/error/debug, module-level `setVerbose`). All daemon-path modules convert to it per the spec's level mapping; daemon prints a per-cycle heartbeat from counts the pollers return; conductor echoes get truncated. CLI table output in `src/index.ts` stays bare console.log.

**Tech Stack:** TypeScript + vitest, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-14-console-logging-design.md` — read it first; its level mapping is normative.

## Global Constraints

- Branch: `re-review-on-re-request` (already checked out). Gates: `npx vitest run` (full), `npm run typecheck`.
- Format exactly: `HH:MM:SS LEVEL [subsystem] message` — local time via `toLocaleTimeString("en-GB")` (24h HH:MM:SS), level tokens padded to 5 chars (`INFO `, `WARN `, `ERROR`, `DEBUG`).
- `info`/`debug` → `console.log`; `warn`/`error` → `console.error`.
- `debug` gated: visible only after `setVerbose(true)` (wired from `--verbose` flag on the `start` command or `PR_SHEPHERD_VERBOSE=true`).
- Do NOT touch: `src/events.ts` behavior, message bodies sent to agents, `src/index.ts` subcommand table output, test assertions' semantic content (wording that tests assert on must be preserved inside the new format).
- No suppression comments; match existing style.

---

### Task 1: `src/log.ts` + verbosity wiring

**Files:**
- Create: `src/log.ts`
- Modify: `src/index.ts` (add `--verbose` to the `start` command; call `setVerbose`)
- Test: `test/log.test.ts` (new)

**Interfaces:**
- Produces (Task 2 relies on these exactly):

```ts
export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};
export function createLogger(subsystem: string): Logger;
export function setVerbose(v: boolean): void;
```

- [ ] **Step 1: Write the failing tests**

Create `test/log.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLogger, setVerbose } from "../src/log.js";

describe("logger", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    logSpy.mockClear();
    errSpy.mockClear();
    setVerbose(false);
  });

  afterEach(() => {
    setVerbose(false);
  });

  it("formats as HH:MM:SS LEVEL [subsystem] message", () => {
    createLogger("review-inbox").info("hello world");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/^\d{2}:\d{2}:\d{2} INFO  \[review-inbox\] hello world$/);
  });

  it("routes warn and error to stderr with level tokens", () => {
    const log = createLogger("daemon");
    log.warn("careful");
    log.error("boom");
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0]).toMatch(/^\d{2}:\d{2}:\d{2} WARN  \[daemon\] careful$/);
    expect(errSpy.mock.calls[1][0]).toMatch(/^\d{2}:\d{2}:\d{2} ERROR \[daemon\] boom$/);
  });

  it("suppresses debug unless verbose", () => {
    const log = createLogger("conductor");
    log.debug("hidden");
    expect(logSpy).not.toHaveBeenCalled();
    setVerbose(true);
    log.debug("visible");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toMatch(/^\d{2}:\d{2}:\d{2} DEBUG \[conductor\] visible$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/log.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/log.ts`:

```ts
let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};

function line(level: string, subsystem: string, msg: string): string {
  const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
  return `${ts} ${level.padEnd(5)} [${subsystem}] ${msg}`;
}

export function createLogger(subsystem: string): Logger {
  return {
    info: (msg) => console.log(line("INFO", subsystem, msg)),
    warn: (msg) => console.error(line("WARN", subsystem, msg)),
    error: (msg) => console.error(line("ERROR", subsystem, msg)),
    debug: (msg) => {
      if (verbose) console.log(line("DEBUG", subsystem, msg));
    },
  };
}
```

In `src/index.ts`: add `--verbose` option to the `start` command (mirroring the existing `--dry-run` option pattern — read the file first), and in the start handler call `setVerbose(Boolean(opts.verbose) || process.env.PR_SHEPHERD_VERBOSE === "true")` before `startDaemon`. Import from `./log.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/log.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/log.ts src/index.ts test/log.test.ts
git commit -m "feat(log): leveled, verbosity-gated logger with consistent format"
```

---

### Task 2: convert all call sites, demote noise, add heartbeat, bound echoes

**Files:**
- Modify: `src/daemon.ts`, `src/review-inbox.ts`, `src/review-followup.ts`, `src/reviewer-nudge.ts`, `src/reply-watch.ts`, `src/ateam-conductor.ts`, `src/state-cache.ts`
- Test: `test/reply-watch.test.ts`, `test/review-inbox.test.ts`, `test/ateam-conductor.test.ts` (only where they spy on console output — adjust spies, keep semantic assertions)

**Interfaces:**
- Consumes Task 1's `createLogger`/`setVerbose` exactly as typed.
- Produces: pollers return cycle counts for the heartbeat — `pollAll` returns `Promise<number>` (open authored PRs), `pollReviewInbox` returns `Promise<{ active: number; reReviews: number } | null>` (null when disabled), `pollReviewFollowUps`/`pollReviewerNudges` return `Promise<number | null>` (active count; null when disabled), `pollReplyWatch` returns `Promise<number | null>` (targets scanned; null when disabled).

- [ ] **Step 1: Convert each module**

In every listed module: delete the local `log()` helper, add `const log = createLogger("<name>")` at module scope (names: `daemon`, `review-inbox`, `review-followup`, `reviewer-nudge`, `reply-watch`, `conductor`, `state-cache`), and convert call sites per the spec's normative level mapping. Specifics the mapping implies (audit refs, verify against current code):

- `daemon.ts`: `log()` helper (48-50) → logger. Transitions (69), actions (138, 324, 360, 379, 392), startup banner (522-539) → `info`. `Discovering…` (464) and `Found N…` (475) → `debug`. All catch-block lines (170, 458, 470, 516) → `error`.
- `review-inbox.ts`: dispatch/re-review/completion/free-worker lines → `info`; the `[pr-shepherd][debug]` literals at 361/365/367 → strip the literal prefix, `debug` level (361) — EXCEPT dry-run `would…` lines (365, 390) which become `info` without the debug literal; `Active:` summary (430) → `debug`; catch/error lines (410, 433, 446) → `error`; corrupt-file `console.error` (39) → `warn`.
- `review-followup.ts`: re-review request (177) → `info`; `Tracking N…` (213) → `debug`; errors (200, 216) → `error`; corrupt-file (33) → `warn`.
- `reviewer-nudge.ts`: nudge posted (148) / escalation (183) → `info`; `Tracking N…` (223) → `debug`; errors (156, 210) → `error`; corrupt-file (32) → `warn`.
- `reply-watch.ts`: forwarded (225) / dispatch-failed-retry → `info`; per-PR scan errors (237) and poll error (248) → `error`; corrupt-file (83) → `warn`; the dry-run `would forward…` (217) → `info`.
- `ateam-conductor.ts`: all 7 bare console.log sites → logger `conductor`. `couldn't parse PR identity` (46) → `warn`; head-branch fetch failure (62 area) → `warn`; `[dry-run] would route…` (73) → `info` (drop the `[pr-shepherd]` literal, keep the `[dry-run]` text inside the message — a test asserts on it); `exec: ateam…` (94), `route-pr-event stdout: …` (98), `exited successfully` (100) → `debug`; route failure (105) → `error`. Truncate echoes: stdout echo to 200 chars single line (`.replace(/\s+/g, " ").slice(0, 200)`), failure-captured output to 500 chars, appended to the error message.
- `state-cache.ts`: corrupt-file `console.error` (21) → `warn` via logger `state-cache`.

Strip every `[pr-shepherd]`/`[pr-shepherd][debug]` literal from message strings — the format carries subsystem and level now. Keep the semantic text tests assert on: `[dry-run]`, `couldn't parse PR identity`, `ateam route-pr-event failed`, `Corrupt` wording.

- [ ] **Step 2: Heartbeat**

Change the five pollers' return types per Interfaces (each computes its count from data it already has: `pollAll` returns `openPRs.length`; `pollReviewInbox` returns `{ active: <non-terminal count>, reReviews }` or null when disabled; followups/nudges return their active counts or null; `pollReplyWatch` returns `targets.size` or null). In `startDaemon`, extract the poll sequence into a local `runCycle()` used by both the initial call and `setInterval`, and after each cycle log:

```ts
const parts = [`${authored} authored`];
if (inbox !== null) parts.push(`${inbox.active} inbox${inbox.reReviews > 0 ? ` (${inbox.reReviews} re-review pending)` : ""}`);
if (followups !== null) parts.push(`${followups} followups`);
if (nudges !== null) parts.push(`${nudges} nudges`);
if (replyTargets !== null) parts.push(`${replyTargets} reply-watch`);
log.info(`poll ok — ${parts.join(", ")}`);
```

- [ ] **Step 3: Fix console-spying tests**

Run `npx vitest run` and fix failures ONLY by adjusting how tests observe output (e.g. a test spying `console.log` for an error line now spies `console.error`; format-prefix expectations use `stringContaining` on the semantic text). Do not weaken semantic assertions. If a dry-run test asserted `[dry-run]` via console spy, it must still find `[dry-run]` in an info line.

- [ ] **Step 4: Full gates**

Run: `npx vitest run && npm run typecheck`
Expected: ALL PASS.

- [ ] **Step 5: Manual smoke**

Run: `timeout 20 npx tsx src/index.ts start --dry-run 2>&1 | head -20` — expect banner + (within the first cycle) a `poll ok —` heartbeat, no `Discovering…`/`Active:` lines. Then re-run with `--verbose` and confirm the debug lines appear. Paste both outputs in the report. (Network calls will fire real `gh` searches — acceptable read-only; if `gh` is unauthenticated, note the error lines instead.)

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat(log): convert daemon to leveled logger — quiet cycles, heartbeat, gated debug"
```

---

### Task 3: docs + push

- [ ] **Step 1:** Update `CLAUDE.md` (Commands/Tests area): document `--verbose` / `PR_SHEPHERD_VERBOSE=true`, the `HH:MM:SS LEVEL [subsystem]` format, and the heartbeat line. Check `README.md` and `.env.example` — add `PR_SHEPHERD_VERBOSE` where env vars are listed. Update test counts from `npm test` output.
- [ ] **Step 2:** `npm test && npm run typecheck`, commit `docs: document leveled logging and --verbose`, `git push`.
