/**
 * Tests for deterministic gate post-process.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
	computeVerdict,
	dedupeIssues,
	enforceGateOutput,
	filterByThreshold,
} from "../src/gate-enforce.js";
import type { Issue } from "../src/types.js";

function issue(partial: Partial<Issue> & Pick<Issue, "file" | "severity" | "confidence">): Issue {
	return {
		category: "bug",
		evidence: "evidence",
		...partial,
	};
}

describe("dedupeIssues", () => {
	test("keeps highest confidence for same file/line/category", () => {
		const out = dedupeIssues([
			issue({ file: "a.ts", line: 1, confidence: 5, severity: "minor", evidence: "low" }),
			issue({ file: "a.ts", line: 1, confidence: 9, severity: "major", evidence: "high" }),
		]);
		assert.equal(out.length, 1);
		assert.equal(out[0]!.confidence, 9);
	});
});

describe("filterByThreshold", () => {
	test("drops below floor", () => {
		const out = filterByThreshold(
			[
				issue({ file: "a.ts", confidence: 7, severity: "major" }),
				issue({ file: "b.ts", confidence: 8, severity: "major" }),
			],
			8,
		);
		assert.equal(out.length, 1);
		assert.equal(out[0]!.file, "b.ts");
	});
});

describe("computeVerdict", () => {
	test("request_changes on blocker", () => {
		assert.equal(
			computeVerdict([issue({ file: "a.ts", confidence: 9, severity: "blocker" })]),
			"request_changes",
		);
	});

	test("request_changes on ≥3 majors", () => {
		assert.equal(
			computeVerdict([
				issue({ file: "a.ts", confidence: 8, severity: "major" }),
				issue({ file: "b.ts", confidence: 8, severity: "major" }),
				issue({ file: "c.ts", confidence: 8, severity: "major" }),
			]),
			"request_changes",
		);
	});

	test("comment on 1–2 majors", () => {
		assert.equal(
			computeVerdict([issue({ file: "a.ts", confidence: 8, severity: "major" })]),
			"comment",
		);
	});

	test("approve when empty or only minor/nit", () => {
		assert.equal(computeVerdict([]), "approve");
		assert.equal(
			computeVerdict([issue({ file: "a.ts", confidence: 9, severity: "nit" })]),
			"approve",
		);
	});
});

describe("enforceGateOutput", () => {
	test("overrides LLM approve when blockers remain above threshold", () => {
		const out = enforceGateOutput(
			{
				issues: [issue({ file: "a.ts", confidence: 9, severity: "blocker" })],
				reason: "looks fine",
			},
			8,
		);
		assert.equal(out.verdict, "request_changes");
		assert.equal(out.issues.length, 1);
	});

	test("drops low-confidence issues then approves", () => {
		const out = enforceGateOutput(
			{
				issues: [issue({ file: "a.ts", confidence: 3, severity: "blocker" })],
				reason: "noise",
			},
			8,
		);
		assert.equal(out.verdict, "approve");
		assert.equal(out.issues.length, 0);
	});
});
