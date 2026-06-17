# PR Shepherd

Automated PR lifecycle management for AI coding agents. Watches GitHub for your open pull requests and incoming review assignments, detects state transitions (CI pass/fail, reviews, merges), and routes actionable information to a designated agent — so humans only need to write code and review code.

No registration needed. The daemon discovers your PRs from GitHub automatically.

## How It Works

Two watch loops run on a configurable interval (default: 3 minutes):

1. **Authored PR monitoring** — polls GitHub for open non-draft PRs by a configured author. For each PR, checks CI status, reviews, and merge state. On state transitions:
   - **CI fails** → sends failure details to your notify agent
   - **Reviewer requests changes** → sends the full review body to your notify agent
   - **All approvals received** → enables auto-merge via `gh pr merge --auto --squash`
   - **PR goes stale** (no review activity past threshold) → sends a stale notice
   - **PR merges or closes** → cleans up state cache, sends confirmation

2. **Review inbox** — polls GitHub for PRs where you're a requested reviewer. Filters out drafts, old PRs (configurable `maxAgeDays`), and PRs you've already reviewed. Sends new assignments to your notify agent.

**Communication:** All messages are sent via an [Agent Conductor](https://github.com/your-org/agent-conductor) MCP server using `send_to_agent`. If no conductor is configured, messages are logged to stdout instead. The daemon itself consumes zero AI tokens — it's pure Node.js polling.

## Prerequisites

- **Node.js 22+**
- **GitHub CLI (`gh`)** — authenticated (`gh auth login`)
- **Agent Conductor** (optional) — for routing messages to other agents

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
  },
  "notifications": {
    "notifyAgent": "your-assistant-agent"
  }
}
```

### 3. Set up environment

```bash
cp .env.example .env
```

Edit `.env` — set `PR_SHEPHERD_CONDUCTOR_URL` if you're using a conductor:

```bash
PR_SHEPHERD_CONDUCTOR_URL=http://localhost:3456
```

### 4. Register with the conductor (if using one)

Create an agent config for pr-shepherd in your conductor's `config/agents/` directory:

```yaml
# config/agents/pr-shepherd.yaml
agent: pr-shepherd
codename: pr-shepherd
repo: /path/to/pr-shepherd
model: claude-sonnet-4-6
maxTurns: 10
```

The conductor will create an MCP endpoint at `/mcp/pr-shepherd` that the daemon uses to send messages. The conductor hot-reloads agent configs, so it should pick this up within 5 minutes — or restart the conductor to load it immediately.

### 5. Start

```bash
make start          # Start the daemon
make start-dry      # Start in dry-run mode (logs only, no messages sent)
```

Or without make:

```bash
npx tsx src/index.ts start
npx tsx src/index.ts start --dry-run
```

### 6. Check on things

```bash
make status         # Show watched PRs and their states
make events         # Show event audit log
make inbox          # Show pending review assignments
```

## Running Without a Conductor

PR Shepherd works without an agent conductor. If `PR_SHEPHERD_CONDUCTOR_URL` is not set (or `agent.conductorUrl` is null in config), messages are logged to stdout instead of being routed to agents. This is useful for:

- **Testing** — run `make start-dry` to see what the daemon would do
- **Simple setups** — pipe stdout to a log file or monitoring tool
- **Integration with other systems** — parse the structured log output

You can also set `notifications.webhookUrl` to send notifications to a Slack/Discord/Teams incoming webhook independently of the conductor.

## Configuration

Three layers, in priority order:

1. **CLI flags** — `--dry-run`, `--interval`, `-c <path>`
2. **Environment variables** — `PR_SHEPHERD_*` (see `.env.example`)
3. **Config file** — `shepherd.config.json` in the working directory

### Required Configuration

| Key | Env var | Description |
|-----|---------|-------------|
| `github.authorUsername` | `PR_SHEPHERD_AUTHOR_USERNAME` | GitHub username whose PRs to watch |
| `notifications.notifyAgent` | `PR_SHEPHERD_NOTIFY_AGENT` | Agent codename to send all PR issues to |

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

  "agent": {
    "conductorUrl": "http://localhost:3456",
    "shepherdPane": null
  },

  "notifications": {
    "webhookUrl": null,
    "channel": null,
    "notifyAgent": "your-assistant-agent",
    "onMerge": true,
    "onCIFailure": true,
    "onStale": true,
    "onApproval": true
  },

  "reviewInbox": {
    "enabled": true,
    "githubUser": "your-github-username",
    "notifyAgent": "your-assistant-agent",
    "notifyPane": null,
    "ignoreRepos": [],
    "ignoreDrafts": true,
    "maxAgeDays": 5
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
| `agent.conductorUrl` | null | Conductor MCP server URL. If null, messages go to stdout |
| `notifications.notifyAgent` | **required** | Agent codename to route all PR issues to |
| `notifications.webhookUrl` | null | Incoming webhook URL for chat notifications (Slack/Discord/Teams) |
| `reviewInbox.enabled` | false | Enable review assignment detection |
| `reviewInbox.githubUser` | null | GitHub username to watch for review requests |
| `reviewInbox.notifyAgent` | null | Agent to notify for review assignments (falls back to `notifications.notifyAgent`) |
| `reviewInbox.maxAgeDays` | 5 | Only notify for PRs updated within this many days |
| `reviewInbox.ignoreDrafts` | true | Skip draft PRs |
| `reviewInbox.ignoreRepos` | [] | Repos to exclude from review inbox |

### Environment Variables

All env vars are optional and override config file values:

```bash
PR_SHEPHERD_DATA_DIR=./data
PR_SHEPHERD_CONDUCTOR_URL=http://localhost:3456
PR_SHEPHERD_AUTHOR_USERNAME=your-github-username
PR_SHEPHERD_NOTIFY_AGENT=your-assistant-agent
PR_SHEPHERD_POLL_INTERVAL=180
PR_SHEPHERD_STALE_HOURS=4
PR_SHEPHERD_REQUIRED_APPROVALS=1
PR_SHEPHERD_DRY_RUN=false
PR_SHEPHERD_DEFAULT_REPO=your-org/your-repo
PR_SHEPHERD_WEBHOOK_URL=https://hooks.slack.com/services/...
PR_SHEPHERD_REVIEW_INBOX_ENABLED=true
PR_SHEPHERD_REVIEW_INBOX_USER=your-github-username
PR_SHEPHERD_REVIEW_INBOX_AGENT=your-assistant-agent
```

## CLI Commands

```bash
pr-shepherd start [options]    # Start the polling daemon
  --dry-run                    # Log without sending messages
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
OPENED → CI_PENDING → CI_PASSED → AWAITING_REVIEW → APPROVED → AUTO_MERGE_ENABLED → MERGED
                    ↘ CI_FAILED ──→ (notify agent) ──→ CI_PENDING (on new commit)
                                    AWAITING_REVIEW → CHANGES_REQUESTED → (notify agent) → CI_PENDING (on new commit)
                                    AWAITING_REVIEW → STALE → (notify agent)
```

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
│   ├── notifications.ts     Conductor + webhook notifications
│   ├── review-inbox.ts      Review assignment detection
│   ├── events.ts            Event log I/O
│   ├── config.ts            Configuration loader
│   └── types.ts             Type definitions
├── test/                    Vitest test suite (113 tests)
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
npm test              # Run test suite (113 tests)
npm run typecheck     # TypeScript checking
npm run build         # Compile to dist/
make start-dry        # Test against real GitHub data without sending messages
```

## License

MIT
