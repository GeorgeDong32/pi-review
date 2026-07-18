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

	test("defaults", () => {
		const p = parseReviewArgs("");
		assert.equal(p.noGate, false);
		assert.equal(p.noSpawn, false);
		assert.deepEqual(p.reviewers, []);
	});
});
