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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	test("findings from non-roster reviewer keys are dropped and surfaced (stale-artifact guard)", () => {
		const { cwd, runId, manifest } = setupManifest();
		// Simulate the 2026-08-24 incident shape: a workflowReturn assembled
		// from OLD artifacts carries reviewer keys this run never launched.
		writeManifest(join(cwd, ".pi", "pi-review", "runs", runId), {
			...manifest,
			reviewerIds: ["bugbot"],
		});
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
							issues: [],
							summary: "",
							coverage: { filesChecked: [], commandsRun: [], limitations: [] },
						},
					},
					{
						key: "history-context",
						ok: true,
						structuredOutput: {
							status: "ok",
							issues: [MAJOR_ISSUE],
							summary: "from an old run",
							coverage: { filesChecked: [], commandsRun: [], limitations: [] },
						},
					},
				],
				gate: {
					ok: true,
					structuredOutput: {
						status: "ok",
						verdict: "request_changes",
						issues: [{ ...MAJOR_ISSUE, confidence: 9 }],
						dispositions: [],
						reason: "old artifacts",
						coverage: { limitations: [] },
					},
				},
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		// The stale reviewer's major must not survive into the report issues.
		assert.equal(res.report.totals.bySeverity.major, 0);
		assert.match(res.markdown, /non-roster reviewer keys: history-context/);
	});

	test("workflowReturn with ONLY non-roster keys is rejected outright (no fabricated approve)", () => {
		const { cwd, runId, manifest } = setupManifest();
		writeManifest(join(cwd, ".pi", "pi-review", "runs", runId), {
			...manifest,
			reviewerIds: ["bugbot"],
		});
		const res = runReportTool({
			runId,
			cwd,
			workflowReturn: {
				reviewers: [
					{
						key: "history-context", // stale artifact, not this run's roster
						ok: true,
						structuredOutput: {
							status: "ok",
							issues: [MAJOR_ISSUE],
							summary: "old run",
							coverage: { filesChecked: [], commandsRun: [], limitations: [] },
						},
					},
				],
				gate: null,
			},
		});
		assert.equal(res.ok, false);
		if (res.ok) return;
		assert.match(res.error, /no reviewer from this run's roster/);
	});

	test("a successful report reclaims its cloned tmp workspace (end-of-run cleanup)", () => {
		const { cwd, runId, manifest } = setupManifest();
		// Simulate a plugin-owned scratch clone under the OS tmpdir.
		const scratchRoot = mkdtempSync(join(tmpdir(), "pi-review-ws-"));
		const cloneDir = join(scratchRoot, "some-repo-42");
		mkdirSync(cloneDir, { recursive: true });
		writeFileSync(join(cloneDir, "README.md"), "# scratch clone\n");
		writeManifest(join(cwd, ".pi", "pi-review", "runs", runId), {
			...manifest,
			workspacePath: cloneDir,
			workspaceCloned: true,
		});
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
							issues: [],
							summary: "clean",
							coverage: { filesChecked: [], commandsRun: [], limitations: [] },
						},
					},
				],
				gate: {
					ok: true,
					structuredOutput: {
						status: "ok",
						verdict: "approve",
						issues: [],
						dispositions: [],
						reason: "clean",
						coverage: { limitations: [] },
					},
				},
			},
		});
		assert.equal(res.ok, true);
		// The whole scratch root (not just the clone dir) is gone.
		assert.equal(existsSync(scratchRoot), false, "cloned workspace reclaimed after report");
	});

	test("a non-cloned workspace (user cwd) is never touched by reclamation", () => {
		const { cwd, runId, manifest } = setupManifest();
		writeManifest(join(cwd, ".pi", "pi-review", "runs", runId), {
			...manifest,
			// local-git run: workspace IS the user's repo, no cloned flag.
			workspaceCloned: false,
		});
		const res = runReportTool({
			runId,
			cwd,
			workflowReturn: {
				reviewers: [
					{
						key: "bugbot",
						ok: true,
						structuredOutput: {
							status: "ok",
							issues: [],
							summary: "",
							coverage: { filesChecked: [], commandsRun: [], limitations: [] },
						},
					},
				],
				gate: {
					ok: true,
					structuredOutput: {
						status: "ok",
						verdict: "approve",
						issues: [],
						dispositions: [],
						reason: "",
						coverage: { limitations: [] },
					},
				},
			},
		});
		assert.equal(res.ok, true);
		assert.equal(existsSync(cwd), true, "user cwd must survive report reclamation");
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

	test("unverified blocker/major dispositions are exempt from the threshold floor", () => {
		// Field regression (2026-08-20/21): the gate could not verify real
		// majors and its "keep at original confidence" instruction still lost
		// them to the code-side threshold filter. The exemption floors the
		// confidence at the threshold and flags the evidence.
		const { cwd, runId } = setupManifest();
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			workflowReturn: {
				reviewers: [
					{
						key: "history-context",
						ok: true,
						structuredOutput: {
							status: "ok",
							issues: [MAJOR_ISSUE],
							summary: "1 major",
							coverage: { filesChecked: [], commandsRun: [], limitations: ["diff truncated"] },
						},
					},
				],
				gate: {
					ok: true,
					structuredOutput: {
						status: "ok",
						verdict: "comment",
						issues: [],
						dispositions: [
							{
								fingerprint: "a.ts:4:bug:null",
								decision: "kept",
								originalConfidence: 7,
								finalConfidence: 7,
								sourceReviewers: ["history-context"],
								reason: "unverified: diff truncated before the registration hunk; kept for human review",
							},
						],
						reason: "kept unverified",
						coverage: { limitations: [] },
					},
				},
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.equal(res.verdict, "request_changes", "unverified major must drive the verdict");
		assert.match(res.markdown, /\(unverified\)/);
	});

	test("unverified exemption does not apply to minor/nit severities", () => {
		const { cwd, runId } = setupManifest();
		const minor = { ...MAJOR_ISSUE, severity: "minor" as const, fingerprint: "a.ts:4:bug:minor" };
		const res = runReportTool({
			runId,
			cwd,
			threshold: 8,
			workflowReturn: {
				reviewers: [
					{
						key: "code-comments",
						ok: true,
						structuredOutput: {
							status: "ok",
							issues: [{ ...minor, confidence: 4 }],
							summary: "1 minor",
							coverage: { filesChecked: [], commandsRun: [], limitations: [] },
						},
					},
				],
				gate: {
					ok: true,
					structuredOutput: {
						status: "ok",
						verdict: "comment",
						issues: [],
						dispositions: [
							{
								fingerprint: "a.ts:4:bug:minor",
								decision: "dropped",
								originalConfidence: 4,
								finalConfidence: 4,
								sourceReviewers: ["code-comments"],
								reason: "unverified: stylistic, below bar",
							},
						],
						reason: "dropped",
						coverage: { limitations: [] },
					},
				},
			},
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		// Gate ok + no surviving issues → enforced approve… but gate status ok
		// means the report verdict comes from enforcement: approve.
		assert.equal(res.verdict, "approve");
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