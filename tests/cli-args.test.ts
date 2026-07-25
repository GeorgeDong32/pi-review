import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { parseReviewArgs } from "../src/cli-args.js";

describe("parseReviewArgs", () => {
	test("parses flags and path", () => {
		const p = parseReviewArgs("--threshold 7 --reviewer bugbot --no-gate ./foo.diff");
		assert.equal(p.threshold, 7);
		assert.deepEqual(p.reviewers, ["bugbot"]);
		assert.equal(p.noGate, true);
		assert.equal(p.path, "./foo.diff");
	});

	test("parses @file path", () => {
		const p = parseReviewArgs("@./changes.patch");
		assert.equal(p.path, "@./changes.patch");
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
