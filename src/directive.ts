/**
 * Build the review directive injected into the main agent (hidden, via
 * `sendMessage` with `display:false` + `triggerTurn:true` — see index.ts).
 *
 * v2 flow: the MAIN AGENT obtains the diff once and writes it to a temp file
 * (Step 1), then fans out reviewers that all read that same file (Step 2) —
 * avoiding N redundant gh/git fetches and keeping the obtain step visible in
 * chat. Gate (Step 3) and report (Step 4) follow.
 *
 * Requires: pi-subagents extension (provides the `subagent` tool).
 */
import { resolveAgentPromptPath, resolveGatePromptPath } from "./paths.js";
import type { ReviewerSpec, ReviewTarget } from "./types.js";

/** Shared diff file the main agent writes and every reviewer reads. */
const DIFF_FILE = "/tmp/pi-review-change.diff";

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
}

/**
 * Render the directive string. Kept pure (no ctx / no side effects) so it is
 * trivially unit-testable — see tests/directive.test.ts.
 */
export function buildReviewDirective(input: ReviewDirectiveInput): string {
	const { target, reviewers, gateModel, threshold, lite } = input;
	const blocks: string[] = [];

	blocks.push("# Code review");
	blocks.push("");
	if (target.userContext?.trim()) {
		blocks.push(`**User request:** ${target.userContext.trim()}`);
		blocks.push("");
	}
	blocks.push(
		`Review the change (${target.label}). You obtain the diff once, then fan out ${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"}${lite ? " (lite mode)" : ""}, ${lite ? "then write the report" : "then run a gate pass, then write the report"}. Run every step in the open.`,
	);
	blocks.push("");

	// First, lay out the workflow as a checklist so nothing gets skipped.
	blocks.push(
		"First, post the workflow as a markdown checklist into chat, then work through it — flip each `- [ ]` to `- [x]` as you finish it. This keeps the plan visible and prevents skipped steps.",
	);
	blocks.push("");
	const todoSteps = lite
		? [
				"Obtain the diff → /tmp/pi-review-change.diff",
				"Fan out a single lite-reviewer (subagent)",
				"Write the report into chat",
			]
		: [
				"Obtain the diff → /tmp/pi-review-change.diff",
				`Fan out ${reviewers.length} reviewers (subagent)`,
				"Run the gate pass (subagent)",
				"Write the report into chat",
			];
	for (const s of todoSteps) blocks.push(`- [ ] ${s}`);
	blocks.push("");

	// Step 1 — main agent obtains the diff and writes it to a shared temp file.
	blocks.push("## Step 1 — Obtain the change (you, the main agent)");
	blocks.push("");
	blocks.push(`Save the full diff to \`${DIFF_FILE}\`:`);
	blocks.push("");
	if (target.kind === "pr" && target.prRef) {
		blocks.push(`- \`gh pr diff ${target.prRef} > ${DIFF_FILE}\``);
		blocks.push(
			`- If that fails (too_large / HTTP 406), fall back to git: fetch the PR head, then \`git diff <default-branch>...<pr-head> > ${DIFF_FILE}\`.`,
		);
	} else {
		blocks.push(
			`- Dirty tree: \`git diff HEAD > ${DIFF_FILE}\` (add untracked files if relevant).`,
		);
		blocks.push(
			`- Clean tree: \`git diff <default-branch>...HEAD > ${DIFF_FILE}\` (detect the default branch via \`git symbolic-ref refs/remotes/origin/HEAD\`).`,
		);
	}
	blocks.push(`- Verify \`${DIFF_FILE}\` is non-empty before continuing.`);
	blocks.push("");

	// Step 2 — fan out reviewers, each reading the shared diff + its prompt.
	blocks.push("## Step 2 — Fan out reviewers");
	blocks.push("");
	blocks.push(
		"Call the `subagent` tool ONCE with all reviewers as parallel tasks. Each reads the diff you just saved plus its own prompt file:",
	);
	blocks.push("");
	blocks.push("```js");
	blocks.push("subagent({");
	blocks.push("  tasks: [");
	for (const r of reviewers) {
		const promptPath = resolveAgentPromptPath(r.id);
		const task = `Read ${DIFF_FILE} as the change to review. Then read ${promptPath} and follow its instructions exactly.`;
		blocks.push(`    { output: ${JSON.stringify(r.id)}, task: ${JSON.stringify(task)} },`);
	}
	blocks.push("  ],");
	blocks.push(`  concurrency: ${reviewers.length}`);
	blocks.push("})");
	blocks.push("```");
	blocks.push("");

	// Step 3 — gate (skipped in lite mode).
	if (!lite) {
		blocks.push("## Step 3 — Gate");
		blocks.push("");
		blocks.push(
			"After all reviewers return, call `subagent` once more to synthesize with the gate model:",
		);
		blocks.push("");
		const gateTask = `Read ${resolveGatePromptPath()} and follow its instructions. Synthesize the reviewer findings: dedupe by (file, line, category), re-score each issue 1-10, and drop any with confidence < ${threshold}. Return the surviving issues and a verdict.`;
		blocks.push("```js");
		blocks.push("subagent({");
		blocks.push(`  task: ${JSON.stringify(gateTask)},`);
		blocks.push(`  model: ${JSON.stringify(gateModel)}`);
		blocks.push("})");
		blocks.push("```");
		blocks.push("");
	}

	// Report is step 3 in lite (gate skipped), step 4 otherwise.
	const reportStep = lite ? 3 : 4;
	blocks.push(`## Step ${reportStep} — Report`);
	blocks.push("");
	blocks.push("Write the report as a markdown message into chat:");
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
