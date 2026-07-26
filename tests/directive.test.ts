import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { buildReviewDirective } from "../src/directive.js";
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

const DIMENSIONS = ["bugbot", "security-review", "claude-md-compliance", "code-comments", "history-context"];

describe("buildReviewDirective", () => {
	const reviewers = DIMENSIONS.map(fakeReviewer);

	test("fan-out: main agent obtains diff, 5 reviewers read it, gate + report", () => {
		const d = buildReviewDirective({
			target: fakeTarget(),
			reviewers,
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 8,
			lite: false,
		});
		// Step 1 — main agent writes the shared diff file.
		assert.match(d, /Step 1 — Obtain the change/);
		assert.match(d, /git diff HEAD > \S*\/tmp\/pi-review-change\.diff/);
		// Step 2 — every reviewer reads that file + its own prompt.
		assert.match(d, /Step 2 — Fan out reviewers/);
		assert.match(d, /concurrency: 5/);
		for (const id of DIMENSIONS) {
			assert.match(d, new RegExp(`Read /tmp/pi-review-change\\.diff`));
			assert.match(d, new RegExp(`agents/${id}\\.md`));
		}
		// Step 3 — gate with model + threshold.
		assert.match(d, /Step 3 — Gate/);
		assert.match(d, /model: "anthropic\/claude-haiku-4-5"/);
		assert.match(d, /confidence < 8/);
		// Workflow checklist (todo-ize the flow before executing).
		assert.match(d, /- \[ \] Obtain the diff/);
		assert.match(d, /- \[ \] Fan out 5 reviewers/);
		assert.match(d, /- \[ \] Run the gate pass/);
		assert.match(d, /- \[ \] Write the report/);
		// Step 4 — report.
		assert.match(d, /Step 4 — Report/);
	});

	test("lite: obtain + single reviewer + no gate + report is step 3", () => {
		const d = buildReviewDirective({
			target: fakeTarget(),
			reviewers: [fakeReviewer("lite-review")],
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 8,
			lite: true,
		});
		assert.match(d, /Step 1 — Obtain the change/);
		assert.match(d, /concurrency: 1/);
		assert.match(d, /agents\/lite-review\.md/);
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
		});
		assert.match(d, /\*\*User request:\*\* focus on concurrency and secrets/);
	});

	test("gate model override flows into step 3", () => {
		const d = buildReviewDirective({
			target: fakeTarget(),
			reviewers,
			gateModel: "anthropic/claude-sonnet-4-6",
			threshold: 8,
			lite: false,
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
		});
		assert.match(d, /gh pr diff https:\/\/github\.com\/o\/r\/pull\/99 > \S*\/tmp\/pi-review-change\.diff/);
	});
});
