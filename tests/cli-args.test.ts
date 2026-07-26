import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { parseReviewArgs } from "../src/cli-args.js";

describe("parseReviewArgs", () => {
	test("parses flags and freeform input (CC-style)", () => {
		const p = parseReviewArgs(
			"--threshold 7 --reviewer bugbot --no-gate https://github.com/org/repo/pull/42",
		);
		assert.equal(p.threshold, 7);
		assert.deepEqual(p.reviewers, ["bugbot"]);
		assert.equal(p.noGate, true);
		assert.equal(p.input, "https://github.com/org/repo/pull/42");
		assert.equal(p.diffPath, undefined);
	});

	test("parses --diff for explicit diff files", () => {
		const p = parseReviewArgs("--diff @./changes.patch");
		assert.equal(p.diffPath, "@./changes.patch");
		assert.equal(p.input, undefined);
	});

	test("joins remaining tokens into input", () => {
		const p = parseReviewArgs("review PR 17206 for backup changes");
		assert.equal(p.input, "review PR 17206 for backup changes");
	});

	test("clamps --threshold to 0–10", () => {
		assert.equal(parseReviewArgs("--threshold 99").threshold, 10);
		assert.equal(parseReviewArgs("--threshold -3").threshold, 0);
	});

	test("parses --score-per-issue", () => {
		assert.equal(parseReviewArgs("--score-per-issue off").scorePerIssue, "off");
		assert.equal(
			parseReviewArgs("--score-per-issue blocker-major").scorePerIssue,
			"blocker-major",
		);
		assert.equal(parseReviewArgs("--score-per-issue all").scorePerIssue, "all");
	});
});
