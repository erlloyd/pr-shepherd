# Console logging overhaul

**Date:** 2026-07-14
**Repo:** pr-shepherd (branch `re-review-on-re-request`)

## Problem

The daemon's console stream is untrackable (audit findings, file:line refs as of
`7a7df86`):

- Four prefix/timestamp shapes on one stream: daemon lines have no subsystem tag
  (`daemon.ts:48-50`), conductor lines have no timestamp (`ateam-conductor.ts`,
  7 bare `console.log` sites), subsystems use `[ISO] [name]`, and inbox debug
  lines are triple-tagged (`review-inbox.ts:361,365,367`).
- No verbosity control anywhere; every `[debug]` literal prints unconditionally.
- Errors go to stdout via `log()`, indistinguishable from info; only
  corrupt-state warnings use `console.error`.
- A quiet 180s tick prints ~8 bookkeeping lines (`Discovering…`, `Found N…`,
  per-PR `already notified … skipping dispatch` forever, three `Active:`/
  `Tracking:` summaries). The real signal already lives in `pr-events.jsonl`.
- `ateam-conductor.ts:98,105` echo unbounded `ateam` stdout/stderr.

## Design

### `src/log.ts` — single logger module

```
createLogger(subsystem: string) → { info, warn, error, debug }
setVerbose(v: boolean)
```

- Format: `HH:MM:SS LEVEL [subsystem] message` — local wall-clock time,
  fixed-width level token (`INFO `, `WARN `, `ERROR`, `DEBUG`).
- `info`/`debug` → stdout; `warn`/`error` → stderr.
- `debug` prints only when verbose (set via `--verbose` CLI flag on `start`, or
  `PR_SHEPHERD_VERBOSE=true`).

### Call-site conversion

Every module gets `const log = createLogger("<name>")`: `daemon`, `review-inbox`,
`review-followup`, `reviewer-nudge`, `reply-watch`, `conductor`, `state-cache`.
The per-module `log()` helpers and all bare `console.log/error` daemon-path
calls are replaced. `[pr-shepherd][debug]` literals are deleted (the level token
carries that meaning). `src/index.ts` CLI table output (status/events/inbox
subcommands) stays bare `console.log` — it is command output, not daemon logging.

**Level mapping:**
- `error`: all catch-block operational failures (currently `log(...)` on
  stdout), conductor route failures, corrupt-state warnings (these become
  `warn`).
- `info` (default visible): state transitions, dispatches/forwards/escalations,
  actions (branch update, auto-merge, merge queue, nudge posted), startup
  banner, dry-run `would…` lines, the new heartbeat.
- `debug` (verbose only): `Discovering…`/`Found N…`, `already notified …
  skipping dispatch`, `Active:`/`Tracking:` backlog summaries, conductor exec
  chatter (`exec: ateam…`, `stdout: …`, `exited successfully`), other
  bookkeeping.

### Heartbeat

After each full poll cycle, `daemon.ts` prints one info line summarizing the
cycle: `poll ok — <A> authored, <I> inbox (<R> re-review pending), <F> followups,
<N> nudges, <W> reply-watch` (subsystems omitted when disabled). Pollers return
lightweight counts to feed it; a quiet console is exactly one line per interval,
so silence unambiguously means the daemon is down.

### Bounded echo

Conductor's `route-pr-event stdout:` echo truncates to 200 chars single-line at
debug level; the failure path keeps stderr content but truncates to 500 chars,
at error level.

## Out of scope

- `pr-events.jsonl` / `appendEvent` — unchanged.
- CLI subcommand table output — unchanged.
- Message bodies sent to agents — unchanged.
- No new logging dependencies; hand-rolled module.

## Testing

- Unit tests for `log.ts`: format shape, level routing (stdout vs stderr),
  debug gating via `setVerbose`.
- Existing suite stays green; tests that spy on `console.log` wording keep
  passing (message text preserved where asserted, e.g. `[dry-run]`,
  `couldn't parse PR identity`, `ateam route-pr-event failed`).
- Manual: one quiet cycle in `--dry-run` shows banner + heartbeat only;
  `--verbose` restores per-PR detail.
