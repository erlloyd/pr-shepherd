# Re-review on Review Re-request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a review is re-requested on a PR our agent already reviewed, dispatch a focused re-review — reopening the original review initiative and reusing its session if alive, resuming it as a *reviewer* (never a DRI) if dead, or spawning fresh if no initiative exists.

**Architecture:** Two repos, deploy-ordered. agent-teams gains a `re_review` transition in `route-pr-event` (reopen closed initiative → `mail send` with a reviewer resume-prompt threaded through send's dead-session escalation), a `--launch-prompt` option on `resume`, and a re-review mode in the review-pr skill. pr-shepherd's review-inbox detects re-requests (PR reappears in the `--review-requested` search while our review exists) and routes with `--transition re_review`.

**Tech Stack:** Go (kong CLI verbs, table-driven tests) in `~/Code/agent-teams`; TypeScript + vitest in `~/Code/pr-shepherd-fork`; skill markdown in `plugins/agent-teams/skills/review-pr/skill.md`.

**Spec:** `docs/superpowers/specs/2026-07-14-re-review-on-re-request-design.md` (this repo).

## Global Constraints

- **Deploy order:** agent-teams (Tasks 1–5) merges/installs BEFORE pr-shepherd (Tasks 6–8). Old `ateam` rejects `--transition re_review` at kong parse time.
- **agent-teams repo:** work on branch `re-review-routing`; repo uses beads — file a bd issue before coding (Task 1 step 1), close it in Task 5. Gates: `go build ./...`, `go vet ./...`, `go test ./...`, `gofmt -l` empty. 🚨 Release protocol: any CLI change requires `sh scripts/build-binaries.sh` + version bump in BOTH `.claude-plugin/marketplace.json` and `plugins/agent-teams/.claude-plugin/plugin.json` (Task 5).
- **pr-shepherd repo:** work on the existing branch `re-review-on-re-request`. Gates: `npm test`, `npm run typecheck`. No beads in this repo.
- No `eslint-disable` / `@ts-ignore` / `@ts-expect-error`. Match each file's existing comment density and style.
- Never run the agent-teams `eval/` harness (costs real money). `go test ./...` is the free path.
- Model default preserved everywhere: `resume` without `--launch-prompt` behaves exactly as today (`/dri <id>`, opus/advisor logic untouched).

---

## Part 1 — agent-teams (`/Users/ericlloyd/Code/agent-teams`)

### Task 1: `ateam resume --launch-prompt` / `--model`

**Files:**
- Modify: `internal/verbs/dispatch.go` (resumeKong ~283-335, registration ~28-30)
- Test: `internal/verbs/resume_test.go`

**Interfaces:**
- Consumes: existing `rawLaunchFunc` / `rawLaunchBGSession` (`dispatch.go:407,414`), `launchFunc` / `launchBGSession`.
- Produces: `resumeKong{ID, LaunchPrompt, Model, launch, launchRaw}` — Task 2's `defaultResume` sets `LaunchPrompt`/`Model`/`launchRaw`.

- [ ] **Step 1: File the bd issue and branch**

```bash
cd /Users/ericlloyd/Code/agent-teams
git checkout main && git pull --rebase
git checkout -b re-review-routing
bd create "re_review routing: resume --launch-prompt, send threading, route-pr-event re_review branch, review-pr re-review mode" -t feature -d "Spec: pr-shepherd-fork docs/superpowers/specs/2026-07-14-re-review-on-re-request-design.md. Reopen closed review initiative on re-request, mail it, resume dead sessions as reviewer (not DRI)."
bd update <returned-id> --claim
```

- [ ] **Step 2: Write the failing tests**

Append to `internal/verbs/resume_test.go` (uses existing `fakeBD`/`makeCtx` helpers from `dispatch_test.go`):

```go
// ---- resumeKong: --launch-prompt -------------------------------------------

func TestResume_CustomLaunchPromptUsesRawLaunch(t *testing.T) {
	dir := t.TempDir()
	fbd := &fakeBD{
		runFn: func(args ...string) (string, error) {
			issues := []bd.Issue{{ID: "at-rr1", Status: "open", Description: "worktree: " + dir + "\n"}}
			raw, _ := json.Marshal(issues)
			return string(raw), nil
		},
	}
	ctx, _, _ := makeCtx(fbd, t.TempDir())

	var gotDir, gotPrompt, gotModel string
	cmd := &resumeKong{
		ID:           "at-rr1",
		LaunchPrompt: "/agent-teams:review-pr at-rr1",
		Model:        "sonnet",
		launch: func(_ *cli.Context, _, _ string) error {
			t.Fatal("launch called; want launchRaw for --launch-prompt")
			return nil
		},
		launchRaw: func(_ *cli.Context, d, p, m, _ string) error {
			gotDir, gotPrompt, gotModel = d, p, m
			return nil
		},
	}
	if err := cmd.Run(ctx); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotDir != dir {
		t.Errorf("launchRaw dir = %q, want %q", gotDir, dir)
	}
	if gotPrompt != "/agent-teams:review-pr at-rr1" {
		t.Errorf("launchRaw prompt = %q", gotPrompt)
	}
	if gotModel != "sonnet" {
		t.Errorf("launchRaw model = %q, want sonnet", gotModel)
	}
}

func TestResume_NoLaunchPromptUsesDriLaunch(t *testing.T) {
	dir := t.TempDir()
	fbd := &fakeBD{
		runFn: func(args ...string) (string, error) {
			issues := []bd.Issue{{ID: "at-rr2", Status: "open", Description: "worktree: " + dir + "\n"}}
			raw, _ := json.Marshal(issues)
			return string(raw), nil
		},
	}
	ctx, _, _ := makeCtx(fbd, t.TempDir())

	var gotArg string
	cmd := &resumeKong{
		ID: "at-rr2",
		launch: func(_ *cli.Context, _, arg string) error {
			gotArg = arg
			return nil
		},
		launchRaw: func(_ *cli.Context, _, _, _, _ string) error {
			t.Fatal("launchRaw called; want launch for default path")
			return nil
		},
	}
	if err := cmd.Run(ctx); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotArg != "at-rr2" {
		t.Errorf("launch driArg = %q, want at-rr2", gotArg)
	}
}

func TestResume_ModelWithoutLaunchPromptRejected(t *testing.T) {
	err := (&resumeKong{ID: "at-x", Model: "sonnet"}).Validate()
	if err == nil {
		t.Fatal("expected UsageError for --model without --launch-prompt, got nil")
	}
	if code := cli.ExitCode(err); code != 2 {
		t.Errorf("expected exit 2, got %d", code)
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/ericlloyd/Code/agent-teams && go test ./internal/verbs/ -run 'TestResume_CustomLaunchPrompt|TestResume_NoLaunchPrompt|TestResume_ModelWithout' -v`
Expected: compile FAIL — `unknown field LaunchPrompt` / `launchRaw`.

- [ ] **Step 4: Implement resumeKong changes**

In `internal/verbs/dispatch.go`, replace the `resumeKong` struct (~line 283):

```go
// resumeKong is the kong-native form of resume.
// launch/launchRaw are injected at registration time; kong:"-" keeps kong
// from treating them as flags.
type resumeKong struct {
	ID           string `arg:"" name:"id" optional:"" help:"Initiative ID to resume."`
	LaunchPrompt string `name:"launch-prompt" help:"Custom launch prompt for the session (default: /dri <id>)."`
	Model        string `name:"model" help:"Model for a --launch-prompt session (default: opus). Requires --launch-prompt."`

	launch    launchFunc    `kong:"-"`
	launchRaw rawLaunchFunc `kong:"-"`
}
```

Extend `Validate`:

```go
// Validate checks that the required ID arg is non-empty.
func (c *resumeKong) Validate() error {
	if c.ID == "" {
		return cli.Usagef("ateam resume: <id> is required")
	}
	if c.Model != "" && c.LaunchPrompt == "" {
		return cli.Usagef("ateam resume: --model requires --launch-prompt")
	}
	return nil
}
```

In `resumeKong.Run`, replace the launch call (~line 325):

```go
	var launchErr error
	if c.LaunchPrompt != "" {
		launchErr = c.launchRaw(ctx, dir, c.LaunchPrompt, c.Model, "")
	} else {
		launchErr = c.launch(ctx, dir, c.ID)
	}
	if launchErr != nil {
		return launchErr
	}
```

Update the registration (~line 28):

```go
	p.AddVerb("resume", "Re-launch a background DRI session for an existing initiative.", &resumeKong{
		launch:    launchBGSession,
		launchRaw: rawLaunchBGSession,
	})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/verbs/ -run 'TestResume' -v`
Expected: ALL PASS (including the pre-existing TestResume_* tests).

- [ ] **Step 6: Commit**

```bash
gofmt -l internal/verbs/ && go vet ./internal/verbs/
git add internal/verbs/dispatch.go internal/verbs/resume_test.go
git commit -m "feat(resume): optional --launch-prompt/--model for non-DRI session resume"
```

---

### Task 2: thread the resume prompt through `ateam mail send`

**Files:**
- Modify: `internal/verbs/messaging.go` (sendKong ~22-33, Run ~104-111, `resumeInitiativeFunc` ~220, `defaultResume` ~276-279)
- Test: `internal/verbs/messaging_test.go` (update ~7 fake `resumeFunc` signatures + one new test)

**Interfaces:**
- Consumes: Task 1's `resumeKong{LaunchPrompt, Model, launchRaw}`.
- Produces: `sendKong` flags `--resume-launch-prompt` / `--resume-model`; new signature `resumeInitiativeFunc = func(ctx *cli.Context, id, launchPrompt, model string) error`. Task 3's route branch passes these flags via the runner.

- [ ] **Step 1: Write the failing test**

Append to `internal/verbs/messaging_test.go` (mirrors `TestSendKong_NoMatchingSession_EscalatesToResume` at line 679, using the `sendFixture` helper):

```go
func TestSendKong_ResumeEscalation_ThreadsLaunchPromptAndModel(t *testing.T) {
	sf := newSendFixture(t)

	var gotID, gotPrompt, gotModel string
	cmd := &sendKong{
		RecipientID:        "at-kong-dead",
		File:               sf.file,
		ResumeLaunchPrompt: "/agent-teams:review-pr at-kong-dead",
		ResumeModel:        "sonnet",
		agentsFunc:         func() ([]agentSession, error) { return []agentSession{}, nil },
		resumeFunc: func(_ *cli.Context, id, prompt, model string) error {
			gotID, gotPrompt, gotModel = id, prompt, model
			return nil
		},
		sleeper:        func(time.Duration) { t.Fatal("sleeper should not be called when no session matches") },
		doorbellExists: func(string) bool { return true },
		respawnFunc:    func(string) error { t.Fatal("respawn should not be called when no session matches"); return nil },
	}

	ctx, _, _ := makeCtx(sf.fakeBD("at-kong-dead", "at-kong-msg9"), sf.home)
	if err := cmd.Run(ctx); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotID != "at-kong-dead" {
		t.Errorf("resume id = %q", gotID)
	}
	if gotPrompt != "/agent-teams:review-pr at-kong-dead" {
		t.Errorf("resume launchPrompt = %q", gotPrompt)
	}
	if gotModel != "sonnet" {
		t.Errorf("resume model = %q, want sonnet", gotModel)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/verbs/ -run TestSendKong_ResumeEscalation_Threads -v`
Expected: compile FAIL — `unknown field ResumeLaunchPrompt` and signature mismatch.

- [ ] **Step 3: Implement the threading**

In `internal/verbs/messaging.go`:

Add fields to `sendKong` (after `Thread`, ~line 26):

```go
	ResumeLaunchPrompt string `name:"resume-launch-prompt" help:"Launch prompt used if the recipient session is gone and must be resumed (default: /dri <id>)."`
	ResumeModel        string `name:"resume-model" help:"Model for a resumed session (only meaningful with --resume-launch-prompt)."`
```

Change the escalation call (~line 107):

```go
		if err := c.resumeFunc(ctx, c.RecipientID, c.ResumeLaunchPrompt, c.ResumeModel); err != nil {
			return fmt.Errorf("ateam send: resume escalation: %w", err)
		}
```

Change the func type (~line 220):

```go
// resumeInitiativeFunc is the function type for escalating to ateam resume.
// launchPrompt/model are threaded through to resumeKong ("" = default /dri).
// Injected so tests can substitute a fake.
type resumeInitiativeFunc func(ctx *cli.Context, id, launchPrompt, model string) error
```

Change `defaultResume` (~line 276):

```go
// defaultResume runs `ateam resume <id>` via the resumeKong directly.
func defaultResume(ctx *cli.Context, id, launchPrompt, model string) error {
	cmd := &resumeKong{ID: id, LaunchPrompt: launchPrompt, Model: model, launch: launchBGSession, launchRaw: rawLaunchBGSession}
	return cmd.Run(ctx)
}
```

- [ ] **Step 4: Fix the compiler-flagged fake signatures**

Run: `go build ./...`
Every `resumeFunc:` fake in `messaging_test.go` (lines ~619, 658, 687, 715, 745, 773, 799) fails to compile. Update each old fake from `func(_ *cli.Context, _ string) error` to `func(_ *cli.Context, _, _, _ string) error` (and the line-687 one to `func(_ *cli.Context, id, _, _ string) error`), preserving each body unchanged. Repeat `go build ./...` until clean.

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/verbs/ -run TestSendKong -v`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
gofmt -l internal/verbs/ && go vet ./internal/verbs/
git add internal/verbs/messaging.go internal/verbs/messaging_test.go
git commit -m "feat(mail send): thread --resume-launch-prompt/--resume-model to dead-session resume"
```

---

### Task 3: `re_review` transition — reopen + send, spawn fallback

**Files:**
- Modify: `internal/verbs/route_types.go` (const block, lines 13-22)
- Modify: `internal/verbs/route.go` (enum tag line 23, `Run` lines 58-75, new helpers)
- Modify: `internal/verbs/route_match.go` (new closed-initiative matcher)
- Test: `internal/verbs/route_test.go`, `internal/verbs/route_match_test.go`

**Interfaces:**
- Consumes: Task 2's `mail send --resume-launch-prompt/--resume-model` flags (passed as runner args); existing `matchInitiative`, `spawnReviewInitiative`, `extractPrURL`, `parsePrURL`, `worktreePath`, `ateamRunner`.
- Produces: `TransitionReReview PRTransition = "re_review"`; `matchClosedReviewInitiative(ctx, event) (MatchResult, error)` and pure core `matchClosedFromIssues(issues, event) MatchResult`; `(c *routePREventKong) sendArgs(id string) []string`; `(c *routePREventKong) routeReReview(ctx, event) error`. pr-shepherd (Task 6) sends `--transition re_review`.

- [ ] **Step 1: Write the failing matcher tests**

Append to `internal/verbs/route_match_test.go`:

```go
// ── matchClosedFromIssues ─────────────────────────────────────────────────────

func TestMatchClosed_PicksMostRecentlyCreated(t *testing.T) {
	older := prFieldIssue("at-old.1", "owner/myrepo", 42)
	older.Status = "closed"
	older.CreatedAt = "2026-07-01T00:00:00Z"
	newer := prFieldIssue("at-new.1", "owner/myrepo", 42)
	newer.Status = "closed"
	newer.CreatedAt = "2026-07-10T00:00:00Z"

	got := matchClosedFromIssues([]bd.Issue{older, newer}, PREvent{Repo: "owner/myrepo", PRNumber: 42})
	if got.How != MatchPRField {
		t.Fatalf("How = %v, want MatchPRField", got.How)
	}
	if got.InitiativeID != "at-new.1" {
		t.Errorf("InitiativeID = %q, want at-new.1 (most recent)", got.InitiativeID)
	}
	if got.Worktree != "/tmp/wt-at-new.1" {
		t.Errorf("Worktree = %q", got.Worktree)
	}
}

func TestMatchClosed_NoMatchReturnsMatchNone(t *testing.T) {
	other := prFieldIssue("at-other.1", "owner/otherrepo", 7)
	other.Status = "closed"

	got := matchClosedFromIssues([]bd.Issue{other}, PREvent{Repo: "owner/myrepo", PRNumber: 42})
	if got.How != MatchNone {
		t.Errorf("How = %v, want MatchNone", got.How)
	}
}

func TestMatchClosed_IgnoresBranchOnlyIssues(t *testing.T) {
	branchOnly := branchIssue("at-br.1", "myrepo", "feat-x")
	branchOnly.Status = "closed"

	got := matchClosedFromIssues([]bd.Issue{branchOnly}, PREvent{Repo: "owner/myrepo", PRNumber: 42})
	if got.How != MatchNone {
		t.Errorf("How = %v, want MatchNone — closed matching is pr-field only", got.How)
	}
}
```

- [ ] **Step 2: Write the failing route tests**

Append to `internal/verbs/route_test.go`:

```go
// ── re_review transition ──────────────────────────────────────────────────────

// statusFakeBD serves different issue lists for --status=open vs --status=closed.
type statusFakeBD struct {
	open, closed []bd.Issue
}

func (f *statusFakeBD) Run(args ...string) (string, error) { return "", nil }

func (f *statusFakeBD) RunJSON(dst any, args ...string) error {
	out, ok := dst.(*[]bd.Issue)
	if !ok || len(args) == 0 || args[0] != "list" {
		return nil
	}
	for _, a := range args {
		if a == "--status=closed" {
			*out = f.closed
			return nil
		}
	}
	*out = f.open
	return nil
}

// failRunner records calls like fakeRunner but fails any call whose first arg
// equals failOn.
type failRunner struct {
	calls  [][]string
	failOn string
}

func (f *failRunner) run(args ...string) error {
	f.calls = append(f.calls, append([]string(nil), args...))
	if len(args) > 0 && args[0] == f.failOn {
		return fmt.Errorf("injected %s failure", f.failOn)
	}
	return nil
}

func makeStatusCtx(open, closed []bd.Issue) (*cli.Context, *bytes.Buffer, *bytes.Buffer) {
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	return &cli.Context{
		Home:   "/fake/home",
		BD:     &statusFakeBD{open: open, closed: closed},
		Stdout: stdout,
		Stderr: stderr,
	}, stdout, stderr
}

func TestReReview_OpenMatch_SendsWithResumeFlags(t *testing.T) {
	bodyFile := writeTempFile(t, "re-review body")
	issue := prFieldIssue("at-rr.1", "owner/myrepo", 42)
	ctx, _, _ := makeStatusCtx([]bd.Issue{issue}, nil)

	runner := &fakeRunner{}
	cmd := &routePREventKong{
		Repo: "owner/myrepo", PRNumber: 42, HeadBranch: "feat-x",
		Transition: TransitionReReview, BodyFile: bodyFile,
		runner: runner.run,
	}
	if err := cmd.Run(ctx); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(runner.calls) != 1 {
		t.Fatalf("calls = %d, want 1 (send only)", len(runner.calls))
	}
	want := []string{"mail", "send", "at-rr.1", "--file", bodyFile, "--sender", "pr-shepherd",
		"--resume-launch-prompt", "/agent-teams:review-pr at-rr.1", "--resume-model", "sonnet"}
	if strings.Join(runner.calls[0], " ") != strings.Join(want, " ") {
		t.Errorf("send args = %v\nwant %v", runner.calls[0], want)
	}
}

func TestReReview_ClosedMatch_ReopensThenSends(t *testing.T) {
	bodyFile := writeTempFile(t, "re-review body")
	closed := prFieldIssue("at-rr.2", "owner/myrepo", 42)
	closed.Status = "closed"
	ctx, stdout, _ := makeStatusCtx(nil, []bd.Issue{closed})

	runner := &fakeRunner{}
	cmd := &routePREventKong{
		Repo: "owner/myrepo", PRNumber: 42, HeadBranch: "feat-x",
		Transition: TransitionReReview, BodyFile: bodyFile,
		runner: runner.run,
	}
	if err := cmd.Run(ctx); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(runner.calls) != 2 {
		t.Fatalf("calls = %d, want 2 (reopen, send): %v", len(runner.calls), runner.calls)
	}
	if strings.Join(runner.calls[0], " ") != "reopen at-rr.2" {
		t.Errorf("first call = %v, want reopen at-rr.2", runner.calls[0])
	}
	if runner.calls[1][0] != "mail" || runner.calls[1][1] != "send" || runner.calls[1][2] != "at-rr.2" {
		t.Errorf("second call = %v, want mail send at-rr.2 ...", runner.calls[1])
	}
	if !strings.Contains(stdout.String(), "reopening") {
		t.Errorf("stdout missing reopen notice: %s", stdout.String())
	}
}

func TestReReview_NoInitiative_FallsBackToSpawn(t *testing.T) {
	bodyFile := writeTempFile(t, "re-review body")
	ctx, stdout, _, tmpHome := makeRouteCtxWithHome(t, nil)
	// Point ctx.BD at a status-aware fake with no issues at all.
	ctx.BD = &statusFakeBD{}
	// Configure the review-repos mapping so spawn proceeds.
	repoDir := filepath.Join(tmpHome, "review-repos")
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, "myrepo"), []byte("/local/clone/myrepo\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	runner := &fakeRunner{}
	cmd := &routePREventKong{
		Repo: "owner/myrepo", PRNumber: 42, HeadBranch: "feat-x",
		Transition: TransitionReReview, BodyFile: bodyFile,
		runner: runner.run,
	}
	if err := cmd.Run(ctx); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(runner.calls) != 1 || runner.calls[0][0] != "dispatch" {
		t.Fatalf("calls = %v, want a single dispatch call", runner.calls)
	}
	if !strings.Contains(stdout.String(), "no prior initiative") {
		t.Errorf("stdout missing spawn-fallback notice: %s", stdout.String())
	}
}

func TestReReview_ReopenFails_FallsBackToSpawn(t *testing.T) {
	bodyFile := writeTempFile(t, "re-review body")
	closed := prFieldIssue("at-rr.3", "owner/myrepo", 42)
	closed.Status = "closed"
	ctx, stdout, _, tmpHome := makeRouteCtxWithHome(t, nil)
	ctx.BD = &statusFakeBD{closed: []bd.Issue{closed}}
	repoDir := filepath.Join(tmpHome, "review-repos")
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, "myrepo"), []byte("/local/clone/myrepo\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	runner := &failRunner{failOn: "reopen"}
	cmd := &routePREventKong{
		Repo: "owner/myrepo", PRNumber: 42, HeadBranch: "feat-x",
		Transition: TransitionReReview, BodyFile: bodyFile,
		runner: runner.run,
	}
	if err := cmd.Run(ctx); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// reopen (failed), then dispatch fallback — no send.
	if len(runner.calls) != 2 || runner.calls[0][0] != "reopen" || runner.calls[1][0] != "dispatch" {
		t.Fatalf("calls = %v, want [reopen, dispatch]", runner.calls)
	}
	if !strings.Contains(stdout.String(), "reopen at-rr.3 failed") {
		t.Errorf("stdout missing reopen-failure notice: %s", stdout.String())
	}
}

func TestReReview_OtherTransitionSendHasNoResumeFlags(t *testing.T) {
	bodyFile := writeTempFile(t, "ci failed body")
	issue := prFieldIssue("at-ci.1", "owner/myrepo", 42)
	ctx, _, _ := makeStatusCtx([]bd.Issue{issue}, nil)

	runner := &fakeRunner{}
	cmd := &routePREventKong{
		Repo: "owner/myrepo", PRNumber: 42, HeadBranch: "feat-x",
		Transition: TransitionCIFailed, BodyFile: bodyFile,
		runner: runner.run,
	}
	if err := cmd.Run(ctx); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, arg := range runner.calls[0] {
		if arg == "--resume-launch-prompt" {
			t.Errorf("non-re_review send must not carry --resume-launch-prompt: %v", runner.calls[0])
		}
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./internal/verbs/ -run 'TestMatchClosed|TestReReview' -v`
Expected: compile FAIL — `undefined: TransitionReReview`, `matchClosedFromIssues`.

- [ ] **Step 4: Implement the transition constant and enum**

`internal/verbs/route_types.go` — add to the const block (after `TransitionStale`):

```go
	TransitionReReview         PRTransition = "re_review"
```

`internal/verbs/route.go` line 23 — extend the enum tag:

```go
	Transition PRTransition `name:"transition"  help:"PR event transition."                 required:"" enum:"ci_failed,changes_requested,review_requested,bot_findings,approved,merged,stale,re_review,other"`
```

- [ ] **Step 5: Implement the closed-initiative matcher**

Append to `internal/verbs/route_match.go`:

```go
// matchClosedReviewInitiative finds the most recently created CLOSED
// initiative whose pr: URL matches the event — the reopen target for a
// re_review. Branch matching is deliberately not used here: closed
// initiatives accumulate and repo+branch pairs recur across them, so only
// the exact pr: URL is trustworthy.
func matchClosedReviewInitiative(ctx *cli.Context, event PREvent) (MatchResult, error) {
	var issues []bd.Issue
	if err := ctx.BD.RunJSON(&issues, "list", "--status=closed", "--json"); err != nil {
		return MatchResult{}, fmt.Errorf("matchClosedReviewInitiative: list closed initiatives: %w", err)
	}
	return matchClosedFromIssues(issues, event), nil
}

// matchClosedFromIssues is the pure core of matchClosedReviewInitiative.
// Multiple matches resolve to the most recently created (RFC3339 CreatedAt
// compares lexicographically) rather than erroring — old review initiatives
// for the same PR are expected.
func matchClosedFromIssues(issues []bd.Issue, event PREvent) MatchResult {
	eventOwnerRepo := strings.ToLower(event.Repo)
	var best *bd.Issue
	for i := range issues {
		prURL := extractPrURL(issues[i].Notes)
		if prURL == "" {
			prURL = extractPrURL(issues[i].Description)
		}
		if prURL == "" {
			continue
		}
		ownerRepo, prNumber, ok := parsePrURL(prURL)
		if !ok || ownerRepo != eventOwnerRepo || prNumber != event.PRNumber {
			continue
		}
		if best == nil || issues[i].CreatedAt > best.CreatedAt {
			best = &issues[i]
		}
	}
	if best == nil {
		return MatchResult{How: MatchNone}
	}
	return MatchResult{InitiativeID: best.ID, Worktree: worktreePath(best.Description), How: MatchPRField}
}
```

- [ ] **Step 6: Implement the route branch**

In `internal/verbs/route.go`, replace the `switch` in `Run` (lines 58-74):

```go
	switch {
	case result.How == MatchPRField || result.How == MatchBranch:
		fmt.Fprintf(ctx.Stdout, "route-pr-event: matched %s (%s) for %s#%d — routing via mail send\n",
			result.InitiativeID, matchHowLabel(result.How), c.Repo, c.PRNumber)
		if err := c.runner(c.sendArgs(result.InitiativeID)...); err != nil {
			return fmt.Errorf("ateam route-pr-event: send: %w", err)
		}
		return nil

	case c.Transition == TransitionReviewRequested:
		return c.spawnReviewInitiative(ctx, event)

	case c.Transition == TransitionReReview:
		return c.routeReReview(ctx, event)

	default:
		fmt.Fprintf(ctx.Stdout, "route-pr-event: unowned %s for %s#%d — no owning initiative; skipping\n",
			c.Transition, c.Repo, c.PRNumber)
		return nil
	}
```

Add the two helpers (after `Run`, before `RegisterRouteEventKong`):

```go
// sendArgs builds the mail-send argv for routing the event body to id. A
// re_review send threads the reviewer launch prompt so a dead session is
// resumed as a reviewer on sonnet (matching the spawn path), never a DRI.
func (c *routePREventKong) sendArgs(id string) []string {
	args := []string{"mail", "send", id, "--file", c.BodyFile, "--sender", "pr-shepherd"}
	if c.Transition == TransitionReReview {
		args = append(args,
			"--resume-launch-prompt", "/agent-teams:review-pr "+id,
			"--resume-model", "sonnet")
	}
	return args
}

// routeReReview handles transition=re_review when no open initiative owns
// the PR: reopen the closed review initiative and mail it the re-review
// request. A fresh spawn is the fallback at every step — no prior
// initiative, reopen failure, or send failure (e.g. deleted worktree) all
// degrade to a new review initiative rather than dropping the event.
func (c *routePREventKong) routeReReview(ctx *cli.Context, event PREvent) error {
	result, err := matchClosedReviewInitiative(ctx, event)
	if err != nil {
		return fmt.Errorf("ateam route-pr-event: re-review match: %w", err)
	}
	if result.How == MatchNone {
		fmt.Fprintf(ctx.Stdout, "route-pr-event: re_review for %s#%d has no prior initiative — spawning fresh review\n",
			event.Repo, event.PRNumber)
		return c.spawnReviewInitiative(ctx, event)
	}
	fmt.Fprintf(ctx.Stdout, "route-pr-event: re_review matched closed %s for %s#%d — reopening\n",
		result.InitiativeID, event.Repo, event.PRNumber)
	if err := c.runner("reopen", result.InitiativeID); err != nil {
		fmt.Fprintf(ctx.Stdout, "route-pr-event: reopen %s failed (%v) — spawning fresh review\n",
			result.InitiativeID, err)
		return c.spawnReviewInitiative(ctx, event)
	}
	if err := c.runner(c.sendArgs(result.InitiativeID)...); err != nil {
		fmt.Fprintf(ctx.Stdout, "route-pr-event: send to %s failed (%v) — spawning fresh review\n",
			result.InitiativeID, err)
		return c.spawnReviewInitiative(ctx, event)
	}
	return nil
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `go test ./internal/verbs/ -run 'TestMatchClosed|TestReReview|TestDecisionMatrix|TestRoutePREvent' -v`
Expected: ALL PASS (existing decision-matrix tests must stay green — `sendArgs` appends nothing for non-re_review transitions).

- [ ] **Step 8: Commit**

```bash
gofmt -l internal/verbs/ && go vet ./internal/verbs/
git add internal/verbs/route.go internal/verbs/route_types.go internal/verbs/route_match.go internal/verbs/route_test.go internal/verbs/route_match_test.go
git commit -m "feat(route-pr-event): re_review transition — reopen closed review initiative, spawn fallback"
```

---

### Task 4: review-pr skill re-review mode

**Files:**
- Modify: `plugins/agent-teams/skills/review-pr/skill.md`

**Interfaces:**
- Consumes: nothing new — self-detects via `gh pr view --json reviews`.
- Produces: re-review behavior for any session launched with `/agent-teams:review-pr <id>` (spawned fresh, resumed via Task 1's `--launch-prompt`, or a live session reading Task 7's mail).

- [ ] **Step 1: Insert the detection step and renumber**

After the `### 3. Determine authorship` section, insert:

```markdown
### 4. Detect re-review

Check whether the current identity has already reviewed this PR:

```bash
gh pr view <pr-number> --repo <owner>/<repo> --json reviews \
  -q '[.reviews[] | select(.author.login == "<our-login>")] | length'
```

(`<our-login>` is the `gh api user -q .login` result from step 3. If that
lookup failed, treat this as a first review.)

- **0** → first review. Proceed with the normal flow.
- **1+** → **re-review mode.** The author has addressed our prior findings and
  review was re-requested. Fetch the prior findings:

```bash
gh api repos/<owner>/<repo>/pulls/<pr-number>/reviews    # review bodies
gh api repos/<owner>/<repo>/pulls/<pr-number>/comments   # inline review comments
```

Collect every finding from our most recent review (its body plus the inline
comments authored by `<our-login>`), each as file:line + description.
Re-review mode replaces the reviewer instructions in step 7 (see the
re-review variant there) and changes the no-findings wording in step 9.
Checkout, diff, posting mechanics, and close are unchanged.
```

Renumber the subsequent section headings: `4. Checkout the PR code` → `### 5.`, `5. Get the diff` → `### 6.`, `6. Spawn the reviewer subagent` → `### 7.`, `7. Collect findings` → `### 8.`, `8. Post the review to GitHub` → `### 9.`, `9. Update the initiative` → `### 10.`, `10. Close the initiative` → `### 11.`.

- [ ] **Step 2: Fix cross-references broken by renumbering**

Update these in-text references (grep the file for `step` to catch all):
- In old step 3: "Approve gate (step 8)" → "(step 9)"; "Design-commentary phrasing (step 6)" → "(step 7)".
- In old step 4 (now 5): "proceed with the diff-only approach in step 5" → "in step 6".
- In old step 6 (now 7): "The full diff captured in step 5" → "in step 6"; "the phrasing determination from step 3" stays.
- In old step 7 (now 8): "proceed to step 9 (update + close)" → "step 10".
- In old step 8 (now 9): "the event depends on step 3's self-review determination" stays.

- [ ] **Step 3: Add the re-review variant to the reviewer-spawn step (now step 7)**

Append at the end of the `### 7. Spawn the reviewer subagent` section:

```markdown
**Re-review mode (step 4 detected a prior review):** replace the review
instructions above with:

- Here are the findings from our previous review of this PR: <the collected
  prior findings, each with file:line and description>
- Verify each prior finding against the current diff: addressed (fixed, or
  reasonably answered by the author) or not addressed. Do NOT raise new
  findings — this is a scoped re-review of previously raised items only.
- Report back via SendMessage one line per prior finding: `addressed` /
  `not addressed`, with a one-sentence reason each.
```

- [ ] **Step 4: Add the re-review posting rules to the posting step (now step 9)**

Append at the end of the `### 9. Post the review to GitHub` section:

```markdown
**Re-review mode:** findings reported `not addressed` are the substantive
findings — post them (inline where the line is in the diff, body otherwise)
with event=`COMMENT` and a body like "Re-review: N of M prior findings
addressed." If ALL prior findings are addressed, this is the no-findings
case above (APPROVE unless self-review) with body "Re-review: all M prior
findings addressed."
```

- [ ] **Step 5: Update the frontmatter description**

Change the `description:` line to:

```yaml
description: "Lightweight PR review using agent-teams reviewer subagents. Use when invoked as /agent-teams:review-pr <initiative-id>, or when a background session is launched by route-pr-event for a review_requested or re_review event. Self-detects re-reviews (prior review by this identity) and scopes them to previously raised findings."
```

- [ ] **Step 6: Verify and commit**

Read the full edited file top to bottom checking heading numbers are sequential 1–11 and every `step N` reference points at the right section.

```bash
git add plugins/agent-teams/skills/review-pr/skill.md
git commit -m "feat(review-pr): self-detecting re-review mode — verify prior findings only"
```

---

### Task 5: agent-teams release protocol + session close

**Files:**
- Modify: `plugins/agent-teams/bin/` (rebuilt binaries), `.claude-plugin/marketplace.json`, `plugins/agent-teams/.claude-plugin/plugin.json`

- [ ] **Step 1: Full gates**

```bash
cd /Users/ericlloyd/Code/agent-teams
go build ./... && go vet ./... && go test ./...
gofmt -l internal/verbs/   # must print nothing
```

Expected: all green (tests/ateam.test.sh case10 is a known pre-existing failure; ignore per CLAUDE.md).

- [ ] **Step 2: Rebuild binaries and bump version**

```bash
sh scripts/build-binaries.sh
```

Bump the patch version identically in `.claude-plugin/marketplace.json` and `plugins/agent-teams/.claude-plugin/plugin.json` (read current value first; keep them identical).

- [ ] **Step 3: Commit, close bd issue, push branch**

```bash
git add plugins/agent-teams/bin/ .claude-plugin/marketplace.json plugins/agent-teams/.claude-plugin/plugin.json
git commit -m "chore(release): rebuild ateam binaries + version bump for re_review routing"
bd close <task-1-issue-id> --reason "re_review routing implemented on branch re-review-routing"
git push -u origin re-review-routing
```

**STOP — do not merge to main.** Eric reviews and merges; pr-shepherd (Tasks 6-8) can be implemented in parallel but must not be *deployed* until the new `ateam` is installed.

---

## Part 2 — pr-shepherd (`/Users/ericlloyd/Code/pr-shepherd-fork`, branch `re-review-on-re-request`)

### Task 6: explicit transition option on `routeToAgent`

**Files:**
- Modify: `src/ateam-conductor.ts:51-64`
- Test: `test/ateam-conductor.test.ts`

**Interfaces:**
- Produces: `routeToAgent(config, message, opts?: { reviewRequest?: boolean; transition?: string })` — `opts.transition` wins over the boolean. Task 7 calls it with `{ transition: "re_review" }`.

- [ ] **Step 1: Write the failing test**

Add inside the `describe("transition flag", ...)` block of `test/ateam-conductor.test.ts`:

```ts
    it("passes an explicit transition when opts.transition is set", () => {
      const msg = "[PR Shepherd] Re-review requested: PR #10 (org/repo)";

      routeToAgent(makeConfig(), msg, { transition: "re_review" });

      const [, args] = mockedExec.mock.calls[1] as [string, string[]];
      expect(args[args.indexOf("--transition") + 1]).toBe("re_review");
    });

    it("explicit transition wins over reviewRequest boolean", () => {
      const msg = "[PR Shepherd] Re-review requested: PR #10 (org/repo)";

      routeToAgent(makeConfig(), msg, { reviewRequest: true, transition: "re_review" });

      const [, args] = mockedExec.mock.calls[1] as [string, string[]];
      expect(args[args.indexOf("--transition") + 1]).toBe("re_review");
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/ericlloyd/Code/pr-shepherd-fork && npx vitest run test/ateam-conductor.test.ts`
Expected: 2 FAIL — transition is `"other"`.

- [ ] **Step 3: Implement**

In `src/ateam-conductor.ts`, change the signature (line 51-55) and transition derivation (line 64):

```ts
export function routeToAgent(
  config: ShepherdConfig,
  message: string,
  opts?: { reviewRequest?: boolean; transition?: string },
): void {
```

```ts
  const transition = opts?.transition ?? (opts?.reviewRequest ? "review_requested" : "other");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/ateam-conductor.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ateam-conductor.ts test/ateam-conductor.test.ts
git commit -m "feat(conductor): explicit transition option on routeToAgent"
```

---

### Task 7: review-inbox re-request detection and lifecycle

**Files:**
- Modify: `src/types.ts:89-105`
- Modify: `src/review-inbox.ts` (discovery loop 131-167, processing loop 169-276, prune 278-284, new helper + formatter)
- Test: `test/review-inbox.test.ts`

**Interfaces:**
- Consumes: Task 6's `routeToAgent(config, msg, { transition: "re_review" })`.
- Produces: `ReviewAssignmentStatus` gains `"re_review_dispatched"`; `ReviewAssignment` gains `reReviewDispatchedAt?: string | null`; exported `latestUserReviewAt(number, repo, githubUser): string | null` and `formatReReviewMessage(assignment): string`.

**Status cycle:** `review_submitted` —(PR reappears in review-requested search)→ `re_review_dispatched` (`reReviewDispatchedAt: null` = pending dispatch, timestamp = dispatched) —(our newer review posts)→ `review_submitted`. Repeatable. Note the spec's completion condition was "PR leaves the search AND newer review" — the newer review is what removes us from the search, so the newer-review check alone is equivalent and is what we implement.

- [ ] **Step 1: Add the types**

In `src/types.ts`, extend the status union (line 89-94):

```ts
export type ReviewAssignmentStatus =
  | "pending_bot_review"
  | "dispatched"
  | "re_review_dispatched"
  | "review_submitted"
  | "merged_before_review"
  | "closed";
```

Add the field to `ReviewAssignment` (after `completedAt`, line 103):

```ts
  reReviewDispatchedAt?: string | null;
```

- [ ] **Step 2: Write the failing tests**

Append to `test/review-inbox.test.ts` (inside the file, after the existing dry-run describe; reuses `makePollConfig`, `mockedExec`, `mockedRoute`). Import `latestUserReviewAt` by adding it to the imports from `../src/review-inbox.js`.

```ts
describe("re-review on re-request", () => {
  const TMP_RR = join(import.meta.dirname, "__tmp_review_inbox_rereview");

  const searchResult = JSON.stringify([
    {
      number: 42,
      repository: { name: "widgets", nameWithOwner: "acme/widgets" },
      title: "feat: add widget sorting",
      url: "https://github.com/acme/widgets/pull/42",
      isDraft: false,
      updatedAt: new Date().toISOString(),
    },
  ]);

  beforeEach(() => {
    mkdirSync(TMP_RR, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(TMP_RR, { recursive: true, force: true });
  });

  it("flips review_submitted to re_review_dispatched and dispatches with transition re_review", async () => {
    writeInbox(TMP_RR, [
      makeAssignment({ status: "review_submitted", completedAt: "2026-07-01T00:00:00Z" }),
    ]);
    mockedExec
      .mockReturnValueOnce(searchResult as unknown as ReturnType<typeof execFileSync>) // fetchReviewRequests
      .mockReturnValueOnce(JSON.stringify({ state: "OPEN" }) as unknown as ReturnType<typeof execFileSync>); // getPRState

    await pollReviewInbox(makePollConfig({ dataDir: TMP_RR, dryRun: false }));

    expect(mockedRoute).toHaveBeenCalledTimes(1);
    const [, msg, opts] = mockedRoute.mock.calls[0];
    expect(msg).toContain("Re-review requested");
    expect(msg).toContain("https://github.com/acme/widgets/pull/42");
    expect(opts).toEqual({ transition: "re_review" });

    const persisted = readInbox(TMP_RR);
    expect(persisted[0].status).toBe("re_review_dispatched");
    expect(persisted[0].reReviewDispatchedAt).toBeTruthy();
  });

  it("does not re-dispatch while a re-review is pending", async () => {
    writeInbox(TMP_RR, [
      makeAssignment({
        status: "re_review_dispatched",
        reReviewDispatchedAt: "2026-07-14T00:00:00Z",
      }),
    ]);
    mockedExec
      .mockReturnValueOnce(searchResult as unknown as ReturnType<typeof execFileSync>) // fetchReviewRequests
      .mockReturnValueOnce(JSON.stringify({ state: "OPEN" }) as unknown as ReturnType<typeof execFileSync>) // getPRState
      .mockReturnValueOnce(
        JSON.stringify({
          reviews: [{ author: { login: "testuser" }, state: "COMMENTED", submittedAt: "2026-07-10T00:00:00Z" }],
        }) as unknown as ReturnType<typeof execFileSync>, // latestUserReviewAt — older than dispatch
      );

    await pollReviewInbox(makePollConfig({ dataDir: TMP_RR, dryRun: false }));

    expect(mockedRoute).not.toHaveBeenCalled();
    expect(readInbox(TMP_RR)[0]?.status ?? "re_review_dispatched").toBe("re_review_dispatched");
  });

  it("completes the re-review when a newer review of ours exists", async () => {
    writeInbox(TMP_RR, [
      makeAssignment({
        status: "re_review_dispatched",
        reReviewDispatchedAt: "2026-07-14T00:00:00Z",
      }),
    ]);
    mockedExec
      .mockReturnValueOnce("[]" as unknown as ReturnType<typeof execFileSync>) // fetchReviewRequests — PR left the search
      .mockReturnValueOnce(JSON.stringify({ state: "OPEN" }) as unknown as ReturnType<typeof execFileSync>) // getPRState
      .mockReturnValueOnce(
        JSON.stringify({
          reviews: [
            { author: { login: "testuser" }, state: "COMMENTED", submittedAt: "2026-07-10T00:00:00Z" },
            { author: { login: "testuser" }, state: "COMMENTED", submittedAt: "2026-07-14T12:00:00Z" },
          ],
        }) as unknown as ReturnType<typeof execFileSync>, // latestUserReviewAt — newer
      );

    await pollReviewInbox(makePollConfig({ dataDir: TMP_RR, dryRun: false }));

    const persisted = readInbox(TMP_RR);
    expect(persisted[0].status).toBe("review_submitted");
    expect(persisted[0].completedAt).toBeTruthy();
  });

  it("creates a re_review_dispatched record when no inbox record exists but we already reviewed", async () => {
    mockedExec
      .mockReturnValueOnce(searchResult as unknown as ReturnType<typeof execFileSync>) // fetchReviewRequests
      .mockReturnValueOnce(
        JSON.stringify({
          reviews: [{ author: { login: "testuser" }, state: "COMMENTED" }],
        }) as unknown as ReturnType<typeof execFileSync>, // hasUserReviewed → true
      )
      .mockReturnValueOnce(JSON.stringify({ state: "OPEN" }) as unknown as ReturnType<typeof execFileSync>); // getPRState

    await pollReviewInbox(makePollConfig({ dataDir: TMP_RR, dryRun: false }));

    expect(mockedRoute).toHaveBeenCalledTimes(1);
    const persisted = readInbox(TMP_RR);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].status).toBe("re_review_dispatched");
    expect(persisted[0].reReviewDispatchedAt).toBeTruthy();
  });

  it("notifies to free the worker when the PR merges during a re-review", async () => {
    writeInbox(TMP_RR, [
      makeAssignment({
        status: "re_review_dispatched",
        reReviewDispatchedAt: "2026-07-14T00:00:00Z",
      }),
    ]);
    mockedExec
      .mockReturnValueOnce("[]" as unknown as ReturnType<typeof execFileSync>) // fetchReviewRequests
      .mockReturnValueOnce(JSON.stringify({ state: "MERGED" }) as unknown as ReturnType<typeof execFileSync>); // getPRState

    // notifyAgent short-circuits without a configured agent — set one so the
    // free-worker message reaches routeToAgent.
    const config = makePollConfig({ dataDir: TMP_RR, dryRun: false });
    config.reviewInbox.notifyAgent = "conductor";
    await pollReviewInbox(config);

    // notifyAgent → sendToAgent → routeToAgent (mocked)
    expect(mockedRoute).toHaveBeenCalledTimes(1);
    expect(mockedRoute.mock.calls[0][1]).toContain("no longer needed");
    expect(readInbox(TMP_RR)[0].status).toBe("merged_before_review");
  });
});

describe("latestUserReviewAt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the newest submittedAt among our reviews", () => {
    mockedExec.mockReturnValueOnce(
      JSON.stringify({
        reviews: [
          { author: { login: "TestUser" }, submittedAt: "2026-07-10T00:00:00Z" },
          { author: { login: "someoneelse" }, submittedAt: "2026-07-15T00:00:00Z" },
          { author: { login: "testuser" }, submittedAt: "2026-07-12T00:00:00Z" },
        ],
      }) as unknown as ReturnType<typeof execFileSync>,
    );
    expect(latestUserReviewAt(42, "acme/widgets", "testuser")).toBe("2026-07-12T00:00:00Z");
  });

  it("returns null when we have no reviews or gh fails", () => {
    mockedExec.mockReturnValueOnce(JSON.stringify({ reviews: [] }) as unknown as ReturnType<typeof execFileSync>);
    expect(latestUserReviewAt(42, "acme/widgets", "testuser")).toBeNull();
    mockedExec.mockImplementationOnce(() => {
      throw new Error("gh failed");
    });
    expect(latestUserReviewAt(42, "acme/widgets", "testuser")).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/review-inbox.test.ts`
Expected: FAIL — `latestUserReviewAt` not exported; re-request flip not implemented.

- [ ] **Step 4: Implement `latestUserReviewAt` and `formatReReviewMessage`**

In `src/review-inbox.ts`, after `hasUserReviewed` (line 72):

```ts
export function latestUserReviewAt(number: number, repo: string, githubUser: string): string | null {
  try {
    const json = execFileSync(
      "gh",
      ["pr", "view", String(number), "-R", repo, "--json", "reviews"],
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();
    const { reviews } = JSON.parse(json) as {
      reviews: Array<{ author: { login: string }; submittedAt?: string }>;
    };
    const ours = reviews
      .filter((r) => r.author.login.toLowerCase() === githubUser.toLowerCase())
      .map((r) => r.submittedAt)
      .filter((t): t is string => Boolean(t))
      .sort();
    return ours.length > 0 ? ours[ours.length - 1] : null;
  } catch {
    return null;
  }
}
```

Next to `formatReviewAssignmentMessage` (line 313):

```ts
function formatReReviewMessage(assignment: ReviewAssignment): string {
  return [
    `[PR Shepherd] Re-review requested: PR #${assignment.number} (${assignment.repo})`,
    `"${assignment.title}"`,
    assignment.url,
    "",
    "You previously reviewed this PR. The author has addressed the findings and re-requested review.",
    "Verify each previously raised finding was addressed by the new commits and post a short follow-up review with the outcome per finding. Do not raise new findings.",
  ].join("\n");
}
```

Add `formatReReviewMessage` to the export statement at the bottom (line 323).

- [ ] **Step 5: Implement re-request detection in the discovery loop**

Replace the body of the discovery loop in `pollReviewInbox` (lines 131-167). The `existingKeys` Set (line 123) becomes a Map:

```ts
    const byKey = new Map(inbox.map((a) => [inboxKey(a.number, a.repo), a]));
```

(Delete the `existingKeys` line; update the later `existingKeys.add(key)` accordingly.)

```ts
    // Discover new assignments and re-requests
    for (const pr of results) {
      if (config.reviewInbox.ignoreDrafts && pr.isDraft) continue;
      if (config.reviewInbox.ignoreRepos.includes(pr.repository.nameWithOwner)) continue;
      if (new Date(pr.updatedAt).getTime() < cutoff) continue;

      const key = inboxKey(pr.number, pr.repository.nameWithOwner);
      const existing = byKey.get(key);

      if (existing) {
        // A PR we already reviewed reappearing in the review-requested search
        // means the author re-requested review — GitHub drops a reviewer from
        // requested_reviewers when their review posts and re-adds them on
        // re-request.
        if (existing.status === "review_submitted") {
          existing.status = "re_review_dispatched";
          existing.reReviewDispatchedAt = null;
          existing.completedAt = null;
          updated = true;
          log(`PR #${pr.number} (${pr.repository.nameWithOwner}) — review re-requested.`);
        }
        continue;
      }

      if (hasUserReviewed(pr.number, pr.repository.nameWithOwner, username)) {
        // Already reviewed but no inbox record (pruned, or reviewed before the
        // daemon existed) — same re-request signal.
        const assignment: ReviewAssignment = {
          number: pr.number,
          repo: pr.repository.nameWithOwner,
          title: pr.title,
          url: pr.url,
          detectedAt: new Date().toISOString(),
          notifiedAt: null,
          completedAt: null,
          reReviewDispatchedAt: null,
          status: "re_review_dispatched",
        };
        inbox.push(assignment);
        byKey.set(key, assignment);
        updated = true;
        log(`PR #${pr.number} (${pr.repository.nameWithOwner}) — review re-requested (no prior inbox record).`);
        continue;
      }

      const initialStatus: ReviewAssignmentStatus = waitForBot
        ? "pending_bot_review"
        : "dispatched";

      const assignment: ReviewAssignment = {
        number: pr.number,
        repo: pr.repository.nameWithOwner,
        title: pr.title,
        url: pr.url,
        detectedAt: new Date().toISOString(),
        notifiedAt: null,
        completedAt: null,
        reReviewDispatchedAt: null,
        status: initialStatus,
      };

      inbox.push(assignment);
      byKey.set(key, assignment);
      updated = true;

      if (initialStatus === "pending_bot_review") {
        log(`PR #${pr.number} (${pr.repository.nameWithOwner}) — waiting for ${waitForBot} to review first.`);
      }
    }
```

- [ ] **Step 6: Implement the processing-loop lifecycle**

Three edits inside the `for (const assignment of inbox)` loop:

(a) Include re-reviews in the merged/closed free-worker notification — change line 182:

```ts
          if (assignment.status === "dispatched" || assignment.status === "re_review_dispatched") {
```

(b) After the existing "Check if we've submitted our review" block (line 212-227), add:

```ts
        // Check if our re-review has been posted (a review newer than the
        // re-dispatch timestamp — posting it is also what removes us from the
        // review-requested search)
        if (assignment.status === "re_review_dispatched" && assignment.reReviewDispatchedAt) {
          const latest = latestUserReviewAt(assignment.number, assignment.repo, username);
          if (latest && new Date(latest).getTime() > new Date(assignment.reReviewDispatchedAt).getTime()) {
            const msg = [
              `[PR Shepherd] Re-review complete: PR #${assignment.number} (${assignment.repo})`,
              `"${assignment.title}"`,
              "",
              "Our follow-up review has been submitted. Please free the worker assigned to this review.",
            ].join("\n");
            log(`PR #${assignment.number} — re-review submitted. Notifying to free worker.`);
            if (!config.dryRun) {
              await notifyAgent(config, msg);
            }
            assignment.status = "review_submitted";
            assignment.completedAt = new Date().toISOString();
            updated = true;
            continue;
          }
        }
```

(c) After the existing dispatch block (line 248-272), add:

```ts
        // Dispatch re-review notifications
        if (assignment.status === "re_review_dispatched" && !assignment.reReviewDispatchedAt) {
          const msg = formatReReviewMessage(assignment);
          if (config.dryRun) {
            log(`[dry-run] would dispatch re-review of PR #${assignment.number} (${assignment.repo}) to ateam`);
          } else {
            routeToAgent(config, msg, { transition: "re_review" });
            assignment.reReviewDispatchedAt = new Date().toISOString();
            updated = true;
            log(`Re-review dispatched: PR #${assignment.number} (${assignment.repo})`);

            appendEvent(config.dataDir, {
              ts: assignment.reReviewDispatchedAt,
              pr: assignment.number,
              repo: assignment.repo,
              event: "review_requested",
              from: "OPENED",
              to: "OPENED",
              details: { type: "re_review_inbox", title: assignment.title, url: assignment.url },
            });
          }
        }
```

(d) Keep pending re-reviews out of the prune — change line 281:

```ts
      if (a.status === "pending_bot_review" || a.status === "dispatched" || a.status === "re_review_dispatched") return true;
```

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run && npm run typecheck`
Expected: ALL PASS, including all pre-existing tests (the first-review flow is untouched: an unreviewed new PR still takes the `dispatched`/`pending_bot_review` path).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/review-inbox.ts test/review-inbox.test.ts
git commit -m "feat(review-inbox): detect review re-requests and dispatch focused re-reviews"
```

---

### Task 8: docs + final gates

**Files:**
- Modify: `CLAUDE.md` (Review inbox section), `README.md` (if it describes the inbox lifecycle)

- [ ] **Step 1: Document the re-review lifecycle**

In `CLAUDE.md` under the "Review inbox" architecture section, after the "Review submitted" bullet, add:

```markdown
   - **Review re-requested** → a PR we already reviewed reappearing in the review-requested search (GitHub re-adds a reviewer on re-request) is dispatched as a focused re-review (`--transition re_review`): the agent verifies previously raised findings were addressed, no new findings. Completion is detected by a review of ours newer than the dispatch. Repeatable per PR.
```

Check `README.md` for an equivalent inbox lifecycle list and mirror the bullet there if present. Update the test count in CLAUDE.md's Tests section (`npm test` output tells you the new totals).

- [ ] **Step 2: Final gates and push**

```bash
npm test && npm run typecheck
git add CLAUDE.md README.md
git commit -m "docs: document re-review on re-request lifecycle"
git push -u origin re-review-on-re-request
```

- [ ] **Step 3: Deploy-order reminder in the handoff**

Report: pr-shepherd must not run against an `ateam` older than the Task 5 build — `route-pr-event --transition re_review` is a kong parse error there. Eric merges/installs agent-teams first.

---

## Manual E2E (after both deploys)

1. Have an agent review a test PR (COMMENT with findings), let the initiative close.
2. Address a finding, push, click "re-request review" on GitHub.
3. Within one poll: pr-shepherd logs "review re-requested", `ateam route-pr-event --transition re_review` fires, the closed initiative reopens, mail lands (or a reviewer — not DRI — session resumes), a short "Re-review: N/M prior findings addressed" review posts, the initiative closes, and the inbox record returns to `review_submitted`.
