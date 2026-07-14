# Comment-reply forwarding

**Date:** 2026-07-14
**Repos affected:** pr-shepherd (this repo), agent-teams (`~/Code/agent-teams`)
**Builds on (unmerged):** pr-shepherd `re-review-on-re-request` (explicit `transition` option on `routeToAgent`), agent-teams `re-review-routing` (`matchClosedReviewInitiative`, `reopen`, `mail send --resume-launch-prompt`). Both feature branches stack on those.

## Problem

When someone replies to an inline review comment authored by our GitHub identity —
on a PR our agents reviewed, or on a PR an active initiative owns — nothing
notices. The reply sits unanswered unless Eric happens to look.

## Goal

Detect replies in inline review-comment threads we participated in, and mail the
reply (with response instructions) to the owning agent-teams initiative:

- **Open initiative** (active DRI work, or a review still in flight) → mail only;
  the live session reads it via the existing hook flow and acts on the body.
- **Closed review initiative** (our agents reviewed, then closed) → reopen + mail +
  relaunch the session in a dedicated comment-reply mode that responds in-thread
  on GitHub and closes the initiative again.
- **No initiative** → log and skip. (No spawn — a fresh full review is the wrong
  response to a comment.)

Scope: **inline review-comment threads only** (`repos/O/R/pulls/N/comments`).
Conversation-tab comments have no reply threading and are out of scope.

## Detection model: thread participation

GitHub's REST model sets a reply's `in_reply_to_id` to the **thread root**, not
the comment it visually answers. So "replies to my comments" is implemented as
**threads I participated in**:

- Thread key = `in_reply_to_id ?? id` (root comment id).
- A thread is *ours* if any comment in it is authored by our GitHub identity.
- A *new reply* = a comment in one of our threads, authored by someone else,
  `created_at` **after our last comment in that thread** AND after the per-PR
  cursor.

The "after our last comment" condition is the loop guard: once we respond
in-thread, the condition goes false until the other party replies again. Each
round of an ongoing conversation re-triggers — that is intended behavior.

## Design

### 1. pr-shepherd: new reply-watch subsystem

New file `src/reply-watch.ts`, wired into the daemon interval loop alongside the
other pollers (`daemon.ts:542-547`).

**Config:** new block `replyWatch: { enabled: boolean }` (default `true`),
following the `reviewFollowUp` pattern. Identity =
`reviewInbox.githubUser ?? github.authorUsername`; if neither is set the poller
no-ops.

**Discovery (per poll):** union, deduped by `repo#number`, of
1. open PRs from `gh search prs --reviewed-by=<user> --state=open` (PRs our
   agents reviewed — the inbox search loses these the moment our review posts,
   and inbox records get pruned, so `--reviewed-by` is the durable source), and
2. the authored PRs already in the state cache (`WatchedPR[]`, open by
   construction).

Respect `reviewInbox.ignoreRepos`/`github.ignoreRepos` for the respective
populations.

**Scan (per PR):** one `gh api repos/{owner}/{repo}/pulls/{n}/comments` call via
a new fetcher in `src/github.ts` (sibling of `fetchCommentsByUsers`,
`github.ts:137-165`) that parses `id`, `in_reply_to_id`, `user.login`, `body`,
`created_at`, `path`. Detection per the thread-participation model above is a
**pure function** (testable without gh): 
`findNewReplies(comments, githubUser, cursor) → Reply[]` where
`Reply = { rootId, path, author, body, createdAt }`.

**State:** `data/reply-watch.json` — `Array<{ number, repo, lastReplyNotifiedAt }>`.
Records whose PR is absent from the current discovery union are dropped (the
searches only return open PRs; a merged/closed PR's cursor is no longer needed).

**Dispatch:** all new replies for a PR batch into one message:

```
[PR Shepherd] Comment reply: PR #<n> (<owner/repo>)
"<title>"
<url>

@<author> replied in a review-comment thread you participated in (<path>):
> <reply body, quoted>

[...one block per reply...]

Respond in-thread on GitHub: gh api repos/<owner>/<repo>/pulls/<n>/comments -f body="..." -F in_reply_to=<rootId>
Answer the question, or concede/hold with a brief reason. Do not raise new findings or start new threads.
```

Routed via `routeToAgent(config, msg, { transition: "comment_reply" })`. The
cursor advances to the max `createdAt` of the notified replies only after a
non-dry-run dispatch. Event log: `event: "comment_reply"` (added to the
`PREvent` union in `src/types.ts`), `details.type: "reply_watch"` with
`rootId`s.

**dryRun:** log what would be sent, no dispatch, no cursor advance, no state
writes — same conventions as the other pollers.

### 2. agent-teams: `comment_reply` transition

- `route_types.go`: `TransitionCommentReply PRTransition = "comment_reply"`;
  added to the kong enum tag in `route.go:23`.
- `route.go` decision matrix:
  - **Open initiative match** → existing send path unchanged (`sendArgs` appends
    resume flags only for `re_review`; a comment_reply send carries none — a
    dead DRI session resuming as DRI is correct, and for a still-open review
    initiative the session is normally alive).
  - **No open match + `comment_reply`** → `routeCommentReply`: reuse
    `matchClosedReviewInitiative` (pr-field only, most recent). Found → `reopen`
    then `mail send <id> --file <body> --sender pr-shepherd
    --resume-launch-prompt "/agent-teams:review-pr <id> comment-reply"
    --resume-model sonnet`. Not found, or reopen/send failure → log and skip
    (explicitly NO spawn fallback, unlike re_review).
- Release protocol applies (rebuild binaries, bump both manifests).

### 3. agent-teams: review-pr skill comment-reply mode

`plugins/agent-teams/skills/review-pr/SKILL.md`:

- Step 1 (argument parsing) gains an optional second token: `comment-reply`.
- **The skill never runs `ateam mail inbox`** — the hooks own mail consumption.
  Mode comes exclusively from the launch argument; the pr-shepherd mail is
  context that arrives via the normal hook flow, not the control signal.
- New mode section (used when the argument is present; skips diff/reviewer/
  review-posting steps entirely):
  1. Read initiative fields (`pr-number`, `pr-repo`, `pr-url`) as today.
  2. Fetch `gh api repos/<o>/<r>/pulls/<n>/comments`; group into threads by
     `in_reply_to_id ?? id`; select threads where our identity commented and a
     newer comment by someone else exists after our last comment.
  3. For each such thread: read the thread and enough surrounding code/diff
     context to respond substantively; post one in-thread reply
     (`-F in_reply_to=<root id>`): answer the question, concede with a brief
     reason, or hold position with a brief reason. No new findings, no new
     threads, no code changes, no review posting.
  4. If no qualifying threads (already handled or stale notification): note
     that and proceed to close.
  5. Note the outcome (`comment-replies: PR #<n> — <k> thread(s) answered`) and
     close the initiative, as the existing flow does.
- First-review / re-review flows: untouched when the argument is absent.

## Identity note

Agents post under the same GitHub identity as Eric, so "our comments" =
comments authored by the configured user, regardless of who typed them. A reply
posted by that identity never triggers detection (author filter) — including
replies Eric writes by hand, which correctly silence the thread until the other
party responds.

## Deploy order

agent-teams first (old `ateam` rejects `--transition comment_reply` at kong
parse time), then pr-shepherd. Both stack on the unmerged re-review branches —
merge those first or merge the stacks together.

## Out of scope

- Conversation-tab (issue) comments, @mentions, quote-replies.
- Auto-fixing code in response to a reply (the response is conversational only).
- Spawning new initiatives for reply events.
- Reviewer-nudge / bot-feedback subsystems: unchanged.

## Testing

**pr-shepherd (vitest):**
- `findNewReplies` pure-function tests: reply to our root → detected; reply in a
  thread we joined mid-way (root not ours) → detected; our own reply → not
  detected; reply older than our last comment in thread → not detected; cursor
  excludes previously notified replies; multiple threads batch correctly.
- Poller tests (mocked `execFileSync`): discovery union + dedup; dispatch with
  `{ transition: "comment_reply" }`; cursor advance only on real dispatch;
  dryRun no-ops; record dropped when PR leaves discovery.
- Fetcher parses `id`/`in_reply_to_id`/`path`.

**agent-teams (Go):**
- `comment_reply` + open match → plain send, no resume flags.
- `comment_reply` + closed review-initiative match → reopen then send with
  `--resume-launch-prompt "/agent-teams:review-pr <id> comment-reply"`.
- `comment_reply` + no initiative → skip, no dispatch call, log line.
- reopen/send failure → skip (no spawn).

**Manual E2E:** agent reviews a test PR (initiative closes) → author replies to
an inline comment → within one poll: mail lands, initiative reopens, relaunched
session posts an in-thread response and closes the initiative; a second reply
re-triggers the cycle; our own manual reply does not.
