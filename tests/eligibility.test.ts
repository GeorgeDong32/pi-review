import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { checkEligibility, isTrivialDiff } from "../src/eligibility.js";

describe("checkEligibility", () => {
	test("rejects empty diff without explicit path", () => {
		const r = checkEligibility({ resolved: null, hasExplicitInput: false, isGitRepo: true });
		assert.equal(r.eligible, false);
		if (!r.eligible) assert.match(r.reason, /empty/i);
	});

	test("rejects non-git without path", () => {
		const r = checkEligibility({ resolved: null, hasExplicitInput: false, isGitRepo: false });
		assert.equal(r.eligible, false);
	});

	test("accepts non-empty diff", () => {
		const r = checkEligibility({
			resolved: {
				content: [
					"diff --git a/foo.ts b/foo.ts",
					"--- a/foo.ts",
					"+++ b/foo.ts",
					"@@ -1,3 +1,6 @@",
					" line1",
					"+added1",
					"+added2",
					"+added3",
				].join("\n"),
				source: { kind: "uncommitted" },
				label: "test",
			},
			hasExplicitInput: false,
			isGitRepo: true,
		});
		assert.equal(r.eligible, true);
	});
});

describe("isTrivialDiff", () => {
	test("empty is trivial", () => {
		assert.equal(isTrivialDiff(""), true);
	});

	test("few lines is trivial", () => {
		assert.equal(isTrivialDiff("--- a\n+++ b\n+one\n"), true);
	});
});
