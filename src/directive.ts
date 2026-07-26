/**
 * Build the review directive injected into the main agent via sendUserMessage.
 *
 * The main agent executes it in its streaming loop (foreground), using the
 * `subagent` tool (from pi-subagents) to fan out reviewers + gate. This
 * replaces the old background child_process.spawn path (src/spawn.ts), so the
 * whole review is visible in chat instead of hiding behind a footer status.
 *
 * Reviewer/gate prompt bodies are NOT inlined — each subagent task references
 * the bundled prompt file by absolute path, which the child agent reads. The
 * obtain-change playbook IS inlined per reviewer, because child agents are
 * fresh processes that cannot see this directive's Target section.
 *
 * Requires: pi-subagents extension (provides the `subagent` tool).
 */
import { obtainChangePlaybook } from "./prep.js";
import { resolveAgentPromptPath, resolveGatePromptPath } from "./paths.js";
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
}

/**
 * Render the directive string. Kept pure (no ctx / no side effects) so it is
 * trivially unit-testable — see tests/directive.test.ts.
 */
export function buildReviewDirective(input: ReviewDirectiveInput): string {
	const { target, reviewers, gateModel, threshold, lite } = input;
	const playbook = obtainChangePlaybook(target);
	const blocks: string[] = [];

	blocks.push("# Code review");
	blocks.push("");
	if (target.userContext?.trim()) {
		blocks.push(`**User request:** ${target.userContext.trim()}`);
		blocks.push("");
	}
	blocks.push(
		`Review the change below (${target.label}). Use the \`subagent\` tool to fan out ${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"} in parallel${lite ? " (lite mode)" : ""}, ${lite ? "then write the report" : "then run a gate pass, then write the report"}. Run every step in the open.`,
	);
	blocks.push("");

	// Step 1 — fan out reviewers. Each task is self-contained: playbook + prompt path.
	blocks.push("## Step 1 — Fan out reviewers");
	blocks.push("");
	blocks.push(
		"Call the `subagent` tool ONCE with all reviewers as parallel tasks. Each task below already embeds the change-obtaining steps and the reviewer's prompt path — pass them verbatim:",
	);
	blocks.push("");
	blocks.push("```js");
	blocks.push("subagent({");
	blocks.push("  tasks: [");
	for (const r of reviewers) {
		const promptPath = resolveAgentPromptPath(r.id);
		const task = `${playbook}\n\nThen read ${promptPath} and follow its instructions exactly to review the change.`;
		blocks.push(`    { output: ${JSON.stringify(r.id)}, task: ${JSON.stringify(task)} },`);
	}
	blocks.push("  ],");
	blocks.push(`  concurrency: ${reviewers.length}`);
	blocks.push("})");
	blocks.push("```");
	blocks.push("");

	// Step 2 — gate (skipped in lite mode).
	if (!lite) {
		blocks.push("## Step 2 — Gate");
		blocks.push("");
		blocks.push("After all reviewers return, call `subagent` once more to synthesize with the gate model:");
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

	// Report step (numbered 2 in lite, 3 otherwise).
	const reportStep = lite ? 2 : 3;
	blocks.push(`## Step ${reportStep} — Report`);
	blocks.push("");
	blocks.push("Write a single markdown report:");
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
