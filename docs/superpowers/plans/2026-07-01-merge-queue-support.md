# Merge Queue Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect GitHub's native merge queue lifecycle for authored PRs and notify the agent when a PR enters the queue (informational) and when it merges (a directive close-out instruction, upgraded from today's plain confirmation).

**Architecture:** New `IN_MERGE_QUEUE` state sits between `AUTO_MERGE_ENABLED` and `MERGED` in the existing pure state machine. A new `gh api graphql` call (`isInMergeQueue` isn't exposed via `gh pr view --json`) detects queue entry/exit, gated behind a new `mergeQueue.enabled` config flag so repos without merge queue pay zero extra API calls.

**Tech Stack:** TypeScript, Node.js, Vitest, `gh` CLI (GraphQL via `gh api graphql`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-01-merge-queue-design.md` — read it before starting; this plan implements it exactly.
- `mergeQueue.enabled` defaults to `false`, no env var override (matches `reviewFollowUp.enabled` precedent).
- All new agent messages route through the existing `sendToAgent` → `ateam route-pr-event --transition other` path — no changes to `ateam-conductor.ts`.
- Testing follows actual repo convention, not a generic ideal: pure functions (state machine, config, `parse*` in `github.ts`) get unit tests. Thin `gh`-CLI wrappers (`fetch*`, `enableAutoMerge`, etc.) and `notifications.ts` formatters are untested by existing convention — do not add tests for `fetchMergeQueueStatus` itself or for the new formatters. Do not add tests for `pollPR`'s new branches — `pollPR` has zero test coverage today.
- Run `npm run typecheck` and `npm test` after every task; both must pass before moving to the next task.

---

### Task 1: State machine — add `IN_MERGE_QUEUE`

**Files:**
- Modify: `src/types.ts:1-12` (`PRState`), `src/types.ts:14-27` (`PREvent`)
- Modify: `src/state-machine.ts:6-66` (transition table)
- Test: `test/state-machine.test.ts`

**Interfaces:**
- Produces: `PRState` now includes `"IN_MERGE_QUEUE"`. `PREvent` now includes `"entered_merge_queue"` and `"left_queue"`. `transition(current: PRState, event: PREvent): PRState | null` (unchanged signature, extended table) is consumed by `daemon.ts` in Task 5.

- [ ] **Step 1: Write the failing tests**

In `test/state-machine.test.ts`, inside `describe("transition", ...)`, add after the existing `"moves AUTO_MERGE_ENABLED → CI_FAILED on ci_failed"` test (currently the last test in that block):

```ts
    it("moves AUTO_MERGE_ENABLED → IN_MERGE_QUEUE on entered_merge_queue", () => {
      expect(transition("AUTO_MERGE_ENABLED", "entered_merge_queue")).toBe(
        "IN_MERGE_QUEUE",
      );
    });

    it("moves IN_MERGE_QUEUE → MERGED on merged", () => {
      expect(transition("IN_MERGE_QUEUE", "merged")).toBe("MERGED");
    });

    it("moves IN_MERGE_QUEUE → AUTO_MERGE_ENABLED on left_queue", () => {
      expect(transition("IN_MERGE_QUEUE", "left_queue")).toBe(
        "AUTO_MERGE_ENABLED",
      );
    });

    it("moves IN_MERGE_QUEUE → CI_PENDING on new_commit", () => {
      expect(transition("IN_MERGE_QUEUE", "new_commit")).toBe("CI_PENDING");
    });
```

Add `"IN_MERGE_QUEUE"` to the `nonTerminalStates` array in `describe("closed from any non-terminal state", ...)`:

```ts
    const nonTerminalStates: PRState[] = [
      "OPENED",
      "CI_PENDING",
      "CI_PASSED",
      "CI_FAILED",
      "AWAITING_REVIEW",
      "CHANGES_REQUESTED",
      "APPROVED",
      "AUTO_MERGE_ENABLED",
      "IN_MERGE_QUEUE",
      "STALE",
    ];
```

Add the two new events to the `allEvents` array in `describe("terminal states reject all events", ...)`:

```ts
    const allEvents: PREvent[] = [
      "poll_started",
      "ci_passed",
      "ci_failed",
      "ci_pending",
      "review_posted",
      "changes_requested",
      "all_approved",
      "auto_merge_enabled",
      "entered_merge_queue",
      "left_queue",
      "merged",
      "closed",
      "new_commit",
      "stale_detected",
      "review_requested",
    ];
```

Add a new describe block after `describe("full lifecycle — happy path", ...)` and before `describe("full lifecycle — CI failure + fix loop", ...)`:

```ts
  describe("full lifecycle — merge queue", () => {
    it("handles OPENED → ... → IN_MERGE_QUEUE → MERGED", () => {
      let state: PRState = "OPENED";
      const steps: Array<{ event: PREvent; expected: PRState }> = [
        { event: "poll_started", expected: "CI_PENDING" },
        { event: "ci_passed", expected: "CI_PASSED" },
        { event: "review_posted", expected: "AWAITING_REVIEW" },
        { event: "all_approved", expected: "APPROVED" },
        { event: "auto_merge_enabled", expected: "AUTO_MERGE_ENABLED" },
        { event: "entered_merge_queue", expected: "IN_MERGE_QUEUE" },
        { event: "merged", expected: "MERGED" },
      ];

      for (const { event, expected } of steps) {
        const next = transition(state, event);
        expect(next).toBe(expected);
        state = next!;
      }
    });

    it("handles being dequeued and re-entering the queue", () => {
      let state: PRState = "AUTO_MERGE_ENABLED";
      const steps: Array<{ event: PREvent; expected: PRState }> = [
        { event: "entered_merge_queue", expected: "IN_MERGE_QUEUE" },
        { event: "left_queue", expected: "AUTO_MERGE_ENABLED" },
        { event: "entered_merge_queue", expected: "IN_MERGE_QUEUE" },
        { event: "merged", expected: "MERGED" },
      ];

      for (const { event, expected } of steps) {
        const next = transition(state, event);
        expect(next).toBe(expected);
        state = next!;
      }
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- state-machine`
Expected: FAIL — `"IN_MERGE_QUEUE"` and `"entered_merge_queue"`/`"left_queue"` are not assignable to `PRState`/`PREvent` (TypeScript error) or `transition` returns `null` instead of the expected state.

- [ ] **Step 3: Add the new state and events to `src/types.ts`**

In `src/types.ts`, change:

```ts
export type PRState =
  | "OPENED"
  | "CI_PENDING"
  | "CI_PASSED"
  | "CI_FAILED"
  | "AWAITING_REVIEW"
  | "CHANGES_REQUESTED"
  | "APPROVED"
  | "AUTO_MERGE_ENABLED"
  | "STALE"
  | "MERGED"
  | "CLOSED";
```

to:

```ts
export type PRState =
  | "OPENED"
  | "CI_PENDING"
  | "CI_PASSED"
  | "CI_FAILED"
  | "AWAITING_REVIEW"
  | "CHANGES_REQUESTED"
  | "APPROVED"
  | "AUTO_MERGE_ENABLED"
  | "IN_MERGE_QUEUE"
  | "STALE"
  | "MERGED"
  | "CLOSED";
```

And change:

```ts
export type PREvent =
  | "poll_started"
  | "ci_passed"
  | "ci_failed"
  | "ci_pending"
  | "review_posted"
  | "changes_requested"
  | "all_approved"
  | "auto_merge_enabled"
  | "merged"
  | "closed"
  | "new_commit"
  | "stale_detected"
  | "review_requested";
```

to:

```ts
export type PREvent =
  | "poll_started"
  | "ci_passed"
  | "ci_failed"
  | "ci_pending"
  | "review_posted"
  | "changes_requested"
  | "all_approved"
  | "auto_merge_enabled"
  | "entered_merge_queue"
  | "left_queue"
  | "merged"
  | "closed"
  | "new_commit"
  | "stale_detected"
  | "review_requested";
```

- [ ] **Step 4: Add the transitions to `src/state-machine.ts`**

Change the `AUTO_MERGE_ENABLED` entry from:

```ts
  AUTO_MERGE_ENABLED: {
    merged: "MERGED",
    new_commit: "CI_PENDING",
    ci_failed: "CI_FAILED",
    closed: "CLOSED",
  },
```

to:

```ts
  AUTO_MERGE_ENABLED: {
    merged: "MERGED",
    new_commit: "CI_PENDING",
    ci_failed: "CI_FAILED",
    entered_merge_queue: "IN_MERGE_QUEUE",
    closed: "CLOSED",
  },
```

Add a new `IN_MERGE_QUEUE` entry immediately after it (before the `STALE` entry):

```ts
  IN_MERGE_QUEUE: {
    merged: "MERGED",
    left_queue: "AUTO_MERGE_ENABLED",
    new_commit: "CI_PENDING",
    closed: "CLOSED",
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- state-machine`
Expected: PASS, all tests green including the new ones.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/state-machine.ts test/state-machine.test.ts
git commit -m "feat(state-machine): add IN_MERGE_QUEUE state for GitHub merge queue"
```

---

### Task 2: Config — add `mergeQueue.enabled`

**Files:**
- Modify: `src/types.ts` (`ShepherdConfig`)
- Modify: `src/config.ts` (`DEFAULTS`)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `ShepherdConfig.mergeQueue.enabled: boolean`, consumed by `daemon.ts` in Task 5.

- [ ] **Step 1: Write the failing tests**

In `test/config.test.ts`, add after the `"deep merges nested objects without clobbering sibling keys"` test:

```ts
  it("defaults mergeQueue.enabled to false", () => {
    process.env.PR_SHEPHERD_AUTHOR_USERNAME = "testuser";
    const config = loadConfig(join(TMP, "nonexistent.json"));
    expect(config.mergeQueue.enabled).toBe(false);
  });

  it("allows enabling mergeQueue via config file", () => {
    const path = join(TMP, "merge-queue.json");
    writeJson(path, { mergeQueue: { enabled: true }, ...withRequiredFields() });
    const config = loadConfig(path);
    expect(config.mergeQueue.enabled).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- config`
Expected: FAIL — TypeScript error, `mergeQueue` does not exist on `ShepherdConfig`.

- [ ] **Step 3: Add `mergeQueue` to `ShepherdConfig` in `src/types.ts`**

Change the end of the `ShepherdConfig` type from:

```ts
  reviewerNudge: {
    enabled: boolean;
    escalateAfterHours: number;
    businessDaysOnly: boolean;
  };
};
```

to:

```ts
  reviewerNudge: {
    enabled: boolean;
    escalateAfterHours: number;
    businessDaysOnly: boolean;
  };

  mergeQueue: {
    enabled: boolean;
  };
};
```

- [ ] **Step 4: Add the default to `DEFAULTS` in `src/config.ts`**

Change the end of `DEFAULTS` from:

```ts
  reviewerNudge: {
    enabled: false,
    escalateAfterHours: 24,
    businessDaysOnly: true,
  },
};
```

to:

```ts
  reviewerNudge: {
    enabled: false,
    escalateAfterHours: 24,
    businessDaysOnly: true,
  },

  mergeQueue: {
    enabled: false,
  },
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- config`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/config.ts test/config.test.ts
git commit -m "feat(config): add mergeQueue.enabled flag (default false)"
```

---

### Task 3: GitHub — detect merge queue status via GraphQL

**Files:**
- Modify: `src/github.ts` (add after `fetchReviews`, before `enableAutoMerge`)
- Create: `test/fixtures/merge-queue-in-queue.json`
- Create: `test/fixtures/merge-queue-not-in-queue.json`
- Test: `test/github.test.ts`

**Interfaces:**
- Produces: `parseMergeQueueStatus(json: string): boolean` (pure, tested) and `fetchMergeQueueStatus(number: number, repo: string): boolean` (thin `gh` wrapper, untested — matches `fetchChecks`/`fetchReviews`/`fetchPRView` convention). Both consumed by `daemon.ts` in Task 5.

- [ ] **Step 1: Create the fixtures**

Create `test/fixtures/merge-queue-in-queue.json`:

```json
{
  "data": {
    "repository": {
      "pullRequest": {
        "isInMergeQueue": true
      }
    }
  }
}
```

Create `test/fixtures/merge-queue-not-in-queue.json`:

```json
{
  "data": {
    "repository": {
      "pullRequest": {
        "isInMergeQueue": false
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing tests**

In `test/github.test.ts`, change the import on line 2 from:

```ts
import { parseChecks, parseReviews, evaluateChecks, evaluateReviews, buildSnapshot, selectNewComments } from "../src/github.js";
```

to:

```ts
import { parseChecks, parseReviews, evaluateChecks, evaluateReviews, buildSnapshot, selectNewComments, parseMergeQueueStatus } from "../src/github.js";
```

Add a new describe block after `describe("buildSnapshot", ...)`, before the closing of the outer `describe("github", ...)`:

```ts
  describe("parseMergeQueueStatus", () => {
    it("returns true when the PR is in the merge queue", () => {
      const raw = readFileSync(join(FIXTURES, "merge-queue-in-queue.json"), "utf-8");
      expect(parseMergeQueueStatus(raw)).toBe(true);
    });

    it("returns false when the PR is not in the merge queue", () => {
      const raw = readFileSync(join(FIXTURES, "merge-queue-not-in-queue.json"), "utf-8");
      expect(parseMergeQueueStatus(raw)).toBe(false);
    });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- github`
Expected: FAIL — `parseMergeQueueStatus` is not exported from `../src/github.js`.

- [ ] **Step 4: Implement `parseMergeQueueStatus` and `fetchMergeQueueStatus` in `src/github.ts`**

Insert immediately after `fetchReviews` (which ends at line 81) and before `enableAutoMerge`:

```ts
export function parseMergeQueueStatus(json: string): boolean {
  const data = JSON.parse(json) as {
    data: { repository: { pullRequest: { isInMergeQueue: boolean } } };
  };
  return data.data.repository.pullRequest.isInMergeQueue;
}

// isInMergeQueue is only exposed via GraphQL, not gh pr view --json.
export function fetchMergeQueueStatus(number: number, repo: string): boolean {
  const [owner, name] = repo.split("/");
  const query =
    "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){isInMergeQueue}}}";
  const json = gh([
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${number}`,
  ]);
  return parseMergeQueueStatus(json);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- github`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/github.ts test/github.test.ts test/fixtures/merge-queue-in-queue.json test/fixtures/merge-queue-not-in-queue.json
git commit -m "feat(github): add fetchMergeQueueStatus via GraphQL isInMergeQueue"
```

---

### Task 4: Notifications — merge queue messages + close-out merge message

**Files:**
- Modify: `src/notifications.ts`

**Interfaces:**
- Produces: `formatMergeQueueEnteredMessage(prNumber: number, repo: string): string`, `formatMergeQueueLeftMessage(prNumber: number, repo: string): string`. `formatMergeMessage`'s signature is unchanged, only its return value changes. All three consumed by `daemon.ts` in Task 5.
- No tests added — matches the existing convention that every formatter in this file (`formatCIFailureMessage`, `formatReviewMessage`, `formatApprovalMessage`, `formatStaleMessage`, current `formatMergeMessage`) is untested.

- [ ] **Step 1: Update `formatMergeMessage`**

Change:

```ts
export function formatMergeMessage(
  prNumber: number,
  repo: string,
): string {
  return `[PR Shepherd] PR #${prNumber} (${repo}) — Merged successfully.`;
}
```

to:

```ts
export function formatMergeMessage(
  prNumber: number,
  repo: string,
): string {
  return [
    `[PR Shepherd] PR #${prNumber} (${repo}) — Merged.`,
    "",
    "This PR has merged. Close out this session: clean up the worktree/branch and mark the work complete.",
  ].join("\n");
}
```

- [ ] **Step 2: Add the two new formatters**

Add immediately after the updated `formatMergeMessage`:

```ts
export function formatMergeQueueEnteredMessage(
  prNumber: number,
  repo: string,
): string {
  return `[PR Shepherd] PR #${prNumber} (${repo}) — Entered merge queue. No action needed; I'll notify you when it merges.`;
}

export function formatMergeQueueLeftMessage(
  prNumber: number,
  repo: string,
): string {
  return `[PR Shepherd] PR #${prNumber} (${repo}) — Removed from merge queue without merging. This usually means the queue's CI check failed. Please investigate and push a fix if needed.`;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions (nothing tests these formatters, so this just confirms nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add src/notifications.ts
git commit -m "feat(notifications): add merge-queue messages, close-out instruction on merge"
```

---

### Task 5: Daemon — wire merge queue polling into `pollPR`

**Files:**
- Modify: `src/daemon.ts`

**Interfaces:**
- Consumes: `fetchMergeQueueStatus` from Task 3, `formatMergeQueueEnteredMessage`/`formatMergeQueueLeftMessage` from Task 4, `config.mergeQueue.enabled` from Task 2, the `entered_merge_queue`/`left_queue` transitions from Task 1.
- No tests added — `pollPR` has zero existing test coverage and no mocking harness for `github.ts`/`notifications.ts` exists in this codebase; introducing one is out of scope for this feature. Verified instead via typecheck, the full existing suite (to catch accidental regressions in the surrounding control flow), and manual `make start-dry` review if a merge-queue-enabled repo is available.

- [ ] **Step 1: Update imports**

Change the `github.js` import block from:

```ts
import {
  fetchPRView,
  fetchChecks,
  fetchReviews,
  parseChecks,
  parseReviews,
  evaluateChecks,
  evaluateReviews,
  enableAutoMerge,
  updateBranch,
  fetchCommentsByUsers,
  selectNewComments,
} from "./github.js";
```

to:

```ts
import {
  fetchPRView,
  fetchChecks,
  fetchReviews,
  parseChecks,
  parseReviews,
  evaluateChecks,
  evaluateReviews,
  enableAutoMerge,
  updateBranch,
  fetchCommentsByUsers,
  selectNewComments,
  fetchMergeQueueStatus,
} from "./github.js";
```

Change the `notifications.js` import block from:

```ts
import {
  formatCIFailureMessage,
  formatReviewMessage,
  formatApprovalMessage,
  formatMergeMessage,
  formatStaleMessage,
} from "./notifications.js";
```

to:

```ts
import {
  formatCIFailureMessage,
  formatReviewMessage,
  formatApprovalMessage,
  formatMergeMessage,
  formatStaleMessage,
  formatMergeQueueEnteredMessage,
  formatMergeQueueLeftMessage,
} from "./notifications.js";
```

- [ ] **Step 2: Add merge-queue polling to `pollPR`**

In `pollPR`, change the `AUTO_MERGE_ENABLED` block from:

```ts
    if (pr.state === "AUTO_MERGE_ENABLED") {
      const checkResult = evaluateChecks(checks, config);
      if (checkResult.status === "fail") {
        const details = { failedChecks: checkResult.failed };
        tryTransition(config, pr, "ci_failed", details);
        await handleTransition(config, pr, "CI_FAILED", details);
      }

      if (prView.mergeStateStatus === "BEHIND") {
        if (prView.mergeable === "MERGEABLE") {
          log(`PR #${pr.number} is behind base branch — updating branch.`);
          if (!config.dryRun) {
            try {
              updateBranch(pr.number, pr.repo);
              log(`Branch updated for PR #${pr.number}.`);
            } catch (err) {
              log(`Failed to update branch for PR #${pr.number}: ${(err as Error).message}`);
            }
          }
        } else if (prView.mergeable === "CONFLICTING") {
          const msg = `[PR Shepherd] PR #${pr.number} (${pr.repo}) — Merge conflicts detected. Auto-merge is enabled but the branch cannot be updated automatically. Please resolve conflicts manually.`;
          log(`PR #${pr.number} has merge conflicts — escalating.`);
          if (!config.dryRun) await sendToAgent(config, config.notifications.notifyAgent!, msg);
        }
      }
    }
```

to:

```ts
    if (pr.state === "AUTO_MERGE_ENABLED") {
      const checkResult = evaluateChecks(checks, config);
      if (checkResult.status === "fail") {
        const details = { failedChecks: checkResult.failed };
        tryTransition(config, pr, "ci_failed", details);
        await handleTransition(config, pr, "CI_FAILED", details);
      }

      if (prView.mergeStateStatus === "BEHIND") {
        if (prView.mergeable === "MERGEABLE") {
          log(`PR #${pr.number} is behind base branch — updating branch.`);
          if (!config.dryRun) {
            try {
              updateBranch(pr.number, pr.repo);
              log(`Branch updated for PR #${pr.number}.`);
            } catch (err) {
              log(`Failed to update branch for PR #${pr.number}: ${(err as Error).message}`);
            }
          }
        } else if (prView.mergeable === "CONFLICTING") {
          const msg = `[PR Shepherd] PR #${pr.number} (${pr.repo}) — Merge conflicts detected. Auto-merge is enabled but the branch cannot be updated automatically. Please resolve conflicts manually.`;
          log(`PR #${pr.number} has merge conflicts — escalating.`);
          if (!config.dryRun) await sendToAgent(config, config.notifications.notifyAgent!, msg);
        }
      }

      if (
        config.mergeQueue.enabled &&
        pr.state === "AUTO_MERGE_ENABLED" &&
        fetchMergeQueueStatus(pr.number, pr.repo)
      ) {
        tryTransition(config, pr, "entered_merge_queue");
        log(`PR #${pr.number} entered the merge queue.`);
        const msg = formatMergeQueueEnteredMessage(pr.number, pr.repo);
        if (!config.dryRun) await sendToAgent(config, config.notifications.notifyAgent!, msg);
      }
    }

    if (
      config.mergeQueue.enabled &&
      pr.state === "IN_MERGE_QUEUE" &&
      !fetchMergeQueueStatus(pr.number, pr.repo)
    ) {
      tryTransition(config, pr, "left_queue");
      log(`PR #${pr.number} left the merge queue without merging — escalating.`);
      const msg = formatMergeQueueLeftMessage(pr.number, pr.repo);
      if (!config.dryRun) await sendToAgent(config, config.notifications.notifyAgent!, msg);
    }
```

Note the re-check of `pr.state === "AUTO_MERGE_ENABLED"` inside the first added block: `tryTransition(config, pr, "ci_failed", ...)` earlier in the same block may already have moved `pr.state` to `CI_FAILED`, and the merge-queue check must not run in that case. This mirrors the existing guard pattern at `src/daemon.ts:369` (`if (isTerminal(pr.state) || currentState === "CI_FAILED" || currentState === "CI_PENDING")`).

`fetchMergeQueueStatus` is intentionally not wrapped in a local try/catch here — like `fetchChecks`/`fetchReviews`/`fetchPRView` above it in the same function, a thrown error propagates to `pollPR`'s outer `catch` (`src/daemon.ts:416-418`), gets logged, and the PR is retried on the next poll cycle.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts
git commit -m "feat(daemon): poll merge queue status, notify on entry and dequeue"
```

---

### Task 6: Docs — README.md and CLAUDE.md

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Update `README.md`'s "How It Works" bullet list**

In the "Authored PR monitoring" bullet list (currently ending with `- **PR merges or closes** → cleans up state cache, routes confirmation`), change that line and add a new one before it:

```markdown
   - **Enters merge queue** (if `mergeQueue.enabled`) → routes an informational event, no action needed
   - **Left merge queue without merging** → routes an escalation event (usually means the queue's CI check failed)
   - **PR merges or closes** → cleans up state cache, routes a close-out instruction (merge) or a plain confirmation (close)
```

- [ ] **Step 2: Update `README.md`'s state machine diagram and key loops**

Change:

```markdown
```
OPENED → CI_PENDING → CI_PASSED → AWAITING_REVIEW → APPROVED → AUTO_MERGE_ENABLED → MERGED
```

Key loops and branches:
- **CI failure**: `CI_PENDING → CI_FAILED` → `ateam route-pr-event` → worker pushes fix → `CI_PENDING`
- **Changes requested**: `AWAITING_REVIEW → CHANGES_REQUESTED` → `ateam route-pr-event` → worker fixes → `CI_PENDING`
- **Behind base branch**: `AUTO_MERGE_ENABLED` + `BEHIND` → `gh pr update-branch` → CI re-runs → polls until merged
- **Merge conflicts**: `AUTO_MERGE_ENABLED` + `CONFLICTING` → escalated via `ateam route-pr-event`
- **Stale**: `AWAITING_REVIEW` past threshold → `STALE` → `ateam route-pr-event`
- **External auto-merge**: if GitHub shows `autoMergeRequest` already set on an `APPROVED` PR, transitions to `AUTO_MERGE_ENABLED` automatically
```

to:

```markdown
```
OPENED → CI_PENDING → CI_PASSED → AWAITING_REVIEW → APPROVED → AUTO_MERGE_ENABLED → [IN_MERGE_QUEUE] → MERGED
```

Key loops and branches:
- **CI failure**: `CI_PENDING → CI_FAILED` → `ateam route-pr-event` → worker pushes fix → `CI_PENDING`
- **Changes requested**: `AWAITING_REVIEW → CHANGES_REQUESTED` → `ateam route-pr-event` → worker fixes → `CI_PENDING`
- **Behind base branch**: `AUTO_MERGE_ENABLED` + `BEHIND` → `gh pr update-branch` → CI re-runs → polls until merged
- **Merge conflicts**: `AUTO_MERGE_ENABLED` + `CONFLICTING` → escalated via `ateam route-pr-event`
- **Merge queue** (opt-in via `mergeQueue.enabled`): `AUTO_MERGE_ENABLED` → `IN_MERGE_QUEUE` → informational `ateam route-pr-event`, then merges normally; if dequeued without merging, escalates via `ateam route-pr-event` and returns to `AUTO_MERGE_ENABLED`
- **Stale**: `AWAITING_REVIEW` past threshold → `STALE` → `ateam route-pr-event`
- **External auto-merge**: if GitHub shows `autoMergeRequest` already set on an `APPROVED` PR, transitions to `AUTO_MERGE_ENABLED` automatically
```

- [ ] **Step 3: Update `README.md`'s config reference**

In the "Full Config Reference" JSON block, add a `mergeQueue` section after `reviewInbox`:

```json
  "reviewInbox": {
    "enabled": true,
    "githubUser": "your-github-username",
    "ignoreRepos": [],
    "ignoreDrafts": true,
    "maxAgeDays": 5
  },

  "mergeQueue": {
    "enabled": false
  }
```

(Note the trailing comma now needed after `reviewInbox`'s closing `}` in that block.)

In the config table below it, add a row after the `reviewInbox.*` rows:

```markdown
| `mergeQueue.enabled` | false | Detect GitHub's native merge queue (extra `gh api graphql` call per poll while a PR is auto-merge-enabled or queued) |
```

- [ ] **Step 4: Update `CLAUDE.md`'s Architecture section**

Change:

```markdown
   - **Auto-merge enabled but merge conflicts** → escalates to the agent (cannot auto-resolve)
   - **PR stale** (awaiting review past threshold) → notifies the agent
   - **PR merged or closed** → cleans up state cache, sends confirmation
```

to:

```markdown
   - **Auto-merge enabled but merge conflicts** → escalates to the agent (cannot auto-resolve)
   - **Entered merge queue** (if `mergeQueue.enabled`) → sends an informational notice, no action needed
   - **Left merge queue without merging** → escalates to the agent (usually means the queue's CI check failed)
   - **PR stale** (awaiting review past threshold) → notifies the agent
   - **PR merged** → cleans up state cache, instructs the agent to close out the session
   - **PR closed** → cleans up state cache, sends confirmation
```

- [ ] **Step 5: Update `CLAUDE.md`'s State Machine section**

Change:

```markdown
```
OPENED → CI_PENDING → CI_PASSED → AWAITING_REVIEW → APPROVED → AUTO_MERGE_ENABLED → MERGED
```

Key loops:
- **CI failure**: `CI_PENDING → CI_FAILED` → agent notified → worker pushes fix → `CI_PENDING` (new commit detected)
- **Changes requested**: `AWAITING_REVIEW → CHANGES_REQUESTED` → agent notified → worker pushes fix → `CI_PENDING`
- **Behind branch**: `AUTO_MERGE_ENABLED` + `BEHIND` → `gh pr update-branch` → CI re-runs → stays in `AUTO_MERGE_ENABLED` until merged
- **Merge conflicts**: `AUTO_MERGE_ENABLED` + `CONFLICTING` → escalated to agent
- **Stale**: `AWAITING_REVIEW` past threshold → `STALE` → agent notified
```

to:

```markdown
```
OPENED → CI_PENDING → CI_PASSED → AWAITING_REVIEW → APPROVED → AUTO_MERGE_ENABLED → [IN_MERGE_QUEUE] → MERGED
```

Key loops:
- **CI failure**: `CI_PENDING → CI_FAILED` → agent notified → worker pushes fix → `CI_PENDING` (new commit detected)
- **Changes requested**: `AWAITING_REVIEW → CHANGES_REQUESTED` → agent notified → worker pushes fix → `CI_PENDING`
- **Behind branch**: `AUTO_MERGE_ENABLED` + `BEHIND` → `gh pr update-branch` → CI re-runs → stays in `AUTO_MERGE_ENABLED` until merged
- **Merge conflicts**: `AUTO_MERGE_ENABLED` + `CONFLICTING` → escalated to agent
- **Merge queue** (opt-in via `mergeQueue.enabled`): `AUTO_MERGE_ENABLED → IN_MERGE_QUEUE` on entry (informational) → `MERGED` on merge, or `left_queue → AUTO_MERGE_ENABLED` with an escalation if dequeued without merging
- **Stale**: `AWAITING_REVIEW` past threshold → `STALE` → agent notified
```

- [ ] **Step 6: Update `CLAUDE.md`'s Tests section counts**

Run `npm test` and note the final line reporting total test count and file count. Update:

```markdown
```bash
npm test            # 113 tests across 6 files
npm run typecheck   # Clean TypeScript check
```

State machine has 70 tests covering every transition, terminal state, and full lifecycle scenario.
```

replacing `113 tests across 6 files` and `70 tests` with the real numbers from the `npm test` output (file count stays at 6 unless a new test file was added — it wasn't in this plan).

- [ ] **Step 7: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document merge queue support in README and CLAUDE.md"
```

---

## Self-Review Notes

- **Spec coverage:** state machine (Task 1), config gate (Task 2), GraphQL detection (Task 3), messages including the close-out directive (Task 4), daemon wiring for both entry and dequeue (Task 5), docs (Task 6) — every section of the spec has a task.
- **Testing scope correction:** the original spec draft assumed `daemon.test.ts`/`notifications.test.ts` coverage that doesn't match this repo's actual conventions (verified by reading all six existing test files before writing this plan — `pollPR` and every formatter/`gh`-wrapper are untested today). The spec was corrected in place before this plan was written; this plan follows the corrected version.
- **Type consistency:** `IN_MERGE_QUEUE`, `entered_merge_queue`, `left_queue`, `mergeQueue.enabled`, `fetchMergeQueueStatus`, `parseMergeQueueStatus`, `formatMergeQueueEnteredMessage`, `formatMergeQueueLeftMessage` are spelled identically everywhere they appear across all six tasks.
