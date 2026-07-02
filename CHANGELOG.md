# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-02

### Added
- `/review [path]` slash command — fans the diff out to four parallel reviewer subagents (`claude-md-compliance`, `bug-detector`, `conventions`, `history-context`) and aggregates their structured output through a single cheap-model gate.
- `/review-config` — opens `~/.pi/agent/extensions/pi-review/config.json` in `$EDITOR` and re-validates on close.
- `/review-agents` — lists the bundled reviewers with their resolved model, thinking, and tool lists.
- Smart default diff source: dirty working tree → `git diff HEAD`; clean tree → `git diff <default-branch>...HEAD`. Probes `origin/HEAD` → `main` → `master` → current branch.
- Per-reviewer model / thinking / tool overrides via `~/.pi/agent/extensions/pi-review/config.json`. `"inherit"` resolves to the parent session's model at run time.
- Flags: `--threshold N`, `--reviewer id...` (repeatable), `--no-gate`, `--gate-model id`, `--no-spawn` (dry run).
- TUI output: full report rendered as an `assistant` text block. Machine-readable copy written via `pi.appendEntry("pi-review", ...)` for future collapse-aware consumers.
- Structured output via TypeBox schemas. Subagents receive the JSON Schema via `PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA` and write the validated payload to `PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE`. Parent re-validates with `validateValue`.

### Changed
- Each reviewer / gate runs as a fresh, isolated `pi` subprocess (`--no-session --no-extensions --no-skills`) — mirrors the pattern from `pi-subagents`.
- Hard cap of 4 concurrent reviewers, regardless of `concurrency` in config.
- The gate is spawned with no tools — pure reasoning on the aggregated prompt.

### Out of scope (deferred)
- Retry loop for failed reviewers.
- Worktree-per-reviewer isolation.
- GitHub / `gh` integration (PR comment posting).
- Inline fix suggestions / auto-apply.
- Multi-PR batch mode.
- Web UI for configuration.
