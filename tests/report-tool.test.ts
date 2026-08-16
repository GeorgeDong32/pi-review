/**
 * Tests for src/report-tool.ts — the pi_review_report tool logic.
 *
 * Two real regressions found during local E2E (v0.7):
 *  - the tool relied on process.cwd() to find the run manifest; callers must
 *    be able to pass cwd explicitly.
 *  - gate finalConfidence re-scores were ignored, so a reviewer-reported conf
 *    7 major that the gate verified to 8 was still dropped at threshold 8.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { runReportTool } from "../src/report-tool.js";
import { ensureRunDir, writeManifest } from "../src/review-report.js";
import type { RunManifest } from "../src/review-report.js";

let sandbox: string;
afterEach(() => {
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
	sandbox = "";
});

function setupManifest(): { cwd: string; runId: string; manifest: RunManifest } {
	const cwd = mkdtempSync(join(tmpdir(), "pi-review-tool-"));
	sandbox = cwd;
	const runId = "tool-e2e";
	const runDir = ensureRunDir(cwd, runId);
	const manifest: RunManifest = {
		runId,
		targetLabel: "local changes",
		targetKind: "local-git",
		diffPath: join(runDir, "change.diff"),
		diffSha256: "a".repeat(64),
		changedFiles: ["a.ts"],
		docsOnly: false,
		rulePaths: [],
		historyAvailable: true,
		mode: "local-uncommitted",
		workspacePath: cwd,
		runDir,
		createdAt: Date.now(),
	};
	writeManifest(runDir, manifest);
	return { cwd, runId, manifest };
}

const MAJOR_ISSUE = {
	file: "a.ts",
	line: 4,
	relatedChangedLine: 4,
	category: "bug" as const,
	severity: "major" as const,
	confidence: 7,
	evidence: "null deref",
	fingerprint: "a.ts:4:bug:null",
};

describe("runReportTool", () => {
	test("finds the manifest via explicit cwd (not process.cwd)", () => {
		const { cwd, runId } = setupManifest();
		const res = runReportTool({
			runId,
			cwd,
			workflowReturn: { reviewers: [], gate: null },
		});
		assert.equal(res.ok, true);
	});

	test("gate finalConfidence re-score is applied (7 -> 8 survives threshold 8)", () => {
		const { cwd, runId } = setupManifest();
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			workflowReturn: {
				reviewers: [
					{
						key: "bugbot",
						ok: true,
						structuredOutput: {
							status: "ok",
							issues: [MAJOR_ISSUE],
							summary: "1 major",
							coverage: { filesChecked: ["a.ts"], commandsRun: [], limitations: [] },
						},
					},
				],
				gate: {
					ok: true,
					structuredOutput: {
						status: "ok",
						verdict: "comment",
						issues: [{ ...MAJOR_ISSUE, confidence: 8 }],
						dispositions: [
							{
								fingerprint: "a.ts:4:bug:null",
								decision: "kept",
								originalConfidence: 7,
								finalConfidence: 8,
								sourceReviewers: ["bugbot"],
								reason: "verified against diff",
							},
						],
						reason: "verified",
						coverage: { limitations: [] },
					},
				},
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.verdict, "request_changes");
		assert.ok(res.markdown.includes("Verdict: REQUEST_CHANGES"));
	});

	test("without gate scores, a conf-7 major is dropped at threshold 8 and the report says no-gate (not approve)", () => {
		const { cwd, runId } = setupManifest();
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			workflowReturn: {
				reviewers: [
					{
						key: "bugbot",
						ok: true,
						structuredOutput: {
							status: "ok",
							issues: [MAJOR_ISSUE],
							summary: "1 major",
							coverage: { filesChecked: ["a.ts"], commandsRun: [], limitations: [] },
						},
					},
				],
				gate: null,
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		// No gate ran: the tool reports no-gate instead of fabricating approve.
		assert.equal(res.verdict, "no-gate");
	});

	test("legacy verdict policy still applies when configured", () => {
		const { cwd, runId } = setupManifest();
		// 2 majors at conf 9 with legacy policy -> comment (needs >=3).
		const twoMajors = [1, 2].map((n) => ({
			file: `a${n}.ts`,
			line: 1,
			category: "bug" as const,
			severity: "major" as const,
			confidence: 9,
			evidence: "x",
			fingerprint: `a${n}.ts:1:bug:x`,
		}));
		const res = runReportTool({
			runId,
			cwd,
			verdictPolicy: "legacy",
			workflowReturn: {
				reviewers: [
					{
						key: "bugbot",
						ok: true,
						structuredOutput: {
							status: "ok",
							issues: twoMajors,
							summary: "2 majors",
							coverage: { filesChecked: [], commandsRun: [], limitations: [] },
						},
					},
				],
				gate: { ok: true, structuredOutput: { status: "ok", verdict: "comment", issues: twoMajors, dispositions: [], reason: "x", coverage: { limitations: [] } } },
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.verdict, "comment");
	});

	test("missing manifest returns a clear error", () => {
		const res = runReportTool({
			runId: "nonexistent-run",
			cwd: "/tmp/definitely-no-such-dir",
			workflowReturn: { reviewers: [], gate: null },
		});
		assert.equal(res.ok, false);
		assert.ok((res as { error: string }).error.includes("manifest not found"));
	});
});