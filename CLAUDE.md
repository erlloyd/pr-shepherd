# PR Shepherd

Automated PR lifecycle daemon. Discovers open PRs from GitHub, monitors CI and reviews, routes issues to a designated agent. No manual PR registration — everything is auto-discovered.

## Architecture

A single long-running Node.js process with two polling loops on a shared interval:

1. **Authored PR monitoring** — `gh search prs --author=<user>` discovers open PRs. For each, polls CI checks and reviews. Detects state transitions via a pure-function state machine. Routes actionable events (CI failures, review feedback, approvals, stale PRs) to a configured agent via an Agent Conductor MCP server.

2. **Review inbox** — `gh search prs --review-requested=<user>` discovers incoming review assignments. Filters by age, draft status, and whether the user has already reviewed. Sends new assignments to the configured agent.

Communication is via HTTP POST to a conductor MCP endpoint (`send_to_agent`). If no conductor is configured, messages go to stdout.

## Key Files

| File | Purpose |
|------|---------|
| `src/daemon.ts` | Main polling loop — discovers PRs, polls state, dispatches events |
| `src/state-machine.ts` | Pure transition function: `(state, event) → newState` |
| `src/state-cache.ts` | JSON file persistence for PR state between polls |
| `src/github.ts` | `gh` CLI wrapper — fetches checks, reviews, PR state |
| `src/review-inbox.ts` | Review assignment detection + dedup + already-reviewed filter |
| `src/notifications.ts` | Sends messages via conductor MCP or webhooks |
| `src/config.ts` | Config loader: CLI flags → env vars → config file → defaults |
| `src/types.ts` | All type definitions |
| `src/events.ts` | Append-only JSONL event log |
| `src/index.ts` | CLI entry point (commander) |

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
npm test            # 113 tests across 6 files
npm run typecheck   # Clean TypeScript check
```

State machine has 70 tests covering every transition, terminal state, and full lifecycle scenario.

## Data Files (gitignored)

- `data/pr-state-cache.json` — last-known state per discovered PR
- `data/pr-events.jsonl` — append-only audit log
- `data/review-inbox.json` — already-notified review assignments (dedup)
