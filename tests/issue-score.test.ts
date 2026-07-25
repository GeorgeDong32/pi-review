/**
 * Tests for per-issue scoring selection helpers.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { selectIssuesForScoring } from "../src/issue-score.js";
import type { Issue } from "../src/types.js";

const ISSUES: Issue[] = [
	{ file: "a.ts", category: "bug", severity: "blocker", confidence: 9, evidence: "b" },
	{ file: "b.ts", category: "bug", severity: "major", confidence: 8, evidence: "m" },
	{ file: "c.ts", category: "docs", severity: "nit", confidence: 8, evidence: "n" },
];

describe("selectIssuesForScoring", () => {
	test("off selects none", () => {
		assert.equal(selectIssuesForScoring(ISSUES, "off").length, 0);
	});

	test("blocker-major selects high severity only", () => {
		const out = selectIssuesForScoring(ISSUES, "blocker-major");
		assert.equal(out.length, 2);
		assert.deepEqual(
			out.map((i) => i.severity),
			["blocker", "major"],
		);
	});

	test("all selects every issue", () => {
		assert.equal(selectIssuesForScoring(ISSUES, "all").length, 3);
	});
});
