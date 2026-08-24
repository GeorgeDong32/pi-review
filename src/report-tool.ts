/**
 * Implementation of the `pi_review_report` tool. Loaded by index.ts and
 * registered as a real Pi tool — the main agent calls it once after the
 * workflowScript returns.
 *
 * Pure logic — does not touch pi. The wrapper in `src/tool-wrapper.ts`
 * adapts it to `pi.registerTool`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { enforceGateOutput, type VerdictPolicy } from "./gate-enforce.js";
import { buildReportFromWorkflow, renderReport } from "./report.js";
import { readManifest, RunManifest } from "./review-report.js";
import type {
	GateDisposition,
	Issue,
	ReviewerOutput,
	Verdict,
} from "./types.js";

export interface ReportToolInput {
	runId: string;
	workflowReturn: unknown;
	threshold?: number;
	verdictPolicy?: VerdictPolicy;
	/** Root of the prepared run; defaults to process.cwd(). Callers with a
	 *  tool/command context should pass ctx.cwd so the manifest is found
	 *  regardless of the hosting process's cwd. */
	cwd?: string;
}

export interface ReportToolSuccess {
	ok: true;
	runId: string;
	verdict: Verdict | "partial" | "no-gate" | "error";
	markdown: string;
	report: ReturnType<typeof buildReportFromWorkflow>;
	persistedEntry?: unknown;
}

export interface ReportToolFailure {
	ok: false;
	error: string;
}

export type ReportToolResult = ReportToolSuccess | ReportToolFailure;

/** Map legacy `ReviewerOutput` shape to v0.7 shape (status, coverage). */
function adaptReviewer(so: unknown): ReviewerOutput {
	if (!so || typeof so !== "object") {
		return { status: "limited", issues: [], summary: "", coverage: emptyCoverage() };
	}
	const obj = so as Partial<ReviewerOutput> & {
		issues?: unknown;
		summary?: unknown;
		status?: unknown;
		coverage?: unknown;
	};
	const issues = Array.isArray(obj.issues)
		? (obj.issues as Issue[]).filter(isIssueLike).map(normalizeIssue)
		: [];
	return {
		status: obj.status === "ok" || obj.status === "limited" || obj.status === "skipped"
			? obj.status
			: "limited",
		issues,
		summary: typeof obj.summary === "string" ? obj.summary : "",
		coverage: isCoverage(obj.coverage)
			? obj.coverage
			: emptyCoverage(),
	};
}

function isIssueLike(v: unknown): v is Issue {
	return !!v && typeof v === "object" && typeof (v as { file?: unknown }).file === "string";
}

/** Clamp / default an issue's confidence so downstream filters never see NaN. */
function normalizeIssue(issue: Issue): Issue {
	if (typeof issue.confidence === "number" && Number.isFinite(issue.confidence)) {
		return { ...issue, confidence: Math.max(1, Math.min(10, Math.round(issue.confidence))) };
	}
	return { ...issue, confidence: 5 };
}

/** Clamp an externally supplied score (gate re-scores bypass schema paths). */
function clampConfidence(value: unknown): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : 5;
	return Math.max(1, Math.min(10, Math.round(n)));
}

function isCoverage(v: unknown): v is ReviewerOutput["coverage"] {
	return (
		!!v &&
		typeof v === "object" &&
		Array.isArray((v as { filesChecked?: unknown }).filesChecked) &&
		Array.isArray((v as { commandsRun?: unknown }).commandsRun) &&
		Array.isArray((v as { limitations?: unknown }).limitations)
	);
}

function emptyCoverage(): ReviewerOutput["coverage"] {
	return { filesChecked: [], commandsRun: [], limitations: [] };
}

/** Build a deterministic verdict + report from a workflow return value. */
export function runReportTool(input: ReportToolInput): ReportToolResult {
	if (!input.workflowReturn || typeof input.workflowReturn !== "object") {
		return { ok: false, error: "workflowReturn must be an object" };
	}
	const ret = input.workflowReturn as {
		reviewers?: unknown;
		gate?: unknown;
		reviewersShaped?: unknown;
	};
	if (!Array.isArray(ret.reviewers)) {
		return { ok: false, error: "workflowReturn.reviewers must be an array" };
	}

	// Locate the manifest so the report has authoritative metadata.
	const manifest = loadManifestSafe(input.runId, input.cwd);
	const threshold = input.threshold ?? 8;
	const policy = input.verdictPolicy ?? "strict";

	const reviewersRaw = ret.reviewers as Array<{
		key: string;
		ok: boolean;
		error?: string;
		structuredOutput?: unknown;
		output?: string;
	}>;
	// Stale-artifact guard: findings may only come from reviewers THIS run
	// fanned out (manifest.reviewerIds). Anything else — e.g. a main agent
	// that reconstructed a workflowReturn from old .pi-subagents artifacts
	// after a failed workflow — is dropped and surfaced, never reported.
	const roster = new Set(manifest?.reviewerIds ?? []);
	const knownReviewers = roster.size === 0
		? reviewersRaw
		: reviewersRaw.filter((r) => roster.has(r.key));
	const unknownKeys = reviewersRaw
		.filter((r) => roster.size > 0 && !roster.has(r.key))
		.map((r) => r.key);
	if (unknownKeys.length > 0 && knownReviewers.length === 0) {
		// Every finding came from outside this run's roster — almost certainly
		// a workflowReturn reconstructed from stale artifacts after a failed
		// workflow. Rendering a report here would fabricate a clean APPROVE
		// over zero real reviewers; refuse instead.
		return {
			ok: false,
			error: `workflowReturn contains no reviewer from this run's roster (got: ${unknownKeys.join(", ")}; roster: ${[...roster].join(", ")}). Findings appear to come from stale artifacts — re-run the review instead of reconstructing its return value.`,
		};
	}
	const reviewerOutputs = knownReviewers.map((r) => ({
		key: r.key,
		ok: r.ok,
		error: r.error,
		output: r.output,
		structuredOutput: r.ok ? r.structuredOutput ?? safeJsonParse(r.output) : undefined,
	}));

	const gateRaw = (ret.gate ?? null) as {
		ok: boolean;
		error?: string;
		structuredOutput?: unknown;
		output?: string;
	} | null;
	const gateStructured = gateRaw?.ok
		? gateRaw.structuredOutput ?? safeJsonParse(gateRaw.output)
		: undefined;

	// Gate scored-candidates: when the gate returned issues/dispositions, use
	// its finalConfidence re-score as the authority (the gate verified
	// high-severity candidates against the diff/workspace). Reviewer raw
	// candidates remain the fallback when the gate is missing/failed.
	const gateSo = gateStructured as
		| {
				issues?: Issue[];
				dispositions?: GateDisposition[];
			}
		| undefined;

	// 1) Merge gate dispositions into reviewer candidates (re-score by fingerprint).
	const dispoByFp = new Map<string, GateDisposition>();
	for (const d of gateSo?.dispositions ?? []) dispoByFp.set(d.fingerprint, d);

	// 2) Collect candidates from reviewer structuredOutput.
	const candidates: Array<{ issue: Issue; sourceReviewers: string[] }> = [];
	for (const r of reviewerOutputs) {
		const adapted = adaptReviewer(r.structuredOutput);
		for (const issue of adapted.issues) {
			if (!issue.fingerprint) issue.fingerprint = issueFingerprint(issue);
			candidates.push({ issue, sourceReviewers: [r.key] });
		}
	}

	// 3) Apply gate final scores: replace raw confidence with the re-scored
	//    finalConfidence for every candidate the gate dispositioned.
	//    "unverified:" blocker/major dispositions are exempt from the
	//    threshold floor below — the gate's verification duty says those must
	//    stay visible to a human instead of dying in a numeric filter.
	const finalCandidates = candidates.map((c) => {
		const d = c.issue.fingerprint ? dispoByFp.get(c.issue.fingerprint) : undefined;
		if (!d) return c;
		let confidence = clampConfidence(d.finalConfidence);
		const unverified =
			/^unverified:/i.test(d.reason.trim()) &&
			(c.issue.severity === "blocker" || c.issue.severity === "major");
		if (unverified) confidence = Math.max(confidence, threshold);
		return {
			issue: {
				...c.issue,
				confidence,
				evidence: unverified ? `${c.issue.evidence} (unverified)` : c.issue.evidence,
			},
			sourceReviewers: c.sourceReviewers,
		};
	});

	const dedupMap = new Map<string, { issue: Issue; sourceReviewers: Set<string> }>();
	for (const c of finalCandidates) {
		const key = c.issue.fingerprint ?? issueFingerprint(c.issue);
		const prev = dedupMap.get(key);
		if (!prev) {
			dedupMap.set(key, { issue: c.issue, sourceReviewers: new Set(c.sourceReviewers) });
			continue;
		}
		prev.sourceReviewers.add(c.sourceReviewers[0]!);
		if (c.issue.confidence > prev.issue.confidence) prev.issue = c.issue;
	}

	const deduped: Issue[] = [...dedupMap.values()].map((d) => d.issue);
	const enforced = enforceGateOutput({ issues: deduped }, threshold, policy);

	const dispositions: GateDisposition[] = [...dedupMap.values()].map((d) => {
		const fp = d.issue.fingerprint ?? issueFingerprint(d.issue);
		const gateDispo = dispoByFp.get(fp);
		const survived = enforced.issues.some(
			(e) => (e.fingerprint ?? issueFingerprint(e)) === fp,
		);
		return {
			fingerprint: fp,
			decision: survived ? "kept" : "dropped",
			originalConfidence: d.issue.confidence,
			finalConfidence: d.issue.confidence,
			sourceReviewers: [...d.sourceReviewers],
			reason:
				gateDispo?.reason ??
				(survived ? "Survived threshold + dedupe." : "Below threshold or merged."),
		};
	});

	if (!manifest) {
		return {
			ok: false,
			error: `manifest not found for runId ${input.runId}. Has /review prepared the run?`,
		};
	}

	const built = buildReportFromWorkflow({
		startedAt: Date.now(),
		manifest: {
			runId: manifest.runId,
			targetLabel: manifest.targetLabel,
			targetKind: manifest.targetKind,
			prRef: manifest.prRef,
			diffSha256: manifest.diffSha256,
			workspacePath: manifest.workspacePath,
			workspaceHeadSha: manifest.workspaceHeadSha,
			workspaceWarning: manifest.workspaceWarning,
			diffWarning: manifest.diffWarning,
			mode: manifest.mode,
			docsOnly: manifest.docsOnly,
			rulePaths: manifest.rulePaths,
			historyAvailable: manifest.historyAvailable,
			changedFiles: manifest.changedFiles,
			baseSha: manifest.baseSha,
			headSha: manifest.headSha,
			skippedReviewers: manifest.skippedReviewers,
		},
		workflowReturn: { reviewers: reviewerOutputs, gate: gateRaw },
		threshold,
		policy,
		enforcedVerdict: enforced.verdict,
		enforcedIssues: enforced.issues,
		enforcedDispositions: dispositions,
		enforcedReason: (unknownKeys.length > 0
			? `${enforced.reason} (dropped findings from non-roster reviewer keys: ${unknownKeys.join(", ")})`
			: enforced.reason).slice(0, 500),
	});

	const markdown = renderReport(built);
	return {
		ok: true,
		runId: input.runId,
		verdict: built.verdict,
		markdown,
		report: built,
	};
}

function safeJsonParse(text?: string): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function loadManifestSafe(runId: string, cwd?: string): RunManifest | null {
	// Prefer the explicit run root (tool ctx.cwd); the manifest lives under
	// the same .pi/pi-review/runs/<runId> that prepareRun created.
	const root = cwd?.trim() ? cwd : process.cwd();
	const path = join(root, ".pi", "pi-review", "runs", runId, "manifest.json");
	try {
		const raw = readFileSync(path, "utf-8");
		return JSON.parse(raw) as RunManifest;
	} catch {
		return null;
	}
}

/** Deterministic fingerprint for an issue. */
export function issueFingerprint(issue: Issue): string {
	const line = issue.line === undefined ? "-" : String(issue.line);
	const evHash = simpleHash(issue.evidence);
	return `${issue.file}:${line}:${issue.category}:${evHash}`;
}

function simpleHash(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) {
		h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(36).slice(0, 6);
}