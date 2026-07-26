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

	test("fan-out mode: lists 5 reviewers + gate with model + threshold", () => {
		const d = buildReviewDirective({
			target: fakeTarget(),
			reviewers,
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 8,
			lite: false,
		});
		assert.match(d, /Step 1 — Fan out reviewers/);
		assert.match(d, /concurrency: 5/);
		for (const id of DIMENSIONS) {
			assert.match(d, new RegExp(`agents/${id}\\.md`));
		}
		assert.match(d, /Step 2 — Gate/);
		assert.match(d, /model: "anthropic\/claude-haiku-4-5"/);
		assert.match(d, /confidence < 8/);
		assert.match(d, /Step 3 — Report/);
	});

	test("lite mode: single reviewer, no gate, report is step 2", () => {
		const d = buildReviewDirective({
			target: fakeTarget(),
			reviewers: [fakeReviewer("lite-review")],
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 8,
			lite: true,
		});
		assert.match(d, /concurrency: 1/);
		assert.match(d, /agents\/lite-review\.md/);
		assert.doesNotMatch(d, /Step 2 — Gate/);
		assert.match(d, /Step 2 — Report/);
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

	test("gate model override flows into step 2", () => {
		const d = buildReviewDirective({
			target: fakeTarget(),
			reviewers,
			gateModel: "anthropic/claude-sonnet-4-6",
			threshold: 8,
			lite: false,
		});
		assert.match(d, /model: "anthropic\/claude-sonnet-4-6"/);
	});

	test("PR target embeds gh obtain commands in each reviewer task", () => {
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
		assert.match(d, /gh pr (view|diff)/);
	});
});
