/**
 * Tests for src/report.ts: verdict line, per-reviewer sections, totals.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { buildReport, renderReport } from "../src/report.js";
import type { GateRunResult, ReviewerRunResult } from "../src/types.js";

const INPUT = {
	content: "diff",
	source: { kind: "uncommitted" as const },
	label: "uncommitted changes",
};

const OK_REVIEWER: ReviewerRunResult = {
	id: "bug-detector",
	label: "Bug Detector",
	model: "anthropic/claude-sonnet-4-6",
	ok: true,
	output: {
		issues: [
			{ file: "src/x.ts", line: 10, category: "bug", severity: "major", confidence: 8, evidence: "race" },
			{ file: "src/x.ts", line: 20, category: "convention", severity: "nit", confidence: 3, evidence: "naming" },
		],
		summary: "1 race, 1 nit",
	},
	durationMs: 12_300,
};

const FAILED_REVIEWER: ReviewerRunResult = {
	id: "conventions",
	label: "Conventions",
	model: "anthropic/claude-sonnet-4-6",
	ok: false,
	error: "timeout after 180000ms",
	exitCode: null,
	durationMs: 180_000,
};

describe("buildReport", () => {
	test("verdict is 'error' when all reviewers failed", () => {
		const report = buildReport({
			startedAt: 0,
			reviewers: [FAILED_REVIEWER, { ...FAILED_REVIEWER, id: "x" }],
			gate: null,
			input: INPUT,
		});
		assert.equal(report.verdict, "error");
	});

	test("verdict is 'no-gate' when gate missing/failed", () => {
		const report = buildReport({
			startedAt: 0,
			reviewers: [OK_REVIEWER],
			gate: null,
			input: INPUT,
		});
		assert.equal(report.verdict, "no-gate");
	});

	test("verdict reflects gate when present and ok", () => {
		const gate: GateRunResult = {
			ok: true,
			model: "haiku",
			verdict: { verdict: "request_changes", issues: [], reason: "blockers" },
			durationMs: 5000,
		};
		const report = buildReport({
			startedAt: 0,
			reviewers: [OK_REVIEWER],
			gate,
			input: INPUT,
		});
		assert.equal(report.verdict, "request_changes");
	});

	test("totals use gate's deduped issues when present", () => {
		const gate: GateRunResult = {
			ok: true,
			model: "haiku",
			verdict: {
				verdict: "request_changes",
				issues: [
					{ file: "a", category: "bug", severity: "blocker", confidence: 9, evidence: "x" },
					{ file: "b", category: "convention", severity: "minor", confidence: 4, evidence: "y" },
				],
				reason: "x",
			},
			durationMs: 1000,
		};
		const report = buildReport({
			startedAt: 0,
			reviewers: [OK_REVIEWER],
			gate,
			input: INPUT,
		});
		assert.equal(report.totals.issues, 2);
		assert.equal(report.totals.bySeverity.blocker, 1);
		assert.equal(report.totals.bySeverity.minor, 1);
	});

	test("totals fall back to reviewer sums when gate absent", () => {
		const report = buildReport({
			startedAt: 0,
			reviewers: [OK_REVIEWER],
			gate: null,
			input: INPUT,
		});
		assert.equal(report.totals.issues, 2);
		assert.equal(report.totals.bySeverity.major, 1);
		assert.equal(report.totals.bySeverity.nit, 1);
	});
});

describe("renderReport", () => {
	test("includes verdict header", () => {
		const report = buildReport({
			startedAt: 0,
			reviewers: [OK_REVIEWER],
			gate: null,
			input: INPUT,
		});
		const md = renderReport(report);
		assert.ok(md.includes("## pi-review — uncommitted changes"));
		assert.ok(md.includes("**Verdict: NO GATE**"));
	});

	test("includes per-reviewer sections", () => {
		const report = buildReport({
			startedAt: 0,
			reviewers: [OK_REVIEWER, FAILED_REVIEWER],
			gate: null,
			input: INPUT,
		});
		const md = renderReport(report);
		assert.ok(md.includes("### bug-detector (anthropic/claude-sonnet-4-6) — ok"));
		assert.ok(md.includes("### conventions (anthropic/claude-sonnet-4-6) — failed"));
		assert.ok(md.includes("timeout"));
	});

	test("includes gate section when present", () => {
		const gate: GateRunResult = {
			ok: true,
			model: "haiku",
			verdict: { verdict: "approve", issues: [], reason: "all clear" },
			durationMs: 1000,
		};
		const report = buildReport({
			startedAt: 0,
			reviewers: [OK_REVIEWER],
			gate,
			input: INPUT,
		});
		const md = renderReport(report);
		assert.ok(md.includes("### gate (haiku)"));
		assert.ok(md.includes("verdict: approve"));
	});

	test("includes failed gate error message", () => {
		const gate: GateRunResult = {
			ok: false,
			model: "haiku",
			error: "schema validation failed: issues[0].severity",
			durationMs: 1000,
		};
		const report = buildReport({
			startedAt: 0,
			reviewers: [OK_REVIEWER],
			gate,
			input: INPUT,
		});
		const md = renderReport(report);
		assert.ok(md.includes("### gate (haiku) — failed"));
		assert.ok(md.includes("schema validation failed"));
	});

	test("summary line includes counts", () => {
		const report = buildReport({
			startedAt: 0,
			reviewers: [OK_REVIEWER, FAILED_REVIEWER],
			gate: null,
			input: INPUT,
		});
		const md = renderReport(report);
		assert.ok(md.includes("2 reviewers · 0 gate"));
	});
});
