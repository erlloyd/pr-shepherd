# PR Shepherd

Automated PR lifecycle management for AI coding agents. Watches GitHub for your open pull requests and incoming review assignments, detects state transitions (CI pass/fail, reviews, merges), and routes actionable information to `ateam route-pr-event` — so humans only need to write code and review code.

No registration needed. The daemon discovers your PRs from GitHub automatically.

## How It Works

Two watch loops run on a configurable interval (default: 3 minutes):

1. **Authored PR monitoring** — polls GitHub for open non-draft PRs by a configured author. For each PR, checks CI status, reviews, and merge state. On state transitions:
   - **CI fails** → routes a `ci_failed` event to `ateam route-pr-event`
   - **Reviewer requests changes** → routes a `changes_requested` event with the full review body
   - **All approvals received** → enables auto-merge via `gh pr merge --auto --squash`
   - **Branch behind base with auto-merge enabled** → runs `gh pr update-branch` to bring it up to date, then monitors CI until the merge completes. Repeats every poll cycle until merged.
   - **Merge conflicts with auto-merge enabled** → routes an escalation event (cannot auto-resolve)
   - **PR goes stale** (no review activity past threshold) → routes a `stale_detected` event
   - **Enters merge queue** (if `mergeQueue.enabled`) → routes an informational event, no action needed
   - **Left merge queue without merging** → routes an escalation event (usually means the queue's CI check failed)
   - **PR merges** → cleans up state cache, routes a close-out instruction
   - **PR closes** → cleans up state cache silently (no event routed)

2. **Review inbox** — polls GitHub for PRs where you're a requested reviewer. Filters out drafts and old PRs (configurable `maxAgeDays`); PRs you've already reviewed are skipped unless review is re-requested, in which case a focused re-review is dispatched. Routes new assignments to `ateam route-pr-event`.

**Communication:** All events are routed via `ateam route-pr-event` with structured fields (repo, PR number, head branch, transition type). The daemon itself consumes zero AI tokens — it's pure Node.js polling.

## Prerequisites

- **Node.js 22+**
- **GitHub CLI (`gh`)** — authenticated (`gh auth login`)
- **ateam** — on your PATH (or configure `PR_SHEPHERD_ATEAM_PATH`)

## Quick Start

### 1. Clone and install

```bash
git clone <repo-url> pr-shepherd
cd pr-shepherd
npm install
```

### 2. Create your config

```bash
cp config/shepherd.example.json shepherd.config.json
```

Edit `shepherd.config.json` — at minimum you need:

```json
{
  "github": {
    "authorUsername": "your-github-username"
  }
}
```

That's it. `reviewInbox` is optional and disabled by default.

### 3. Set up environment (optional)

```bash
cp .env.example .env
```

Edit `.env` if you need to override the `ateam` binary path or other defaults:

```bash
PR_SHEPHERD_ATEAM_PATH=/path/to/ateam   # only needed if ateam is not on PATH
```

### 4. Start

```bash
make start          # Start the daemon
make start-dry      # Start in dry-run mode (logs only, no events routed)
```

Or without make:

```bash
npx tsx src/index.ts start
npx tsx src/index.ts start --dry-run
```

### 5. Check on things

```bash
make status         # Show watched PRs and their states
make events         # Show event audit log
make inbox          # Show pending review assignments
```

## Configuration

Three layers, in priority order:

1. **CLI flags** — `--dry-run`, `--interval`, `-c <path>`
2. **Environment variables** — `PR_SHEPHERD_*` (see `.env.example`)
3. **Config file** — `shepherd.config.json` in the working directory

### Required Configuration

| Key | Env var | Description |
|-----|---------|-------------|
| `github.authorUsername` | `PR_SHEPHERD_AUTHOR_USERNAME` | GitHub username whose PRs to watch |

### Full Config Reference

```json
{
  "pollIntervalSeconds": 180,
  "staleThresholdHours": 4,
  "requiredApprovals": 1,
  "mergeStrategy": "squash",
  "dryRun": false,

  "github": {
    "defaultRepo": null,
    "authorUsername": "your-github-username"
  },

  "reviews": {
    "ignoreUsers": ["dependabot[bot]"],
    "botUsers": ["your-review-bot[bot]"]
  },

  "checks": {
    "requiredChecks": [],
    "ignoreChecks": ["optional-deploy-preview"]
  },

  "notifications": {
    "webhookUrl": null,
    "channel": null,
    "onMerge": true,
    "onCIFailure": true,
    "onStale": true,
    "onApproval": true
  },

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
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `pollIntervalSeconds` | 180 | How often to poll GitHub (minimum 10) |
| `staleThresholdHours` | 4 | Hours before a PR is considered stale |
| `requiredApprovals` | 1 | Approvals needed before auto-merge |
| `mergeStrategy` | "squash" | Merge method: `squash`, `merge`, or `rebase` |
| `dryRun` | false | Log actions without executing them |
| `github.authorUsername` | **required** | GitHub username whose PRs to watch |
| `github.defaultRepo` | null | Default repo for CLI commands |
| `reviews.ignoreUsers` | [] | Usernames whose reviews are ignored entirely |
| `reviews.botUsers` | [] | Usernames that are bots (logging context only — processed identically to human reviews) |
| `checks.requiredChecks` | [] | If set, only these checks must pass. If empty, all non-skipped checks must pass |
| `checks.ignoreChecks` | [] | Check names to skip when evaluating CI |
| `notifications.webhookUrl` | null | Incoming webhook URL for chat notifications (Slack/Discord/Teams) |
| `reviewInbox.enabled` | false | Enable review assignment detection |
| `reviewInbox.githubUser` | null | GitHub username to watch for review requests |
| `reviewInbox.maxAgeDays` | 5 | Only notify for PRs updated within this many days |
| `reviewInbox.ignoreDrafts` | true | Skip draft PRs |
| `reviewInbox.ignoreRepos` | [] | Repos to exclude from review inbox |
| `mergeQueue.enabled` | false | Detect GitHub's native merge queue (extra `gh api graphql` call per poll while a PR is auto-merge-enabled or queued) |

### Environment Variables

All env vars are optional and override config file values:

```bash
PR_SHEPHERD_AUTHOR_USERNAME=your-github-username
PR_SHEPHERD_ATEAM_PATH=ateam                    # path to ateam binary (default: "ateam")
PR_SHEPHERD_DATA_DIR=./data
PR_SHEPHERD_POLL_INTERVAL=180
PR_SHEPHERD_STALE_HOURS=4
PR_SHEPHERD_REQUIRED_APPROVALS=1
PR_SHEPHERD_DRY_RUN=false
PR_SHEPHERD_DEFAULT_REPO=your-org/your-repo
PR_SHEPHERD_WEBHOOK_URL=https://hooks.slack.com/services/...
PR_SHEPHERD_REVIEW_INBOX_ENABLED=true
PR_SHEPHERD_REVIEW_INBOX_USER=your-github-username
```

## CLI Commands

```bash
pr-shepherd start [options]    # Start the polling daemon
  --dry-run                    # Log without routing events
  --interval <seconds>         # Override poll interval
  -c, --config <path>          # Config file path

pr-shepherd status [options]   # Show watched PRs and their current state
  -c, --config <path>

pr-shepherd events [options]   # Show event audit log
  --pr <number>                # Filter by PR number
  --repo <repo>                # Filter by repository
  -n, --last <count>           # Show last N events
  -c, --config <path>

pr-shepherd inbox [options]    # Show pending review assignments
  -c, --config <path>
```

## Architecture

### State Machine

Each discovered PR is tracked through these states:

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

Terminal states: `MERGED`, `CLOSED` (reachable from any non-terminal state).

### Data Files

All runtime state lives in the `data/` directory (gitignored):

- `pr-state-cache.json` — current state of each watched PR (auto-discovered, not manually registered)
- `pr-events.jsonl` — append-only audit log of every state transition
- `review-inbox.json` — review assignments already notified (dedup list)

### Project Structure

```
pr-shepherd/
├── src/
│   ├── index.ts            CLI entry point
│   ├── daemon.ts            PR discovery + polling loop
│   ├── shepherd.ts          Event message parsing
│   ├── state-machine.ts     State transitions (pure functions)
│   ├── state-cache.ts       State persistence (JSON file)
│   ├── github.ts            GitHub CLI wrapper
│   ├── notifications.ts     Webhook + agent notifications
│   ├── ateam-conductor.ts   Routes events to ateam route-pr-event
│   ├── review-inbox.ts      Review assignment detection
│   ├── events.ts            Event log I/O
│   ├── config.ts            Configuration loader
│   └── types.ts             Type definitions
├── test/                    Vitest test suite
├── config/
│   ├── shepherd.example.json
│   └── system-prompt.txt    Shepherd agent prompt (if running as Claude session)
├── data/                    Runtime state (gitignored)
├── Makefile
└── .env.example
```

## Development

```bash
npm install
npm test              # Run test suite
npm run typecheck     # TypeScript checking
npm run build         # Compile to dist/
make start-dry        # Test against real GitHub data without routing events
```

## License

MIT
