# Re-review on review re-request

**Date:** 2026-07-14
**Repos affected:** pr-shepherd (this repo), agent-teams (`~/Code/agent-teams`)

## Problem

When our review agent posts a COMMENT review with findings and the author addresses
them and clicks "re-request review" on GitHub, nothing happens:

- **pr-shepherd** drops the re-request twice over: the inbox dedup key (`repo#number`,
  `src/review-inbox.ts:52-54`) skips any PR with an existing record, and
  `hasUserReviewed` (`src/review-inbox.ts:56-72`) permanently suppresses any PR where
  a review of ours exists. Nothing reads GitHub's re-request signal.
- **agent-teams** has no `re_review` transition (`internal/verbs/route_types.go:13-22`);
  the review initiative is closed by the `review-pr` skill immediately after the first
  review posts (`plugins/agent-teams/skills/review-pr/skill.md:165-169`), so even a
  routed event would find no open initiative and be skipped (`route.go:70-74`).

The existing review-followup subsystem (`src/review-followup.ts`) does not cover this:
it only tracks PRs where our latest review is `CHANGES_REQUESTED`, and our agents post
`COMMENT` reviews.

## Goal

A re-request triggers a **focused re-review** — verify that previously raised findings
were addressed; raise no new findings. The original review initiative is **reopened**
(same bd record, same worktree). If the reviewer session is still alive it handles the
re-review in place; if it is gone, a fresh reviewer session is launched — never a DRI.

## Detection signal (pr-shepherd)

GitHub removes a user from `requested_reviewers` when they submit a review and re-adds
them on re-request. Therefore:

- **Re-request** = PR appears in `gh search prs --review-requested=<user>` AND
  `hasUserReviewed` returns true.
- **Re-review done** = PR drops back out of that search (our new review posted), or
  the PR merges/closes.

No new polling machinery; the existing inbox poll already runs this search.

## Design

### 1. pr-shepherd: review-inbox re-request handling

`src/review-inbox.ts`, `src/types.ts`, `src/ateam-conductor.ts`.

**New status** in `ReviewAssignmentStatus` (`src/types.ts:89-94`): `re_review_dispatched`.
New optional `ReviewAssignment` field: `reReviewDispatchedAt: string`.

**Detection** (in `pollReviewInbox`, replacing the unconditional skip at
`review-inbox.ts:140-143`): for each PR returned by the review-requested search where
`hasUserReviewed` is true:

- Inbox record exists with status `review_submitted` → this is a re-request. Set
  status `re_review_dispatched`, stamp `reReviewDispatchedAt`, dispatch (below).
- No inbox record (pruned after 7 days, or reviewed before the daemon existed) →
  same: create a record directly in `re_review_dispatched` and dispatch.
- Record exists with status `re_review_dispatched` → re-review already dispatched;
  do nothing (the PR stays in the search until our new review posts — the status is
  the dedup cursor).
- Record exists with status `dispatched` / `pending_bot_review` → unreachable when
  `hasUserReviewed` is true (first review not yet posted); no change to that path.

**Completion** (per-poll processing of `re_review_dispatched` items):

- PR no longer in the review-requested search AND a review of ours newer than
  `reReviewDispatchedAt` exists → set status back to `review_submitted`, stamp
  `completedAt`. The cycle can repeat on a further re-request.
- PR merged/closed while `re_review_dispatched` → same handling as `dispatched`
  today (`review-inbox.ts:181-209`): notify "review no longer needed", set terminal
  status.

**Dispatch:** route with a new explicit transition. `routeToAgent`
(`src/ateam-conductor.ts:51-104`) currently maps a boolean to
`review_requested`/`other`; extend its options to accept an explicit transition
string and pass `re_review`. Message body:

> Re-review requested for <url> ("<title>"). You previously reviewed this PR and the
> author has addressed your findings and re-requested review. Fetch your prior review
> comments (`gh pr view --json reviews` + review comments), verify each finding was
> addressed by the new commits, and post a short COMMENT review with the outcome per
> finding. Do not raise new findings.

The body is self-contained (instructs fetching prior findings from GitHub) so it is
correct whether it lands in a context-preserving session or a fresh one.

**Event log:** append `review_requested` event with `details.type: "re_review_inbox"`
(distinct from follow-up's `re_review`).

### 2. agent-teams: `re_review` transition and routing

`internal/verbs/route.go`, `route_types.go`, `route_match.go`.

- Add `re_review` to the transition enum (`route_types.go:13-22`) and the kong enum
  tag (`route.go:23`).
- New branch in `Run` (`route.go:38-75`), for `transition == re_review`:
  1. `matchInitiative` against **open** initiatives (existing) → matched: existing
     `send` path, plus `--resume-launch-prompt` (below).
  2. No open match → look up **closed** initiatives by `pr-url` (new match helper
     over `bd list --status=closed`, reusing the `MatchPRField` logic from
     `route_match.go:112-127`; pick most recently closed on multiple matches) →
     `ateam reopen <id>`, then
     `ateam send <id> --file <body> --sender pr-shepherd --resume-launch-prompt "/agent-teams:review-pr <id>"`.
  3. No initiative at all → `spawnReviewInitiative` (existing, `route.go:100-157`).
  4. If reopen or send fails (e.g. worktree manually deleted, resume validation at
     `dispatch.go:320-323` fails) → log and fall back to `spawnReviewInitiative`.
     A fresh initiative/worktree is always a safe fallback.

Reopen **must** precede send: every mail/doorbell hook resolves the initiative by
matching cwd against open initiatives only (`session-start-inbox.sh:31-38`,
`wake-watcher.sh:47-54`, `inbox-drain.sh:35-42`) — mail delivery is inert for a
closed initiative.

### 3. agent-teams: `--launch-prompt` on resume, threaded through send

The three liveness branches inside `send` (`messaging.go:116-149`) already do the
right thing for two cases: busy/waiting → doorbell; idle-but-tracked →
`claude respawn` (preserves the reviewer's full conversation). The third —
session gone → `defaultResume` (`messaging.go:287-291`) — launches the hardcoded
`/dri <id>` prompt (`launchBGSession`, `dispatch.go:436-439`), i.e. a DRI in a
review worktree.

Fix, no persistence:

- `resumeKong` (`dispatch.go:283-287`) gains optional `--launch-prompt`. When set,
  launch via `rawLaunchBGSession` with that prompt; default remains `/dri <id>`.
- `sendKong` gains optional `--resume-launch-prompt`, handed to the resume call only
  when the dead-session escalation branch fires. Omitted → today's behavior exactly.
- route.go's `re_review` sends pass
  `--resume-launch-prompt "/agent-teams:review-pr <id>"`.

### 4. agent-teams: review-pr skill re-review mode

`plugins/agent-teams/skills/review-pr/skill.md`.

Early step (after reading the initiative, before reviewing): check
`gh pr view --json reviews` for an existing review authored by us.

- **Our review exists → re-review mode:** fetch our prior review body and review
  comments, diff the commits since our review, verify each finding addressed, post a
  **short COMMENT review** stating the outcome per finding (addressed / not addressed
  with reason). No new findings. Then note and close the initiative as usual.
- **No prior review → full review** (existing behavior, unchanged).

Self-detection makes the skill correct in every arrival path — reopened+resumed fresh
session, respawned session with context, or brand-new spawned initiative — without
flag plumbing.

## Deploy order

agent-teams first (old `ateam` rejects an unknown `--transition re_review` at kong
parse time), then pr-shepherd.

## Out of scope

- The review-followup subsystem (`src/review-followup.ts`) is unchanged. Its latent
  bug (`review-followup.ts:173` always-false SHA comparison) is noted separately, not
  part of this feature.
- No worker/session identity model is added; "free the worker" messaging stays prose.
- Repos without a `~/.agent-teams/review-repos/<repo-key>` mapping keep today's
  behavior (spawn path logs and skips, `route.go:105-113`).

## Testing

**pr-shepherd** (vitest, extend `review-inbox` tests):
- re-request detected: `review_submitted` record + PR in search + `hasUserReviewed`
  true → status `re_review_dispatched`, one dispatch with transition `re_review`.
- no re-dispatch on subsequent polls while `re_review_dispatched`.
- pruned record: no inbox record + `hasUserReviewed` true → record created in
  `re_review_dispatched`, dispatched.
- completion: PR leaves search + newer review of ours → back to `review_submitted`;
  a second re-request then re-dispatches (full cycle).
- merged/closed during `re_review_dispatched` → "no longer needed" notification,
  terminal status.
- first-review path (`dispatched` lifecycle) unchanged.

**agent-teams** (Go tests, mirroring existing route/messaging tests):
- `re_review` + open initiative match → send path with resume-launch-prompt.
- `re_review` + closed initiative with matching pr-url → reopen then send.
- `re_review` + no initiative → spawn.
- reopen/send failure → spawn fallback.
- `resume --launch-prompt` launches the given prompt; without it, `/dri <id>`.
- `send --resume-launch-prompt` only affects the dead-session escalation branch.

**Manual E2E:** re-request on a real reviewed PR; verify reopened initiative, mail
delivery, reviewer (not DRI) session, focused COMMENT re-review, initiative closed,
pr-shepherd status back to `review_submitted`.
