import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { buildReviewDirective, DIFF_REL_PATH, diffFilePath } from "../src/directive.js";
import { leanAgentName, LEAN_BUDGETS, LEAN_GATE_AGENT } from "../src/lean-agents.js";
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

	test("fan-out: lean agents + budgets + file-only + no builtin reviewer", () => {
		const d = buildReviewDirective({
			target: fakeTarget(),
			reviewers,
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 8,
			lite: false,
			cwd: CWD,
		});
		// Step 1 — write-only diff under cwd (not /tmp).
		assert.match(d, /Step 1 — Obtain the change/);
		assert.match(d, new RegExp(DIFF_REL_PATH.replace(/\./g, "\\.")));
		assert.match(d, /Do not read, cat, or summarize the diff/);
		assert.doesNotMatch(d, /\/tmp\/pi-review-change\.diff/);

		// Step 2 — lean agents + budgets.
		assert.match(d, /Step 2 — Fan out lean reviewers/);
		assert.match(d, /concurrency: 4/); // min(5, 4)
		assert.match(d, /turnBudget: \{ maxTurns: 12, graceTurns: 2 \}/);
		assert.match(d, /timeoutMs: 600000/);
		assert.match(d, /context: "fresh"/);
		assert.match(d, /do not substitute the builtin `reviewer`/);

		for (const id of DIMENSIONS) {
			assert.match(d, new RegExp(`agent: "${leanAgentName(id)}"`));
			assert.match(d, new RegExp(`output: "${id}"`));
		}
		assert.match(d, /outputMode: "file-only"/);
		assert.match(d, /reads: false/);
		assert.match(d, /acceptance: false/);
		assert.match(d, /toolBudget: \{ soft: 15, hard: 25 \}/);
		assert.match(d, /toolBudget: \{ soft: 10, hard: 18 \}/); // history
		// Task embeds diff path; does NOT tell child to re-read agents/*.md.
		assert.match(d, new RegExp(`Read ${diffFilePath(CWD).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.doesNotMatch(d, /agents\/bugbot\.md/);

		// Step 3 — gate lean agent.
		assert.match(d, /Step 3 — Gate/);
		assert.match(d, new RegExp(`agent: "${LEAN_GATE_AGENT}"`));
		assert.match(d, /model: "anthropic\/claude-haiku-4-5"/);
		assert.match(d, /confidence < 8|Threshold: 8/);
		assert.match(
			d,
			new RegExp(
				`turnBudget: \\{ maxTurns: ${LEAN_BUDGETS.gateTurnBudget.maxTurns}, graceTurns: ${LEAN_BUDGETS.gateTurnBudget.graceTurns} \\}`,
			),
		);

		// Checklist + report.
		assert.match(d, /- \[ \] Obtain the diff/);
		assert.match(d, /- \[ \] Fan out 5 lean reviewers/);
		assert.match(d, /- \[ \] Run the gate pass/);
		assert.match(d, /- \[ \] Write the report/);
		assert.match(d, /Step 4 — Report/);
		assert.match(d, /Do not re-read the full diff/);
	});

	test("lite: obtain + single lean reviewer + no gate + report is step 3", () => {
		const d = buildReviewDirective({
			target: fakeTarget(),
			reviewers: [fakeReviewer("lite-review")],
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 8,
			lite: true,
			cwd: CWD,
		});
		assert.match(d, /Step 1 — Obtain the change/);
		assert.match(d, /concurrency: 1/);
		assert.match(d, new RegExp(`agent: "${leanAgentName("lite-review")}"`));
		assert.doesNotMatch(d, /agents\/lite-review\.md/);
		assert.match(d, /- \[ \] Fan out a single lite-reviewer/);
		assert.doesNotMatch(d, /Step 3 — Gate/);
		assert.match(d, /Step 3 — Report/);
		assert.match(d, /Lite mode skips the gate/);
	});

	test("injects user request from target.userContext", () => {
		const d = buildReviewDirective({
			target: fakeTarget({ userContext: "focus on concurrency and secrets" }),
			reviewers,
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 8,
			lite: false,
			cwd: CWD,
		});
		assert.match(d, /\*\*User request:\*\* focus on concurrency and secrets/);
		assert.match(d, /User request: focus on concurrency and secrets/);
	});

	test("gate model override flows into step 3", () => {
		const d = buildReviewDirective({
			target: fakeTarget(),
			reviewers,
			gateModel: "anthropic/claude-sonnet-4-6",
			threshold: 8,
			lite: false,
			cwd: CWD,
		});
		assert.match(d, /model: "anthropic\/claude-sonnet-4-6"/);
	});

	test("PR target puts `gh pr diff` in step 1 (not per-reviewer)", () => {
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
		assert.match(d, /gh pr diff https:\/\/github\.com\/o\/r\/pull\/99 >/);
		assert.match(d, new RegExp(diffFilePath(CWD).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});
});

describe("leanAgentName", () => {
	test("namespaces under pi-review", () => {
		assert.equal(leanAgentName("bugbot"), "pi-review.bugbot");
		assert.equal(LEAN_GATE_AGENT, "pi-review.gate");
	});
});
