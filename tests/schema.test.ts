/**
 * Tests for src/schema.ts and the validateValue helper in src/spawn.ts.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { GateOutputSchema, IssueSchema, ReviewerOutputSchema, toJsonSchema } from "../src/schema.js";
import { validateValue } from "../src/spawn.js";

describe("IssueSchema / validateValue", () => {
	test("accepts a minimal valid issue", () => {
		const v = validateValue(IssueSchema, {
			file: "src/foo.ts",
			category: "bug",
			severity: "major",
			confidence: 7,
			evidence: "null deref on line 42",
		});
		assert.equal(v.ok, true);
	});

	test("rejects unknown category", () => {
		const v = validateValue(IssueSchema, {
			file: "x",
			category: "unknown",
			severity: "major",
			confidence: 5,
			evidence: "x",
		});
		assert.equal(v.ok, false);
	});

	test("rejects unknown severity", () => {
		const v = validateValue(IssueSchema, {
			file: "x",
			category: "bug",
			severity: "fatal",
			confidence: 5,
			evidence: "x",
		});
		assert.equal(v.ok, false);
	});

	test("rejects confidence out of [1,10]", () => {
		const a = validateValue(IssueSchema, {
			file: "x",
			category: "bug",
			severity: "major",
			confidence: 11,
			evidence: "x",
		});
		assert.equal(a.ok, false);
		const b = validateValue(IssueSchema, {
			file: "x",
			category: "bug",
			severity: "major",
			confidence: 0,
			evidence: "x",
		});
		assert.equal(b.ok, false);
	});

	test("rejects extra properties (additionalProperties=false)", () => {
		const v = validateValue(IssueSchema, {
			file: "x",
			category: "bug",
			severity: "major",
			confidence: 5,
			evidence: "x",
			extraField: "nope",
		});
		assert.equal(v.ok, false);
	});

	test("rejects evidence over 280 chars", () => {
		const v = validateValue(IssueSchema, {
			file: "x",
			category: "bug",
			severity: "major",
			confidence: 5,
			evidence: "a".repeat(281),
		});
		assert.equal(v.ok, false);
	});
});

describe("ReviewerOutputSchema", () => {
	test("accepts a valid payload", () => {
		const v = validateValue(ReviewerOutputSchema, {
			issues: [
				{ file: "x.ts", category: "convention", severity: "nit", confidence: 3, evidence: "minor naming" },
			],
			summary: "1 minor naming issue",
		});
		assert.equal(v.ok, true);
	});

	test("rejects an empty issues array on a non-empty file? No — empty issues is fine.", () => {
		const v = validateValue(ReviewerOutputSchema, { issues: [], summary: "all good" });
		assert.equal(v.ok, true);
	});
});

describe("GateOutputSchema", () => {
	test("accepts a valid gate payload", () => {
		const v = validateValue(GateOutputSchema, {
			verdict: "request_changes",
			issues: [],
			reason: "two blockers",
		});
		assert.equal(v.ok, true);
	});

	test("rejects unknown verdict", () => {
		const v = validateValue(GateOutputSchema, {
			verdict: "rejected",
			issues: [],
			reason: "x",
		});
		assert.equal(v.ok, false);
	});
});

describe("toJsonSchema", () => {
	test("returns a plain object without TypeBox type brand", () => {
		const json = toJsonSchema(IssueSchema);
		assert.equal(typeof json, "object");
		assert.equal(json.type, "object");
		// IssueSchema properties must be present.
		assert.ok("properties" in json);
		const props = json.properties as Record<string, unknown>;
		assert.ok("file" in props);
		assert.ok("category" in props);
		assert.ok("severity" in props);
		assert.ok("confidence" in props);
		assert.ok("evidence" in props);
	});
});
