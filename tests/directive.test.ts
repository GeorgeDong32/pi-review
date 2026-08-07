import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
	buildReviewDirective,
	DIFF_REL_PATH,
	FILES_REL_PATH,
	diffFilePath,
} from "../src/directive.js";
import {
	leanAgentName,
	LEAN_BUDGETS,
	LEAN_GATE_AGENT,
	resolveLeanBudgets,
	withThinkingSuffix,
} from "../src/lean-agents.js";
import type { ReviewerSpec, ReviewTarget } from "../src/types.js";

function fakeTarget(overrides: Partial<ReviewTarget> = {}): ReviewTarget {
	return {
		kind: "local-git",
		label: "uncommitted changes",
		hint: "Working tree is dirty. Use git status then git diff HEAD.",
		...overrides,
	};
}

function fakeReviewer(id: string): ReviewerSpec {
	return { id, label: id, enabled: true, model: "inherit" };
}

const CWD = "/tmp/pi-review-test-cwd";
const DIMENSIONS = ["bugbot", "security-review", "claude-md-compliance", "code-comments", "history-context"];

describe("buildReviewDirective", () => {
	const reviewers = DIMENSIONS.map(fakeReviewer);

	test("fan-out: lean agents + budgets + single-wave rules + file list", () => {
		const d = buildReviewDirective({
			target: fakeTarget(),
			reviewers,
			gateModel: "anthropic/claude-haiku-4-5",
			gateThinking: "low",
			threshold: 8,
			lite: false,
			cwd: CWD,
		});
		assert.match(d, /Step 1 — Obtain the change/);
		assert.match(d, new RegExp(DIFF_REL_PATH.replace(/\./g, "\\.")));
		assert.match(d, new RegExp(FILES_REL_PATH.replace(/\./g, "\\.")));
		assert.match(d, /change-kind/);
		assert.match(d, /Do not read, cat, or summarize the diff/);
		assert.doesNotMatch(d, /\/tmp\/pi-review-change\.diff/);

		assert.match(d, /exactly one/);
		assert.match(d, /Do not retry/);
		assert.match(d, /never one call per reviewer/);

		assert.match(d, /Step 2 — Run the review/);
		// workflowScript API shape (pi-subagents ≥0.41). The script body is
		// JSON-stringified inside the directive, so inner quotes appear as \\".
		assert.match(d, /workflowScript:/);
		assert.match(d, /runs\.all\(\[/);
		assert.match(d, /runs\.run\(\\"gate\\"/);
		assert.match(d, /async: false/);
		assert.match(d, /context: "fresh"/);
		assert.match(d, /turnBudget: \{ maxTurns: 20, graceTurns: 2 \}/);
		assert.match(d, /do not substitute builtin `reviewer`/);
		// Legacy top-level inputs must NOT appear (they are rejected at runtime).
		assert.doesNotMatch(d, /\breads:/);
		assert.doesNotMatch(d, /tasks:\s*\[/);
		assert.doesNotMatch(d, /concurrency:/);
		assert.doesNotMatch(d, /outputMode: "file-only"/);
		assert.doesNotMatch(d, /acceptance: false/);

		for (const id of DIMENSIONS) {
			// Inside the JSON-stringified workflowScript, quotes appear as \\".
			assert.match(d, new RegExp(`agent: \\\\"${leanAgentName(id)}\\\\"`));
		}
		// Per-child tool budgets are injected onto each runs.all item.
		assert.match(d, /toolBudget: \{ soft: 20, hard: 32 \}/);
		assert.match(d, /toolBudget: \{ soft: 14, hard: 24 \}/);
		assert.doesNotMatch(d, /agents\/bugbot\.md/);

		// Gate is inlined inside the workflow script (no separate Step 3).
		assert.doesNotMatch(d, /Step 3 — Gate/);
		assert.match(d, new RegExp(`agent: \\\\"${LEAN_GATE_AGENT}\\\\"`));
		assert.match(d, /model: \\"anthropic\/claude-haiku-4-5:low\\"/);
		assert.match(d, /Threshold: 8/);
		assert.match(d, /Reviewer findings are inlined below/);
		assert.match(d, /Do not re-read the full diff/);
		assert.match(d, /Step 3 — Report/);
	});

	test("lite: one subagent max, no gate", () => {
		const d = buildReviewDirective({
			target: fakeTarget(),
			reviewers: [fakeReviewer("lite-review")],
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 8,
			lite: true,
			cwd: CWD,
		});
		assert.match(d, /exactly one/);
		assert.match(d, new RegExp(`agent: \\\\"${leanAgentName("lite-review")}\\\\"`));
		assert.match(d, /runs\.all\(\[/);
		assert.doesNotMatch(d, /Step 3 — Gate/);
		assert.match(d, /Step 3 — Report/);
	});

	test("injects user request", () => {
		const d = buildReviewDirective({
			target: fakeTarget({ userContext: "focus on concurrency and secrets" }),
			reviewers,
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 8,
			lite: false,
			cwd: CWD,
		});
		assert.match(d, /\*\*User request:\*\* focus on concurrency and secrets/);
	});

	test("PR target puts gh pr diff in step 1", () => {
		const d = buildReviewDirective({
			target: fakeTarget({
				kind: "pr",
				label: "PR 99",
				prRef: "https://github.com/o/r/pull/99",
				hint: "",
			}),
			reviewers,
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 8,
			lite: false,
			cwd: CWD,
		});
		assert.match(d, /gh pr diff 'https:\/\/github\.com\/o\/r\/pull\/99'/);
		assert.match(d, /git fetch origin/);
		assert.match(d, /pull\/\$PR_NUM\/head/);
		assert.match(d, new RegExp(diffFilePath(CWD).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});

	test("local Step 1 fetches remote base before three-dot", () => {
		const d = buildReviewDirective({
			target: fakeTarget(),
			reviewers,
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 8,
			lite: false,
			cwd: CWD,
		});
		assert.match(d, /fetch the remote default branch first/);
		assert.match(d, /git fetch origin "\$BASE"/);
		assert.match(d, /origin\/\$BASE/);
		assert.match(d, /diff-meta/);
	});

	test("budget override flows into turnBudget", () => {
		const d = buildReviewDirective({
			target: fakeTarget(),
			reviewers,
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 8,
			lite: false,
			cwd: CWD,
			budgets: resolveLeanBudgets({ turnBudget: { maxTurns: 24, graceTurns: 2 } }),
		});
		assert.match(d, /turnBudget: \{ maxTurns: 24, graceTurns: 2 \}/);
	});
});

describe("lean helpers", () => {
	test("leanAgentName namespaces under pi-review", () => {
		assert.equal(leanAgentName("bugbot"), "pi-review.bugbot");
		assert.equal(LEAN_GATE_AGENT, "pi-review.gate");
	});

	test("default turnBudget is 20", () => {
		assert.equal(LEAN_BUDGETS.turnBudget.maxTurns, 20);
	});

	test("withThinkingSuffix", () => {
		assert.equal(withThinkingSuffix("anthropic/claude-haiku-4-5", "low"), "anthropic/claude-haiku-4-5:low");
		assert.equal(withThinkingSuffix("anthropic/claude-haiku-4-5:medium", "low"), "anthropic/claude-haiku-4-5:low");
		assert.equal(withThinkingSuffix("anthropic/claude-haiku-4-5", undefined), "anthropic/claude-haiku-4-5");
	});
});
