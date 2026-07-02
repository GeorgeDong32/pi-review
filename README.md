# pi-review

Pi extension for fan-out code review: **N parallel reviewer subagents + a cheap-model gate** that aggregates their structured output into a final verdict.

Pattern ported from the Claude code-review plugin: instead of one LLM looking at the diff, multiple specialised reviewers run in parallel, then a single low-cost "gate" dedupes their findings and decides whether the change is `approve`, `comment`, or `request_changes`.

## Commands

```text
/review [path | @path] [--threshold N] [--reviewer id ...] [--no-gate] [--gate-model id] [--no-spawn]
/review-config
/review-agents
```

### `/review`

When called with no arguments, `/review` resolves a default diff source:

1. If the working tree is dirty (per `git status --porcelain`) → `git diff HEAD` of uncommitted changes.
2. If the working tree is clean → `git diff <default-branch>...HEAD` (default branch probed from `origin/HEAD` → `main` → `master` → current branch).
3. Outside a git repo with no path argument → notify the user and exit.

You can also pass a path to a diff file or `@./relative.diff` to review an explicit input.

Flags:

| Flag | Effect |
|---|---|
| `--threshold N` | Override the confidence floor (0-10). Issues with `confidence < N` are dropped by the gate. Default 3. |
| `--reviewer id` | Restrict the run to a specific reviewer. Repeatable. |
| `--no-gate` | Skip the gate step. Useful for fast iteration when you only want raw reviewer output. |
| `--gate-model id` | Override the gate's model for this run. |
| `--no-spawn` | Dry run — print the resolved reviewer list, gate model, threshold, and exit. |

## Bundled reviewers

| ID | Purpose | Default thinking | Default tools |
|---|---|---|---|
| `claude-md-compliance` | Audit diff against project rules in AGENTS.md / CLAUDE.md / .pi/ | high | read, grep, find, ls |
| `bug-detector` | Find obvious bugs — null deref, off-by-one, missing awaits, swallowed errors, race conditions | medium | read, grep, find |
| `conventions` | Style pass — naming, error handling, `any` usage, import order | medium | read, grep, find, ls |
| `history-context` | Use `git blame` / `git log` on touched files to surface hot areas and re-fix patterns | minimal | read, bash |

The gate is run with no tools (pure reasoning) and uses the user-configured model.

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
    // Issues with confidence < threshold are dropped by the gate.
    "threshold": 3
  },
  "concurrency": 4,            // hard cap = 4
  "reviewers": {
    "claude-md-compliance": {
      "model": "anthropic/claude-opus-4-6",
      "thinking": "high",
      "enabled": true
    },
    "bug-detector": {
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
- No GitHub integration: pass a diff as input. PR comments are not posted.
- No web config UI: only `$EDITOR`.

## License

Apache-2.0
