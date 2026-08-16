# pi-review

Pi extension for code review that runs **in the foreground**: `/review` hands a directive to the main agent, which runs one `subagent({ workflowScript, async:false })` call that fans out parallel reviewers and an inline gate. The whole review streams in chat — no silent background work.

Requires the **pi-subagents** extension (`pi install npm:pi-subagents`, ≥0.41) — it provides the `subagent` tool's `workflowScript` surface used to fan out.

Pattern ported from the Claude code-review plugin. See [reference/](./reference/) for upstream flow notes and the version roadmap.

## Commands

```text
/review [any prompt] [--lite] [--gate-model <id>]
/review-config
/review-agents
/review-show
```

### `/review`

**CC-aligned:** text after `/review` is **user context**. The extension **prepares the run deterministically** (v0.7): it resolves the target, acquires the diff, records a manifest (`.pi/pi-review/runs/<runId>/manifest.json`), and — for PRs — checks out the **target repo** into a scratch workspace. The main agent then runs one `subagent({ workflowScript, async:false })` and calls `pi_review_report` to finalize the report.

When called with no arguments, `/review` targets **local git**:

1. If the working tree is dirty → `git diff HEAD` into `.pi/pi-review/runs/<runId>/change.diff`.
2. If clean → **`git fetch origin <default-branch>`**, then `git diff origin/<default-branch>...HEAD` (avoids a stale local `main`/`master`).
3. Writes `manifest.json` (base/head SHAs, diff SHA-256, changed files, docs-only flag, rule paths, history availability).
4. Outside a git repo with no PR → notify and exit.

**PR review:** pass a GitHub PR URL or number. The extension tries `gh pr view` + `gh pr diff`; if the diff is too large (GitHub 20k-line limit) or unavailable, it fetches `pull/<n>/head` + the PR base ref and runs a three-dot git diff. Oversized PRs no longer fail in the plugin layer. Reviewers run from a **target workspace** (a shallow clone with the PR head checked out), so `history-context` / `code-comments` correctly see the reviewed repo even when the plugin runs from a different directory.

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

## Bundled reviewers (v0.5.1 lean agents)

Runtime names are `pi-review.<id>` (package agents registered via `pi.subagents.agents`).

| ID | Purpose | Default | Tools |
|---|---|---|---|
| `claude-md-compliance` | Project rules (AGENTS.md / CLAUDE.md / .pi/) | enabled | read, grep, ls |
| `bugbot` | Obvious bugs in introduced lines only | enabled | read, grep, bash |
| `history-context` | Light git blame / log (≤5 files, `log -n 5`) | enabled | read, bash |
| `security-review` | Security issues introduced by the change | enabled | read, grep, bash |
| `code-comments` | Inline comment / TODO guidance in changed files | enabled | read, grep |
| `conventions` | De-facto style pass | **disabled** | read, grep, ls |
| `gate` | Dedupe + re-score + verdict | (always) | read |
| `lite-review` | Single-agent all-dimensions (`--lite`) | on demand | read, grep, bash |

## Pipeline

`/review` runs in the foreground. The extension prepares the run, then:

```text
Step 0  extension: resolve target → acquire diff + manifest → prepare target workspace
Step 1  main agent verifies the prepared manifest/workspace (one bash call)
Step 2  subagent({ workflowScript, async:false }) — once
          runs.all([ pi-review.* reviewers … ]) → runs.run("gate", { structuredOutput })
Step 3  pi_review_report tool → code-side verdict + persisted session entry + markdown
```

Every reviewer and the gate carry `outputSchema`; the workflow consumes `result.structuredOutput` (never free-text). Reviewer findings include `status` (`ok`/`limited`/`skipped`) and `coverage`; the gate emits per-candidate `dispositions` (kept / dropped / merged) so high-severity candidates are never silently lost.

**Permissions:** the extension performs diff/clone/fetch via its own subprocesses. It **no longer writes** `.pi/projects/<id>/permissions.local.json`. Reviewer children rely on their `tools:` allowlist (read/grep and a few read-only git commands) — no persistent project permission mutation.

**Cost:** dominated by N × tool turns. Prefer `--lite` for a cheap pass. Reviewer thinking **inherits** the parent session; only the gate uses `config.gate.thinking`.

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
    // Verdict policy: "strict" (any surviving blocker/major → request_changes)
    // | "legacy" (≥3 majors). Code-side enforced.
    "verdictPolicy": "strict"
  },
  "routing": {
    // "adaptive" (default) drops clearly-inapplicable lanes (no rule files,
    // docs-only, no git history) before spawning. "all" keeps the full roster.
    "mode": "adaptive"
  },
  "budgets": {
    "turnBudget": { "maxTurns": 20, "graceTurns": 2 }
  },
  "reviewers": {
    "claude-md-compliance": {
      "model": "anthropic/claude-opus-4-6",
      "thinking": "high",
      "enabled": true
    },
    "bugbot": {
      "model": "inherit",
      "thinking": "medium"
    }
  }
}
```

Use `"model": "inherit"` on a reviewer to follow the parent session's model; per-reviewer `thinking` is passed through to the child subagent. The gate defaults to a cheap tier; override it persistently via `gate.model`, or per-run with `--gate-model <id>`.

**Legacy keys** (`concurrency`, `inheritance`, `gate.scorePerIssue`, `reviewers.<id>.tools`, `reviewers.<id>.timeoutMs`) are ignored — `/review` prints one migration warning when present. Remove them from your config to silence the warning.

## TUI output

The `pi_review_report` tool renders deterministic markdown into chat and persists a machine-readable session entry. A collapsible TUI renderer shows a verdict + count preview line; `/review-show` re-renders the most recent report. Shape (illustrative):

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
index.ts                  Pi extension entry; registers /review + /review-config + /review-agents + /review-show
src/review-run.ts         Plugin-side run prep: diff acquisition, manifest, directive (active path)
src/target-workspace.ts   PR target checkout (workspace for reviewers)
src/review-report.ts      Manifest + diff helpers (SHA-256, changed-files, rule paths, prune)
src/directive.ts          Directive + workflowScript generator (outputSchema, single-wave)
src/workflow-schemas.ts   JSON Schema for reviewer / gate structured output
src/report-tool.ts        pi_review_report implementation (code-side enforce + render)
src/tool-wrapper.ts       Register the report tool
src/tui-renderer.ts       Collapsible TUI renderer for "pi-review" cards
src/report.ts             buildReportFromWorkflow + renderReport
src/gate-enforce.ts       Dedupe + threshold + strict/legacy verdict (deterministic)
src/types.ts              Shared interfaces
src/config.ts             loadConfig / mergeWithDefaults / validateConfig / writeConfig
src/schema.ts             TypeBox schemas (legacy spawn path)
agents/*.md               Bundled reviewer prompts (incl. lite-review.md for --lite)
prompts/gate.md           Gate subagent prompt
tests/*.test.ts           node:test suites
```

## Limitations (v1)

- No automatic retry: a failed reviewer is recorded as `ok=false` and the rest of the run continues. The gate still runs.
- The prepared target workspace (for PRs) is ephemeral under `.pi/pi-review/runs/` and pruned by TTL; it is not a full worktree with build state.
- GitHub: the extension uses `gh`/`git` to obtain PRs; oversized diffs fall back to git. PR comments are not posted.
- No web config UI: only `$EDITOR`.

## License

Apache-2.0
