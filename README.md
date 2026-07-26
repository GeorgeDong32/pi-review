# pi-review

Pi extension for code review that runs **in the foreground**: `/review` hands a directive to the main agent, which fans out parallel reviewers + a cheap-model gate via the `subagent` tool. The whole review streams in chat — no silent background work.

Requires the **pi-subagents** extension (`pi install npm:@mariozechner/pi-subagents`) — it provides the `subagent` tool used to fan out.

Pattern ported from the Claude code-review plugin. See [reference/](./reference/) for upstream flow notes and the version roadmap.

## Commands

```text
/review [any prompt] [--lite] [--gate-model <id>]
/review-config
/review-agents
```

### `/review`

**CC-aligned (v0.4):** text after `/review` is **user context**. The plugin does **not** pre-fetch and embed a full diff. Reviewer subagents obtain the change themselves with `gh` / `git` / `read` (same idea as Claude `/code-review`).

When called with no arguments, `/review` targets **local git** and tells agents to:

1. If the working tree is dirty → use `git diff HEAD` (and untracked files as needed).
2. If clean → use `git diff <default-branch>...HEAD`.
3. Outside a git repo with no PR/`--diff` → notify and exit.

**PR review:** pass a GitHub PR URL or number. Agents are instructed to try `gh pr view` / `gh pr diff`, and if the diff is too large (GitHub 20k-line limit), fall back to git / path-scoped reads. Oversized PRs no longer fail in the plugin layer.

```text
/review https://github.com/org/repo/pull/17206
/review 17206
/review focus on backup restore — PR 17206
```

**Lite mode:** add `--lite` for a fast single-agent pass — one reviewer covers all dimensions (bugs / security / compliance / code-comments / history), no fan-out, no gate. Lower latency and cost; ideal for a quick gut-check.

```text
/review --lite
/review --lite focus on concurrency and secret handling
```

### Flags

The surface is intentionally minimal. Removed knobs (`--threshold` / `--reviewer` / `--no-gate` / `--score-per-issue` / `--diff`) are accepted-but-ignored so old invocations do not break; their capabilities now live in `config.json` via `/review-config`.

| Flag | Effect |
|---|---|
| `--lite` | Single-agent fast mode: one reviewer, no gate. |
| `--gate-model <id>` | Override the gate model for this run (otherwise `config.gate.model`). |
| `--no-spawn` | Dry run — print the directive that would be injected, and exit. |

### Removed flags → config

| Old flag | config.json key |
|---|---|
| `--threshold N` | `gate.threshold` |
| `--reviewer id` | `reviewers.<id>.enabled` |
| `--no-gate` | `gate.enabled` |
| `--score-per-issue MODE` | `gate.scorePerIssue` |
| `--diff path` | *(removed — pass a PR url or run in a dirty repo instead)* |

## Bundled reviewers (v0.4)

| ID | Purpose | Default | Tools |
|---|---|---|---|
| `claude-md-compliance` | Project rules (AGENTS.md / CLAUDE.md / .pi/) | enabled | read, grep, find, ls, bash |
| `bugbot` | Obvious bugs in introduced lines only | enabled | read, grep, find, bash |
| `history-context` | Git blame / log context on touched files | enabled | read, bash |
| `security-review` | Security issues introduced by the change | enabled | read, grep, find, bash |
| `code-comments` | Inline comment / TODO guidance in changed files | enabled | read, grep, find, ls, bash |
| `conventions` | De-facto style pass | **disabled** | read, grep, find, ls, bash |

## Pipeline

`/review` runs in the foreground: the handler builds a directive and injects it **hidden** into the main agent (`sendMessage` with `display:false` + `triggerTurn:true` — only a short `/review <prompt>` echo is shown in chat). The main agent obtains the diff once, then fans out reviewers via the `subagent` tool (from pi-subagents):

```text
handler:  parse args → load config → resolve target → build directive
          → sendMessage(echo, display:true) + sendMessage(directive, display:false, triggerTurn:true)
main agent (foreground streaming):
  Step 1  obtain diff → /tmp/pi-review-change.diff
  Step 2  subagent({ tasks: [5 reviewers] })        — each reads the diff + agents/<id>.md
  Step 3  subagent({ task: gate, model: <cheap> })  — reads prompts/gate.md
  Step 4  markdown report (verdict + findings) → chat

--lite: Step 2 with a single lite-reviewer; skip Step 3.
```

The two-level idea matches Claude's code-review (parallel find → independent confidence filter), but verdict/threshold are now **instructed** to the main agent rather than code-enforced — the LLM follows the rule but it is no longer a hard guarantee. The main agent starts by posting a markdown checklist of the steps, then works through them. The original background spawn path (`src/run.ts`, `src/spawn.ts`) is kept as a fallback.

## Configuration

Per-user config lives at:

```text
~/.pi/agent/pi-review.json
```

Run `/review-config` to open it in `$EDITOR`. The file is loaded, merged with the built-in defaults, and validated on every `/review` call. Unknown reviewer ids are added as new reviewers; known ids are patched in place.

```jsonc
{
  "schemaVersion": 1,
  "gate": {
    // Cheap tier by default (pure de-noise reasoning). "inherit" follows the parent session.
    // Override to a specific id; non-anthropic providers must set this explicitly.
    "model": "anthropic/claude-haiku-4-5",
    "thinking": "low",
    "enabled": true,
    // Issues with confidence < threshold are dropped (code-enforced).
    "threshold": 8,
    // Per-issue scorers: "off" (default) | "blocker-major" | "all"
    "scorePerIssue": "off"
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

Use `"model": "inherit"` on a reviewer to follow the parent session's model. The gate defaults to a cheap tier; override it persistently via `gate.model` in config, or per-run with `--gate-model <id>` (the directive injects it into the gate subagent).

## TUI output

The main agent writes the report directly into chat. Shape (illustrative):

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
agents/*.md               Bundled reviewer prompts (incl. lite-review.md for --lite)
prompts/gate.md           Gate subagent prompt
tests/*.test.ts           node:test suites
```

## Limitations (v1)

- No retry: a failed reviewer is recorded as `ok=false` and the rest of the run continues. The gate still runs.
- No worktree isolation: all reviewers share the parent's cwd.
- GitHub: agents use `gh`/`git` to obtain PRs; oversized diffs fall back to git. PR comments are not posted.
- No web config UI: only `$EDITOR`.

## License

Apache-2.0
