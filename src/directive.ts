/**
 * Build the review directive injected into the main agent (hidden, via
 * `sendMessage` with `display:false` + `triggerTurn:true`).
 *
 * v0.7.0 contract (post-mortem from PR #18689 review):
 *   - chatProgress must be "auto" | "off" | "live-card" — anything else is
 *     rejected by pi-subagents schema validation.
 *   - Every reviewer child declares `cwd` (target workspace) and
 *     `outputSchema` so pi-subagents returns `result.structuredOutput`.
 *   - "inherit" reviewer models are NOT expanded into concrete model ids.
 *     The workflow script leaves `model:` off so the orchestrator keeps the
 *     inheritance link.
 *   - The gate consumes reviewer `structuredOutput` objects directly, never
 *     Markdown code fences.
 *   - Step 3 hands off to the `pi_review_report` tool, which is the only
 *     authoritative report renderer (deterministic code-side verdict).
 */
import {
	FALSE_POSITIVE_GUIDANCE,
	LEAN_BUDGETS,
	LEAN_GATE_AGENT,
	leanAgentName,
	resolveLeanBudgets,
	withThinkingSuffix,
	type LeanBudgetSpec,
} from "./lean-agents.js";
import { GATE_OUTPUT_SCHEMA, REVIEWER_OUTPUT_SCHEMA, serializeSchemaForJs } from "./workflow-schemas.js";
import type { ReviewerSpec, ReviewTarget } from "./types.js";

export interface ReviewDirectiveInput {
	target: ReviewTarget;
	reviewers: ReviewerSpec[];
	/** Resolved gate model id (from config.gate.model or --gate-model). */
	gateModel: string;
	/** Optional gate thinking from config (appended as model:thinking). */
	gateThinking?: string;
	threshold: number;
	/** Verdict policy passed to the gate task (code-side authoritative). */
	verdictPolicy?: "strict" | "legacy";
	lite: boolean;
	cwd: string;
	/** Absolute path to the plugin-prepared target workspace (reviewer cwd). */
	workspacePath: string;
	/** Absolute path to the run manifest.json. */
	manifestPath: string;
	/** Absolute path to the captured change.diff. */
	diffPath: string;
	/** Optional turnBudget override from config.budgets. */
	budgets?: LeanBudgetSpec;
}

export function buildReviewDirective(input: ReviewDirectiveInput): string {
	const { target, reviewers, gateModel, gateThinking, threshold, lite, cwd, workspacePath, manifestPath, diffPath } = input;
	const policy = input.verdictPolicy ?? "strict";
	const budgets = input.budgets ?? resolveLeanBudgets();
	const gateModelWithThinking = withThinkingSuffix(gateModel, gateThinking);
	const blocks: string[] = [];

	blocks.push("# Code review (token-lean)");
	blocks.push("");
	if (target.userContext?.trim()) {
		blocks.push(`**User request:** ${target.userContext.trim()}`);
		blocks.push("");
	}
	blocks.push(
		`Review the change (${target.label}). The plugin has already prepared the target workspace, diff and run manifest. Run one workflowScript that fans out ${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"}${lite ? " (lite)" : ""}${lite ? "" : " + inline gate"}, then call the \`pi_review_report\` tool to finalize the report. Do not re-write or summarize findings in chat.`,
	);
	blocks.push("");
	blocks.push("## Hard rules (do not violate)");
	blocks.push("");
	blocks.push("- Call `subagent` **exactly one** time in this whole review: the Step 2 workflowScript call.");
	blocks.push(
		lite
			? "- Step 2 must be a **single** `subagent({ workflowScript, async:false, ... })` that fans out the lite-reviewer via `runs.all([...])` — never more than one call."
			: "- Step 2 must be a **single** `subagent({ workflowScript, async:false, ... })` that fans out **all** reviewers via `runs.all([...])` and runs the inline gate via `runs.run(\"gate\", ...)` — never one call per reviewer, never serial waves.",
	);
	blocks.push(
		"- **Do not retry** or re-spawn if a reviewer times out, hits its turnBudget, returns partial output, or fails — `runs.all` collects failures as `{ ok:false }`; the script continues and you mark failures in the report.",
	);
	blocks.push(
		"- **Exception (script-level failure):** if the `subagent` call is rejected because the `workflowScript` **fails to parse** (no reviewer ever started — e.g. a syntax error in the script literal), you may correct the quoting/wrapping of the generated script and call `subagent` **once more**. Do not retry any reviewer that already started and failed.",
	);
	blocks.push("- **Do not** call `subagent` for verification, re-review, or rewriting the report.");
	blocks.push(
		"- Use the exact `pi-review.*` agents below — do not substitute builtin `reviewer`. Keep per-child `toolBudget` / `turnBudget` and the top-level `async:false` / `context:\"fresh\"` / `timeoutMs`.",
	);
	blocks.push("- Reviewer models **inherit** the parent session (omit per-child `model` unless the reviewer config sets an explicit model).");
	blocks.push(
		"- Copy the `workflowScript` below **exactly as written** into the `subagent({ workflowScript: ... })` call — every character matters (paths, `outputSchema` JSON, and budgets are already generated). Do not re-format, re-indent, or shorten it; a mistyped script is a script-level failure you may fix once only.",
	);
	blocks.push("");
	blocks.push(`**Skip these false positives:** ${FALSE_POSITIVE_GUIDANCE}.`);
	blocks.push("");

	blocks.push(
		"First, post the workflow as a markdown checklist into chat, then work through it — flip each `- [ ]` to `- [x]` as you finish.",
	);
	blocks.push("");
	const todoSteps = [
		`Confirm the plugin-prepared manifest is readable: ${manifestPath}`,
		`Confirm the target workspace is readable: ${workspacePath}`,
		lite
			? "Run one workflowScript: the lite-reviewer (one subagent call)"
			: `Run one workflowScript: ${reviewers.length} parallel reviewers + inline gate (one subagent call)`,
		"Call `pi_review_report` once with the workflow return value (never re-parse findings)",
	];
	for (const s of todoSteps) blocks.push(`- [ ] ${s}`);
	blocks.push("");

	// Step 1 — confirm the plugin-prepared manifest (no LLM-obtained diff).
	blocks.push("## Step 1 — Confirm the plugin-prepared run (you, the main agent)");
	blocks.push("");
	blocks.push(
		`The extension has **already** cloned/checked out the target repo, fetched an accurate diff, computed SHA-256 of the diff, and written \`${manifestPath}\` plus \`${diffPath}\`.`,
	);
	blocks.push("");
	blocks.push("Verify with a single `bash` call with **no `&&` / `||` chains** and no network calls. Use one `test` per file (no compound operators):");
	blocks.push("");
	blocks.push("```bash");
	blocks.push(`test -s ${JSON.stringify(diffPath)}`);
	blocks.push(`test -f ${JSON.stringify(manifestPath)}`);
	blocks.push(`test -d ${JSON.stringify(workspacePath)}`);
	blocks.push("```");
	blocks.push("");
	blocks.push("If any check fails, stop and notify the user. Otherwise continue.");
	blocks.push("");

	// Step 2 — single workflowScript call.
	const script = buildWorkflowScript({
		reviewers,
		gateModelWithThinking,
		gateModel,
		budgets,
		lite,
		threshold,
		verdictPolicy: policy,
		targetLabel: target.label,
		userContext: target.userContext,
		workspacePath,
		manifestPath,
		diffPath,
	});
	blocks.push("## Step 2 — Run the review (exactly one subagent workflowScript call)");
	blocks.push("");
	blocks.push(
		lite
			? "The script fans out the single lite-reviewer. Read `result.structuredOutput`; never parse free text."
			: "The script fans out the lean reviewers in parallel, then feeds their structuredOutput objects to the gate. The gate also returns structuredOutput; the script passes it back unchanged.",
	);
	blocks.push("");
	blocks.push("```js");
	blocks.push("subagent({");
	blocks.push(`  workflowScript: ${JSON.stringify(script)},`);
	blocks.push(`  async: false,`);
	blocks.push(`  context: "fresh",`);
	blocks.push(`  timeoutMs: ${budgets.timeoutMs},`);
	blocks.push(`  chatProgress: "auto",`);
	blocks.push("})");
	blocks.push("```");
	blocks.push("");
	blocks.push(
		"The return value is a JSON object: `{ reviewers: [{ key, ok, output, structuredOutput, status }], gate: { ok, output, structuredOutput } | null }`. Pass the whole object into `pi_review_report` — the tool is the source of truth for verdict, dedupe, and rendering.",
	);
	blocks.push("");

	// Step 3 — tool call.
	blocks.push("## Step 3 — Render the report (call `pi_review_report`)");
	blocks.push("");
	blocks.push(
		"Call the `pi_review_report` tool **exactly once** with `{ runId, workflowReturn }`. The tool loads the manifest, re-validates each reviewer's structuredOutput, runs the deterministic verdict rules, and renders the final markdown + persists a session entry. Do not re-write findings yourself.",
	);
	blocks.push("");

	// Parse guard (P0 regression): make sure the generated script is valid JS
	// BEFORE it reaches the main agent. If the template ever regresses (e.g. an
	// unquoted path), fail here with a clear error instead of at subagent() time.
	try {
		new Function(`return (async () => {\n${script}\n})`);
	} catch (err) {
		throw new Error(
			`pi-review: generated workflowScript is not valid JavaScript — refusing to hand it to the main agent. This is a plugin bug; please report it. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return blocks.join("\n");
}

/**
 * Build the inline workflowScript string. Single-wave: one `runs.all([...])`
 * for reviewers, one `runs.run(\"gate\")`. Every child carries `cwd`,
 * `outputSchema`, `toolBudget`/`turnBudget`; explicit model overrides flow
 * through only when the reviewer config is not `inherit`.
 */
export function buildWorkflowScript(input: {
	reviewers: ReviewerSpec[];
	gateModelWithThinking: string;
	gateModel: string;
	budgets: LeanBudgetSpec;
	lite: boolean;
	threshold: number;
	/** Verdict policy for the gate task text (strict is code-side default). */
	verdictPolicy?: "strict" | "legacy";
	targetLabel: string;
	userContext?: string;
	/** Absolute target workspace path (reviewer + gate cwd). */
	workspacePath: string;
	/** Absolute run manifest path. */
	manifestPath: string;
	/** Absolute change.diff path. */
	diffPath: string;
}): string {
	const {
		reviewers,
		gateModelWithThinking,
		gateModel,
		budgets,
		lite,
		threshold,
		verdictPolicy = "strict",
		targetLabel,
		userContext,
		workspacePath,
		manifestPath,
		diffPath,
	} = input;

	const reviewerSchemaLiteral = serializeSchemaForJs(REVIEWER_OUTPUT_SCHEMA);
	const gateSchemaLiteral = serializeSchemaForJs(GATE_OUTPUT_SCHEMA);

	// Blanket read-only declaration. pi-subagents classifies each task text for
	// mutation intent: with a generic-object prohibition ("do not write any
	// files") plus "review only"/"return findings only", the task is
	// unambiguously read-only, so a read-only agent (gate: tools read) is never
	// rejected by the implementation-tool contract, and acceptance stays at the
	// lightweight attested level instead of "risky write-capable".
	const READ_ONLY_PREFIX =
		"READ-ONLY task — review only. Do not write any files. Do not edit files. Return findings only.";

	const lines: string[] = [];
	// Bind the reviewer array to a local FIRST: the gate IIFE and
	// `reviewersShaped` below both reference `reviewers`, and a bare object
	// property (`return { reviewers: ... }`) does NOT create a variable
	// binding — that produced `ReferenceError: reviewers is not defined` at
	// runtime (silently surfaced as a null workflow return).
	lines.push("const reviewers = await runs.all([");
	for (const r of reviewers) {
		const tb = LEAN_BUDGETS.defaultToolBudget; // resolved below per-id
		const tbForId = r.id === "history-context" ? LEAN_BUDGETS.historyToolBudget : tb;
		const taskParts = [
			READ_ONLY_PREFIX,
			`Read ${JSON.stringify(diffPath)} as the change. Also read ${JSON.stringify(manifestPath)} for change-profile (docsOnly, file list, rule file paths). Do not re-fetch via gh/git.`,
			`Your cwd is the target workspace (${JSON.stringify(workspacePath)}). Run all read/grep/git from there.`,
			"Stay within budgets; return your findings as structuredOutput matching the REVIEWER_SCHEMA and stop.",
			"Do not read plan.md, progress.md, .pi-subagents transcripts, or node_modules.",
			"Prefer Read/Grep. If you use bash, only simple allowlisted commands (no &&/||/; compounds).",
		];
		if (r.id === "claude-md-compliance") {
			taskParts.push(
				`If change-profile.rulePaths is empty, return status: skipped with empty issues — do not invent rule violations.`,
			);
		}
		if (r.id === "history-context") {
			taskParts.push(
				`If change-profile.history.available is false, return status: skipped with empty issues. Take ≤5 paths from the file list and run ONE bash: git log -n 5 --oneline -- <file1> <file2> ...`,
			);
		}
		if (r.id === "code-comments") {
			taskParts.push(
				`If change-profile.docsOnly is true, return status: skipped with empty issues.`,
			);
		}
		if (r.id === "bugbot" || r.id === "security-review") {
			taskParts.push(
				`If change-profile.docsOnly is true, return status: skipped with empty issues. Otherwise prefer diff-only; at most 3 extra file reads.`,
			);
		}
		if (userContext?.trim()) {
			taskParts.push(`User request: ${userContext.trim()}`);
		}
		const taskLiteral = JSON.stringify(taskParts.join(" "));

		const modelClause =
			r.model && r.model !== "inherit"
				? `\n      model: ${JSON.stringify(r.model)},`
				: "";
		lines.push("    {");
		lines.push(`      key: ${JSON.stringify(r.id)},`);
		lines.push(`      agent: ${JSON.stringify(leanAgentName(r.id))},`);
		lines.push(`      task: ${taskLiteral},`);
		lines.push(`      cwd: ${JSON.stringify(workspacePath)},`);
		if (r.thinking) {
			lines.push(`      thinking: ${JSON.stringify(r.thinking)},`);
		}
		lines.push(`      toolBudget: { soft: ${tbForId.soft}, hard: ${tbForId.hard} },`);
		lines.push(
			`      turnBudget: { maxTurns: ${budgets.turnBudget.maxTurns}, graceTurns: ${budgets.turnBudget.graceTurns} },${modelClause}`,
		);
		lines.push(`      outputSchema: ${reviewerSchemaLiteral},`);
		lines.push("    },");
	}
	lines.push("]);");
	lines.push("");
	lines.push("return {");
	lines.push("  reviewers,");

	// ---- gate ----------------------------------------------------------
	if (!lite) {
		const gateTask = [
			READ_ONLY_PREFIX,
			`Synthesize reviewer findings for ${targetLabel}.`,
			`The full diff is at ${JSON.stringify(diffPath)} and your cwd is the target workspace — you CAN and SHOULD verify candidates yourself.`,
			`Threshold ${threshold}: drop candidates with finalConfidence < ${threshold}.`,
			`Inputs are reviewer structuredOutput objects (each has status, issues[].fingerprint, coverage).`,
			`Re-score every candidate 1–10. For each blocker/major candidate, first try to verify it by reading the diff hunk and the touched file in the workspace; state what you checked in the disposition reason.`,
			`Never raise a candidate above 8 without your own verification evidence from the diff or workspace files.`,
			`If you cannot verify a blocker/major candidate (missing context, truncated diff), do NOT silently drop it: keep it at the reviewer's original confidence, prefix the reason with "unverified:", and let the human decide.`,
			`Every candidate must appear in dispositions with decision (kept | dropped | merged), originalConfidence, finalConfidence, sourceReviewers, reason.`,
			verdictPolicy === "legacy"
				? `Verdict (legacy): request_changes if any blocker OR >=3 majors; approve if no blocker/major; else comment.`
				: `Verdict (strict): request_changes if any surviving blocker or major; comment if only minor/nit; approve if no surviving issues.`,
			`The parent re-applies verdict in code; this is a recommendation.`,
			`Skip false positives: ${FALSE_POSITIVE_GUIDANCE}.`,
			`Output structuredOutput matching GATE_SCHEMA (verdict, issues[], dispositions[], reason).`,
		].join(" ");
		const gateTaskLiteral = JSON.stringify(gateTask);

		lines.push("  gate: await (async () => {");
		// Inline the reviewer structuredOutput objects into the gate task.
		// We can't JSON.stringify them yet (they don't exist), so we build a
		// gateInput array using the captured reviewers list and pass it as
		// the task string at runtime.
		lines.push("    const reviewerInputs = reviewers.map((r) => ({");
		lines.push("      key: r.key,");
		lines.push("      ok: r.ok,");
		lines.push("      error: r.error,");
		lines.push("      status: r.ok && r.structuredOutput && typeof r.structuredOutput === 'object' ? r.structuredOutput.status : (r.ok ? 'limited' : 'failed'),");
		lines.push("      issues: r.ok && r.structuredOutput && Array.isArray(r.structuredOutput.issues) ? r.structuredOutput.issues : [],");
		lines.push("      coverage: r.ok && r.structuredOutput && r.structuredOutput.coverage ? r.structuredOutput.coverage : { filesChecked: [], commandsRun: [], limitations: [r.ok ? 'no structuredOutput' : 'reviewer failed'] },");
		lines.push("    }));");
		lines.push("    const gateTask = " + gateTaskLiteral + " + '\\n\\n## Reviewer findings (structuredOutput)\\n' + JSON.stringify(reviewerInputs);");
		lines.push("    const result = await runs.run('gate', {");
		lines.push(`      agent: ${JSON.stringify(LEAN_GATE_AGENT)},`);
		lines.push("      task: gateTask,");
		lines.push(`      cwd: ${JSON.stringify(workspacePath)},`);
		lines.push(`      model: ${JSON.stringify(gateModelWithThinking)},`);
		lines.push(`      toolBudget: { soft: ${budgets.gateToolBudget.soft}, hard: ${budgets.gateToolBudget.hard} },`);
		lines.push(`      turnBudget: { maxTurns: ${budgets.gateTurnBudget.maxTurns}, graceTurns: ${budgets.gateTurnBudget.graceTurns} },`);
		lines.push(`      outputSchema: ${gateSchemaLiteral},`);
		lines.push("    });");
		lines.push("    return {");
		lines.push("      ok: result.ok,");
		lines.push("      error: result.error,");
		lines.push("      output: result.output,");
		lines.push("      structuredOutput: result.ok && result.structuredOutput && typeof result.structuredOutput === 'object' ? result.structuredOutput : null,");
		lines.push("    };");
		lines.push("  })(),");
	} else {
		lines.push("  gate: null,");
	}

	// ---- reviewer summary shape ----------------------------------------
	lines.push("  reviewersShaped: reviewers.map((r) => ({");
	lines.push("    key: r.key,");
	lines.push("    ok: r.ok,");
	lines.push("    error: r.error,");
	lines.push("    status: r.ok && r.structuredOutput && typeof r.structuredOutput === 'object' ? r.structuredOutput.status : (r.ok ? 'limited' : 'failed'),");
	lines.push("    output: r.output,");
	lines.push("    structuredOutput: r.ok && r.structuredOutput && typeof r.structuredOutput === 'object' ? r.structuredOutput : null,");
	lines.push("  })),");
	lines.push("};");
	return lines.join("\n");
}

/** Map the workflow return value into a normalized `ReviewWorkflowReturn` for the tool. */
export function buildWorkflowReturnShape() {
	return "{ reviewers, reviewersShaped, gate }";
}

// `gateModel` reserved for config validation parity with previous surface.
export const _LEGACY_PARITY = { gateModel: "" };
void _LEGACY_PARITY;