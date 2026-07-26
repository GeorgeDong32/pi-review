# pi-review

Pi extension for fan-out code review: **N parallel reviewer subagents + a cheap-model gate** that aggregates their structured output into a final verdict.

Pattern ported from the Claude code-review plugin: eligibility → prep → parallel content reviewers → gate (confidence filter + verdict) → report. See [reference/](./reference/) for upstream flow notes and the version roadmap.

## Commands

```text
/review [user context ...] [--diff path | @file] [--threshold N] [--reviewer id ...] [--no-gate] [--gate-model id] [--score-per-issue off|blocker-major|all] [--no-spawn]
/review-config
/review-agents
```

### `/review`

**CC-aligned:** text after `/review` is **user context** (PR URL, PR number, natural-language focus) — not a filesystem path. It is passed to every reviewer/gate in a `### User request` section, like Claude `/code-review` arguments.

When called with no arguments, `/review` resolves a default diff source:

1. If the working tree is dirty (per `git status --porcelain`) → `git diff HEAD` of uncommitted changes.
2. If the working tree is clean → `git diff <default-branch>...HEAD` (default branch probed from `origin/HEAD` → `main` → `master` → current branch).
3. Outside a git repo with no PR/diff input → notify the user and exit.

**PR review:** pass a GitHub PR URL or number — pi-review runs `gh pr diff` (requires `gh` in PATH, authenticated):

```text
/review https://github.com/org/repo/pull/17206
/review 17206
/review focus on backup restore — PR 17206
```

**Explicit diff file:** use `--diff` (not a bare positional path):

```text
/review --diff @./changes.patch
/review focus on auth --diff /tmp/pr.diff
```

Flags:

| Flag | Effect |
|---|---|
| `--threshold N` | Override the confidence floor (0-10, clamped). Issues with `confidence < N` are dropped by code-side gate enforce. Default **8**. |
| `--reviewer id` | Restrict the run to a specific reviewer. Repeatable. |
| `--no-gate` | Skip the gate step. Useful for fast iteration when you only want raw reviewer output. |
| `--gate-model id` | Override the gate's model for this run. |
| `--score-per-issue MODE` | `off` / `blocker-major` (default) / `all` — Claude-style parallel per-issue scorers after the gate LLM. |
| `--no-spawn` | Dry run — print the resolved reviewer list, gate model, threshold, and exit. |
| `--diff path` | Review an explicit diff file (`@./file.diff` supported). User text before/after flags is still passed as context. |

## Bundled reviewers (v0.2 default)

| ID | Purpose | Default | Tools |
|---|---|---|---|
| `claude-md-compliance` | Project rules (AGENTS.md / CLAUDE.md / .pi/) | enabled | read, grep, find, ls |
| `bugbot` | Obvious bugs in the diff only (Cursor-style discipline) | enabled | read, grep, find |
| `history-context` | Git blame / log context on touched files | enabled | read, bash |
| `security-review` | Security issues introduced by the diff | enabled | read, grep, find |
| `code-comments` | Inline comment / TODO guidance in changed files | enabled | read, grep, find, ls |
| `conventions` | De-facto style pass | **disabled** | read, grep, find, ls |

## Pipeline

```text
eligibility → prep (rule paths + diff summary) → 5 reviewers (parallel, cap 4)
  → gate LLM (full diff + re-score)
  → optional per-issue scorers (blocker/major by default)
  → code enforce (dedupe + threshold + verdict)
  → markdown report
```

Lighter than Claude's code-review plugin (which scores **every** issue with a dedicated Haiku), but keeps the same two-level idea: parallel find → independent confidence filter. The parent always re-applies threshold and verdict rules in code so LLM mistakes cannot approve leftover blockers.

The gate / scorers use `structured_output` via a child capture extension (`src/structured-output-capture.ts`).

## Configuration

Per-user config lives at:

```text
~/.pi/agent/extensions/pi-review/config.json
```

Run `/review-config` to open it in `$EDITOR`. The file is loaded, merged with the built-in defaults, and validated on every `/review` call. Unknown reviewer ids are added as new reviewers; known ids are patched in place.

```jsonc
{
  "schemaVersion": 1,
  "gate": {
    // "inherit" = use the parent session's model. Override to a specific id.
    "model": "inherit",
    "thinking": "low",
    "enabled": true,
    // Issues with confidence < threshold are dropped (code-enforced).
    "threshold": 8,
    // Parallel per-issue scorers: "off" | "blocker-major" | "all"
    "scorePerIssue": "blocker-major"
  },
  "concurrency": 4,            // hard cap = 4
  "reviewers": {
    "claude-md-compliance": {
      "model": "anthropic/claude-opus-4-6",
      "thinking": "high",
      "enabled": true
    },
    "bugbot": {
      "model": "inherit",
      "thinking": "medium"
      // tools inherit from inheritance.toolsDefault
    }
  },
  "inheritance": {
    "toolsDefault": ["read", "grep", "find", "ls", "bash"],
    "inheritProjectContext": true,
    "inheritSkills": false
  }
}
```

Use `"model": "inherit"` on a reviewer (or the gate) to follow whatever model the parent session is using. Override per-run with `--gate-model` or by editing the config.

## TUI output

The full report is rendered as a single markdown block and injected as an `assistant` message:

```text
## pi-review — uncommitted changes

**Verdict: REQUEST_CHANGES** (1 blockers · 1 major · 0 minor · 0 nit)
Reviewed in 42.1s · 4 reviewers · 1 gate

### claude-md-compliance (anthropic/claude-opus-4-6) — ok · 12.0s
- 1 issue
- [BLOCKER · compliance · conf 9] `src/auth.ts:42` — rule "no raw token logging" violated

### bug-detector (anthropic/claude-sonnet-4-6) — ok · 8.1s
- 1 issue
- [MAJOR · bug · conf 8] `src/auth.ts:42` — race: missing await on fetchUser

### conventions (anthropic/claude-sonnet-4-6) — ok · 6.2s
- 0 issues
- all naming/imports match surrounding files

### history-context (anthropic/claude-haiku-4-5) — ok · 4.8s
- 0 issues
- touched files have stable history, no recent reverts

### gate (anthropic/claude-haiku-4-5) — ok · 5.4s
- verdict: request_changes
- reason: One auth.ts blocker + one race condition in worker.ts; safe to merge after fixes.
- 2 issues after dedupe + threshold
```

A machine-readable copy is also written via `pi.appendEntry("pi-review", { ... })` for future TUI consumers.

## Install

```bash
pi install npm:@georgedong32/pi-review
```

Verify:

```bash
pi list
```

## Local development

```bash
bun install
bun run check     # tsc --noEmit
bun test          # node:test + tsx
```

## Repo structure

```text
index.ts                  Pi extension entry; registers /review + /review-config + /review-agents
src/types.ts              Shared interfaces (Issue, ReviewerSpec, PiReviewConfig, ReviewReport)
src/config.ts             loadConfig / mergeWithDefaults / validateConfig / writeConfig
src/args.ts               buildReviewerArgs / buildGateArgs / applyThinkingSuffix
src/spawn.ts              runSubagent (child_process.spawn + structured-output read)
src/schema.ts             TypeBox schemas for reviewer + gate outputs
src/parallel.ts           mapConcurrent (hard cap 4)
src/review.ts             runReviewers — fan-out + per-reviewer spawn
src/gate.ts               runGate — single spawn with aggregated prompt
src/git-input.ts          resolveDefaultDiff (status / vs default branch)
src/report.ts             buildReport + renderReport
agents/*.md               Bundled reviewer prompts
prompts/gate.md           Gate subagent prompt
tests/*.test.ts           node:test suites
```

## Limitations (v1)

- No retry: a failed reviewer is recorded as `ok=false` and the rest of the run continues. The gate still runs.
- No worktree isolation: all reviewers share the parent's cwd.
- GitHub: `gh pr diff` for PR URLs/numbers; PR comments are not posted.
- No web config UI: only `$EDITOR`.

## License

Apache-2.0
