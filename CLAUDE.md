# PR Shepherd

Automated PR lifecycle daemon. Discovers open PRs from GitHub, monitors CI and reviews, keeps branches up to date, enables auto-merge, and routes issues to a designated agent. No manual PR registration — everything is auto-discovered.

## Architecture

A single long-running Node.js process with two polling loops on a shared interval:

1. **Authored PR monitoring** — `gh search prs --author=<user>` discovers open non-draft PRs. For each, polls CI checks, reviews, and merge state. Detects state transitions via a pure-function state machine. Actions taken automatically:
   - **CI failure** → notifies the configured agent with the list of failed checks
   - **Review with changes requested** → sends the full review body to the agent
   - **Bot review feedback** → for each user in `reviews.botUsers`, scans PR issue comments for actionable findings (`❌`) and forwards them to the agent. Capped at `botFeedback.maxAttempts` per PR.
   - **Reviewer comment** → for each user in `reviews.reviewerUsers` (human whitelist), forwards their PR issue comments to the agent. Catches review feedback left as plain comments rather than a formal GitHub review. No `❌` gate, no attempt cap — deduped by a per-PR cursor.
   - **All approvals met** → if `autoMerge` is true (default), enables auto-merge (`gh pr merge --auto --squash`); if false, raises a flag to the agent for manual merge instead
   - **Auto-merge enabled but branch is behind** → updates the branch (`gh pr update-branch`) so CI re-runs and the merge can proceed. Repeats every poll until the PR merges.
   - **Auto-merge enabled but merge conflicts** → escalates to the agent (cannot auto-resolve)
   - **Entered merge queue** (if `mergeQueue.enabled`) → sends an informational notice, no action needed
   - **Left merge queue without merging** → escalates to the agent (usually means the queue's CI check failed)
   - **PR stale** (awaiting review past threshold) → notifies the agent
   - **PR merged** → cleans up state cache, instructs the agent to close out the session
   - **PR closed** → cleans up state cache silently (no notification sent)

2. **Review inbox** — `gh search prs --review-requested=<user>` discovers incoming review assignments. Full lifecycle tracking:
   - **`waitForBot` gate** — if configured, holds dispatch until a bot (e.g. Canary) posts its review. If the bot auto-approves (no "Review Required", no ❌), skips human review entirely.
   - **Dispatch** → notifies the agent to assign a worker for review
   - **Merged before review** → if PR merges before our review is posted, notifies the agent to free the worker
   - **Review submitted** → if our review is posted, notifies the agent to free the worker
   - **Review re-requested** → a PR we already reviewed reappearing in the review-requested search (GitHub re-adds a reviewer on re-request) is dispatched as a focused re-review (`--transition re_review`): the agent verifies previously raised findings were addressed, no new findings. Completion is detected by a review of ours newer than the dispatch. Repeatable per PR.
   - Filters by age (`maxAgeDays`), draft status, repos, and whether the user already reviewed

3. **Review follow-up** — tracks PRs where we left `CHANGES_REQUESTED` reviews. When the author pushes new commits, notifies the agent for a scoped re-review (only check previously raised issues, no new findings). Stops on approval.

4. **Reply watch** — scans inline review-comment threads on PRs we reviewed (`gh search prs --reviewed-by`) and our watched authored PRs. When someone replies in a thread our identity participated in (newer than our last comment in that thread), forwards the reply to the owning initiative via `--transition comment_reply`: an open initiative gets mail; a closed review initiative is reopened and its session relaunched in comment-reply mode to respond in-thread; no initiative → dropped. Cursor per PR in `data/reply-watch.json`. New PRs are seeded at first discovery — no historical backfill; only replies after discovery dispatch.

5. **Reviewer nudge** — when a worker pushes fixes on an authored PR that had `CHANGES_REQUESTED` reviews, posts a GitHub @mention to the reviewer. Escalates to the agent after configurable hours (business days only) if no response.

Communication is via HTTP POST to a conductor MCP endpoint (`send_to_agent`). If no conductor is configured, messages go to stdout.

## Key Files

| File | Purpose |
|------|---------|
| `src/daemon.ts` | PR discovery, polling loop, state transitions, branch updates |
| `src/state-machine.ts` | Pure transition function: `(state, event) → newState` |
| `src/state-cache.ts` | JSON file persistence for PR state between polls |
| `src/github.ts` | `gh` CLI wrapper — checks, reviews, PR state, auto-merge, branch updates |
| `src/review-inbox.ts` | Review assignment detection + dedup + already-reviewed filter |
| `src/reply-watch.ts` | Inline review-comment thread scan + reply dispatch |
| `src/notifications.ts` | Sends messages via conductor MCP or logs to stdout |
| `src/config.ts` | Config loader: CLI flags → env vars → config file → defaults |
| `src/types.ts` | All type definitions |
| `src/events.ts` | Append-only JSONL event log |
| `src/index.ts` | CLI entry point (commander) |

## State Machine

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

Terminal states: `MERGED`, `CLOSED` (reachable from any non-terminal state).

The daemon also detects when auto-merge was enabled externally (e.g., by a previous run or manually on GitHub) by checking the `autoMergeRequest` field — it transitions `APPROVED → AUTO_MERGE_ENABLED` automatically.

## Configuration

Two fields are required: `github.authorUsername` and `notifications.notifyAgent`. Everything else has sensible defaults. See `config/shepherd.example.json` and `.env.example`.

To use without a conductor, omit `agent.conductorUrl` — messages log to stdout instead.

## Commands

```bash
make start          # Start the daemon
make start-dry      # Dry-run (no messages sent)
make status         # Show watched PRs
make events         # Event audit log
make inbox          # Pending review assignments
```

## Tests

```bash
npm test            # 182 tests across 9 files
npm run typecheck   # Clean TypeScript check
```

State machine has 81 tests covering every transition, terminal state, and full lifecycle scenario.

## Data Files (gitignored)

- `data/pr-state-cache.json` — last-known state per discovered PR
- `data/pr-events.jsonl` — append-only audit log
- `data/review-inbox.json` — already-notified review assignments (dedup)
- `data/reply-watch.json` — per-PR last-comment cursors for reply-watch threads
