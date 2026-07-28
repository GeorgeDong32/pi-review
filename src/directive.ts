/**
 * Build the review directive injected into the main agent (hidden, via
 * `sendMessage` with `display:false` + `triggerTurn:true` — see index.ts).
 *
 * Token-lean flow (v0.5.1):
 *   1. Main agent obtains the diff once into a cwd-local file (do not read it).
 *   2. Fan-out via pi-subagents `subagent` with **explicit lean package agents**
 *      (`pi-review.*`), turnBudget, toolBudget, reads:false, file-only output.
 *   3. Gate on a cheap model (skipped in --lite).
 *   4. Report from file-only output paths — do not re-read the full diff.
 *
 * Requires: pi-subagents extension (provides the `subagent` tool) and the
 * pi-review package agents registered via `pi.subagents.agents`.
 */
import { join } from "node:path";
import {
	FALSE_POSITIVE_GUIDANCE,
	LEAN_BUDGETS,
	LEAN_GATE_AGENT,
	leanAgentName,
	toolBudgetForReviewer,
} from "./lean-agents.js";
import type { ReviewerSpec, ReviewTarget } from "./types.js";

export interface ReviewDirectiveInput {
	target: ReviewTarget;
	/** Enabled reviewers (config), or a single lite-reviewer spec in --lite mode. */
	reviewers: ReviewerSpec[];
	/** Resolved gate model id (from config.gate.model or --gate-model). */
	gateModel: string;
	/** Confidence floor; gate drops issues below this. */
	threshold: number;
	/** Lite mode: single reviewer, no gate. */
	lite: boolean;
	/** Workspace cwd — diff is written under this tree (not /tmp) so children can read it. */
	cwd: string;
}

/** Relative path (under cwd) for the shared diff file. */
export const DIFF_REL_PATH = join(".pi", "pi-review", "change.diff");

/** Absolute path for the shared diff given a cwd. */
export function diffFilePath(cwd: string): string {
	return join(cwd, DIFF_REL_PATH);
}

/**
 * Render the directive string. Kept pure (no ctx / no side effects) so it is
 * trivially unit-testable — see tests/directive.test.ts.
 */
export function buildReviewDirective(input: ReviewDirectiveInput): string {
	const { target, reviewers, gateModel, threshold, lite, cwd } = input;
	const diffPath = diffFilePath(cwd);
	const budgets = LEAN_BUDGETS;
	const concurrency = Math.min(reviewers.length, 4);
	const blocks: string[] = [];

	blocks.push("# Code review (token-lean)");
	blocks.push("");
	if (target.userContext?.trim()) {
		blocks.push(`**User request:** ${target.userContext.trim()}`);
		blocks.push("");
	}
	blocks.push(
		`Review the change (${target.label}). You obtain the diff once, then fan out ${reviewers.length} lean reviewer${reviewers.length === 1 ? "" : "s"}${lite ? " (lite mode)" : ""}, ${lite ? "then write the report" : "then run a gate pass, then write the report"}.`,
	);
	blocks.push("");
	blocks.push(
		"**Critical:** Call `subagent` with the exact arguments below — do not substitute the builtin `reviewer` agent, and do not drop `turnBudget` / `toolBudget` / `reads: false` / `outputMode` / `acceptance`.",
	);
	blocks.push("");
	blocks.push(`**Skip these false positives:** ${FALSE_POSITIVE_GUIDANCE}.`);
	blocks.push("");

	// Checklist
	blocks.push(
		"First, post the workflow as a markdown checklist into chat, then work through it — flip each `- [ ]` to `- [x]` as you finish it.",
	);
	blocks.push("");
	const todoSteps = lite
		? [
				`Obtain the diff → ${DIFF_REL_PATH} (write only — do not read it)`,
				"Fan out a single lite-reviewer (subagent)",
				"Write the report into chat from output file(s)",
			]
		: [
				`Obtain the diff → ${DIFF_REL_PATH} (write only — do not read it)`,
				`Fan out ${reviewers.length} lean reviewers (subagent)`,
				"Run the gate pass (subagent)",
				"Write the report into chat from output files",
			];
	for (const s of todoSteps) blocks.push(`- [ ] ${s}`);
	blocks.push("");

	// Step 1
	blocks.push("## Step 1 — Obtain the change (you, the main agent)");
	blocks.push("");
	blocks.push(`Create the directory if needed, then save the full diff to \`${diffPath}\`.`);
	blocks.push("**Do not read, cat, or summarize the diff** — only write the file, then verify it is non-empty (`wc -l` / `test -s`).");
	blocks.push("");
	blocks.push("```bash");
	blocks.push(`mkdir -p "${join(cwd, ".pi", "pi-review")}"`);
	if (target.kind === "pr" && target.prRef) {
		blocks.push(`gh pr diff ${shellQuote(target.prRef)} > "${diffPath}"`);
		blocks.push(
			`# If that fails (too_large / HTTP 406): fetch the PR head, then git diff <default-branch>...<pr-head> > "${diffPath}"`,
		);
	} else {
		blocks.push(`# Dirty tree:`);
		blocks.push(`git diff HEAD > "${diffPath}"`);
		blocks.push(`# Clean tree instead: git diff <default-branch>...HEAD > "${diffPath}"`);
	}
	blocks.push(`test -s "${diffPath}"`);
	blocks.push("```");
	blocks.push("");

	// Step 2
	blocks.push("## Step 2 — Fan out lean reviewers");
	blocks.push("");
	blocks.push(
		"Call the `subagent` tool **ONCE** with **all** of the following fields. Each task uses a `pi-review.*` package agent (not builtin `reviewer`).",
	);
	blocks.push("");
	blocks.push("```js");
	blocks.push("subagent({");
	blocks.push("  tasks: [");
	for (const r of reviewers) {
		const agent = leanAgentName(r.id);
		const tb = toolBudgetForReviewer(r.id);
		const task = buildReviewerTask(r.id, diffPath, target.userContext);
		const modelLine =
			r.model && r.model !== "inherit"
				? `\n      model: ${JSON.stringify(r.model)},`
				: "";
		blocks.push("    {");
		blocks.push(`      agent: ${JSON.stringify(agent)},`);
		blocks.push(`      task: ${JSON.stringify(task)},`);
		blocks.push(`      output: ${JSON.stringify(r.id)},`);
		blocks.push(`      outputMode: "file-only",`);
		blocks.push(`      reads: false,`);
		blocks.push(`      acceptance: false,`);
		blocks.push(`      toolBudget: { soft: ${tb.soft}, hard: ${tb.hard} },${modelLine}`);
		blocks.push("    },");
	}
	blocks.push("  ],");
	blocks.push(`  concurrency: ${concurrency},`);
	blocks.push(
		`  turnBudget: { maxTurns: ${budgets.turnBudget.maxTurns}, graceTurns: ${budgets.turnBudget.graceTurns} },`,
	);
	blocks.push(`  timeoutMs: ${budgets.timeoutMs},`);
	blocks.push(`  context: "fresh",`);
	blocks.push("})");
	blocks.push("```");
	blocks.push("");

	// Step 3 — gate
	if (!lite) {
		blocks.push("## Step 3 — Gate");
		blocks.push("");
		blocks.push(
			"After all reviewers return, call `subagent` once more. Pass the **file paths** from the previous file-only results (do not paste full reviewer transcripts). Use the gate agent + cheap model:",
		);
		blocks.push("");
		const gateTask = [
			`Synthesize reviewer findings for change ${target.label}.`,
			`Threshold: ${threshold} (drop issues with confidence < ${threshold}).`,
			`Read each reviewer output file path returned by the previous subagent call (file-only).`,
			`Dedupe by (file, line, category), re-score 1-10, return surviving issues + verdict.`,
			`Skip false positives: ${FALSE_POSITIVE_GUIDANCE}.`,
		].join(" ");
		blocks.push("```js");
		blocks.push("subagent({");
		blocks.push(`  agent: ${JSON.stringify(LEAN_GATE_AGENT)},`);
		blocks.push(`  task: ${JSON.stringify(gateTask)},`);
		blocks.push(`  model: ${JSON.stringify(gateModel)},`);
		blocks.push(`  output: "gate",`);
		blocks.push(`  outputMode: "file-only",`);
		blocks.push(`  reads: false,`);
		blocks.push(`  acceptance: false,`);
		blocks.push(
			`  toolBudget: { soft: ${budgets.gateToolBudget.soft}, hard: ${budgets.gateToolBudget.hard} },`,
		);
		blocks.push(
			`  turnBudget: { maxTurns: ${budgets.gateTurnBudget.maxTurns}, graceTurns: ${budgets.gateTurnBudget.graceTurns} },`,
		);
		blocks.push(`  timeoutMs: ${Math.min(budgets.timeoutMs, 300_000)},`);
		blocks.push(`  context: "fresh",`);
		blocks.push("})");
		blocks.push("```");
		blocks.push("");
	}

	const reportStep = lite ? 3 : 4;
	blocks.push(`## Step ${reportStep} — Report`);
	blocks.push("");
	blocks.push(
		"Read only the file-only output path(s) from the subagent results (and the gate output when present). **Do not re-read the full diff.** Write the report as a markdown message into chat:",
	);
	blocks.push("");
	blocks.push("Report contents:");
	blocks.push("- **Verdict**: `request_changes` if any blocker OR ≥3 major; `approve` if no blocker and no major; otherwise `comment`.");
	blocks.push("- Group findings by reviewer (or by dimension in lite mode); format each as `[SEVERITY · category · conf N] file:line — evidence`.");
	blocks.push(
		lite
			? "- Lite mode skips the gate — apply the verdict rule above directly to the reviewer's findings."
			: "- Add a short gate summary: verdict, reason, surviving issue count.",
	);
	blocks.push("- Cite `file:line`. Skip pre-existing issues, nitpicks, and anything a linter/typechecker/CI would catch.");
	blocks.push("");

	return blocks.join("\n");
}

function buildReviewerTask(id: string, diffPath: string, userContext?: string): string {
	const parts = [
		`Read ${diffPath} as the change to review (this is the only diff source — do not re-fetch via gh/git).`,
		"Follow your system instructions exactly.",
		"Stay within tool/turn budgets; finish by writing JSON findings to your assigned output path.",
		"Do not read plan.md, progress.md, .pi-subagents transcripts, or node_modules.",
	];
	if (id === "history-context") {
		parts.push(
			"Hard limits: ≤5 files; git log -n 5 --oneline per file; blame only for large/suspicious hunks.",
		);
	}
	if (id === "claude-md-compliance") {
		parts.push(
			"Only audit written project rules (AGENTS.md / CLAUDE.md / .pi rules / .agents/rules). If none exist, return empty issues.",
		);
	}
	if (userContext?.trim()) {
		parts.push(`User request: ${userContext.trim()}`);
	}
	return parts.join(" ");
}

function shellQuote(s: string): string {
	if (/^[a-zA-Z0-9_/:.-]+$/.test(s)) return s;
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
