# Merge Queue Support — Design

## Goal

PR Shepherd should detect GitHub's native merge queue lifecycle for authored
PRs and notify the agent at two points:

1. **Entered merge queue** — informational only, no action needed.
2. **Merged** — a directive instruction that the session for this PR should
   be closed out (worktree/branch cleanup, mark work complete).

Scope is limited to authored-PR monitoring (`daemon.ts` / `pollPR`). Review
inbox, review follow-up, and reviewer nudge are unaffected.

## Background

GitHub's native merge queue (a branch-protection setting requiring PRs to
pass through a queue before merging) is not exposed via `gh pr view --json`
— the relevant field, `isInMergeQueue`, only exists on the GraphQL
`PullRequest` type. This requires a new fetch function using `gh api
graphql`, following the same `gh api` pattern already used for
`fetchCommentsByUsers` (REST) in `src/github.ts`.

## State machine

New state `IN_MERGE_QUEUE`, inserted between `AUTO_MERGE_ENABLED` and
`MERGED`. New events: `entered_merge_queue`, `left_queue`.

```
AUTO_MERGE_ENABLED --entered_merge_queue--> IN_MERGE_QUEUE
IN_MERGE_QUEUE     --merged-->              MERGED
IN_MERGE_QUEUE     --closed-->              CLOSED
IN_MERGE_QUEUE     --left_queue-->          AUTO_MERGE_ENABLED
IN_MERGE_QUEUE     --new_commit-->          CI_PENDING
```

`merged` and `closed` are already detected PR-state-first at the top of
`pollPR` (before any per-`pr.state` branching), so `IN_MERGE_QUEUE` just
needs those two transitions added to the table — no new dispatch code for
those two paths.

Terminal states (`MERGED`, `CLOSED`) and `isTerminal`/`validEvents` helpers
in `state-machine.ts` are unchanged.

## Detection

New function in `src/github.ts`:

```ts
export function fetchMergeQueueStatus(number: number, repo: string): boolean
```

Implemented via `gh api graphql` querying `repository(owner, name) {
pullRequest(number) { isInMergeQueue } }`. Only called when
`config.mergeQueue.enabled` is true, and only for PRs in
`AUTO_MERGE_ENABLED` or `IN_MERGE_QUEUE` state — this keeps the extra
GraphQL call off the hot path for PRs not close to merging, and off
entirely for repos that don't use merge queue.

## Polling logic (`daemon.ts`)

Gated by `config.mergeQueue.enabled`:

- **In `AUTO_MERGE_ENABLED`:** after the existing BEHIND/CI-fail checks,
  call `fetchMergeQueueStatus`. If `true` → `entered_merge_queue` transition
  + informational message.
- **In `IN_MERGE_QUEUE`:** call `fetchMergeQueueStatus`.
  - If `true` → no-op. GitHub's queue owns rebasing and CI for the queued
    PR; the existing BEHIND-branch-update logic (which only runs under
    `pr.state === "AUTO_MERGE_ENABLED"`) is naturally skipped here.
  - If `false` (and the PR is still open — merge/close already handled
    earlier in `pollPR`) → `left_queue` transition + escalation message.
    This is inferred, not directly observed: the ephemeral merge-queue CI
    run isn't visible via `gh pr checks` on the PR's own branch, so being
    dequeued without merging is treated as "something went wrong,
    investigate," mirroring the existing merge-conflict escalation.

## Messages (`notifications.ts`)

Two new formatters, following the existing `format*Message` pattern:

- `formatMergeQueueEnteredMessage(prNumber, repo)` — informational.
  ```
  [PR Shepherd] PR #123 (owner/repo) — Entered merge queue. No action needed; I'll notify you when it merges.
  ```
- `formatMergeQueueLeftMessage(prNumber, repo)` — escalation.
  ```
  [PR Shepherd] PR #123 (owner/repo) — Removed from merge queue without merging. This usually means the queue's CI check failed. Please investigate and push a fix if needed.
  ```

`formatMergeMessage` updated to add a close-out directive:

```
[PR Shepherd] PR #123 (owner/repo) — Merged.

This PR has merged. Close out this session: clean up the worktree/branch and mark the work complete.
```

All messages are sent via the existing `sendToAgent` → `routeToAgent` →
`ateam route-pr-event --transition other` path. No changes to
`ateam-conductor.ts`.

## Config

New `mergeQueue` section in `ShepherdConfig` (`types.ts`), `DEFAULTS`
(`config.ts`), and `config/shepherd.example.json`:

```ts
mergeQueue: {
  enabled: boolean; // default false
}
```

No env var override is added (matches the precedent of e.g.
`reviewFollowUp.enabled`, which also has no env var).

## Testing

Checked actual test coverage precedent before finalizing this: the suite
tests pure functions only (state machine, `evaluateChecks`/`evaluateReviews`/
`parseChecks`/`parseReviews`/`buildSnapshot`/`selectNewComments`,
`filterAuthoredPRs`, config loading). Every `gh`-CLI-wrapping function in
`github.ts` (`fetchPRView`, `fetchChecks`, `enableAutoMerge`, etc.) and every
formatter in `notifications.ts` is untested — thin wrappers/templates, not
unit-tested by convention. `pollPR` itself has zero test coverage today (no
mocking harness for it exists). This feature follows the same shape, so:

- `state-machine.test.ts`: 5 new transition cases (`entered_merge_queue`,
  `left_queue`, and `IN_MERGE_QUEUE`'s `merged`/`closed`/`new_commit`), plus
  confirming `IN_MERGE_QUEUE` is non-terminal — matches existing coverage
  exactly.
- `config.test.ts`: one new case confirming `mergeQueue.enabled` defaults to
  `false` and can be overridden via file config — matches the existing
  `notifications.onMerge` deep-merge test shape.
- `fetchMergeQueueStatus` (new `github.ts` function) and the two new/updated
  `notifications.ts` formatters: no dedicated tests, consistent with every
  sibling function of the same shape.
- `pollPR`'s new branches (entering queue, staying queued, dequeue
  escalation): no dedicated tests, consistent with `pollPR` having no test
  coverage today. Verified manually via `make start-dry` against a real PR
  with merge queue enabled, if available, during implementation review.

## Non-goals

- No handling for repos where merge queue is enabled but PR Shepherd hasn't
  opted in via config — behavior there is unchanged (no extra API calls,
  `IN_MERGE_QUEUE` unreachable).
- No change to `ateam route-pr-event`'s `--transition` values — all new
  messages use `"other"`, same as CI failure/approval/stale/conflict today.
