/**
 * `/review` pipeline orchestration.
 */
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import type { ParsedReviewArgs } from "./cli-args.js";
import { loadConfig, resolveModel, clampThreshold } from "./config.js";
import { checkEligibility, recheckBeforeOutput } from "./eligibility.js";
import { isGitRepo, resolveDefaultDiff, resolveInputFromPath } from "./git-input.js";
import { runGate } from "./gate.js";
import { formatReviewTask, prepareContext } from "./prep.js";
import { buildReport, renderReport } from "./report.js";
import { runReviewers } from "./review.js";
import type { PiReviewConfig, PrepMetadata, ResolvedInput, ReviewerSpec } from "./types.js";

/** Minimal command context required by the review pipeline (test-friendly). */
export interface ReviewPipelineContext {
	cwd: string;
	hasUI: boolean;
	model?: { provider: string; id: string } | null;
	ui: {
		notify: ExtensionCommandContext["ui"]["notify"];
	};
}

export interface RunPipelineOptions {
	args: ParsedReviewArgs;
	ctx: ReviewPipelineContext;
	onStatus?: (text: string | undefined) => void;
}

export type PipelineResult =
	| { kind: "skipped"; reason: string }
	| { kind: "dry-run"; plan: string }
	| { kind: "report"; markdown: string; report: ReturnType<typeof buildReport> };

function parentModelId(ctx: ReviewPipelineContext): string | undefined {
	const m = ctx.model;
	if (!m) return undefined;
	return `${m.provider}/${m.id}`;
}

function selectReviewers(config: PiReviewConfig, filterIds: string[]): ReviewerSpec[] {
	const all = Object.values(config.reviewers).filter((r) => r.enabled);
	if (filterIds.length === 0) return all;
	const set = new Set(filterIds);
	return all.filter((r) => set.has(r.id));
}

function resolveReviewers(config: PiReviewConfig, filterIds: string[], parentModel: string | undefined): ReviewerSpec[] {
	return selectReviewers(config, filterIds).map((r) => ({
		...r,
		model: resolveModel(r.model, parentModel),
	}));
}

export async function runReviewPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
	const { args, ctx, onStatus } = options;
	const cwd = ctx.cwd;
	const parentModel = parentModelId(ctx);
	const { config, errors: configErrors } = loadConfig();

	if (configErrors.length > 0 && ctx.hasUI) {
		ctx.ui.notify(`pi-review config warnings: ${configErrors.join("; ")}`, "warning");
	}

	const git = await isGitRepo(cwd);
	let resolved: ResolvedInput | null = null;
	if (args.path) {
		resolved = await resolveInputFromPath(cwd, args.path);
	} else {
		resolved = await resolveDefaultDiff(cwd);
	}

	const eligibility = checkEligibility({
		resolved,
		hasExplicitPath: Boolean(args.path),
		isGitRepo: git,
	});
	if (!eligibility.eligible) {
		return { kind: "skipped", reason: eligibility.reason };
	}

	const input = resolved!;
	const prep = prepareContext(cwd, input.content);
	const prepMeta: PrepMetadata = { rulePaths: prep.rulePaths, summary: prep.summary };
	const taskBody = formatReviewTask(prep, input.content);

	const threshold = clampThreshold(args.threshold ?? config.gate.threshold);
	const reviewers = resolveReviewers(config, args.reviewers, parentModel);
	const gateModel = resolveModel(args.gateModel ?? config.gate.model, parentModel);
	const runGateStep = !args.noGate && config.gate.enabled;
	const scorePerIssue = args.scorePerIssue ?? config.gate.scorePerIssue;

	if (args.noSpawn) {
		const lines = [
			"pi-review dry run",
			`input: ${input.label}`,
			`threshold: ${threshold}`,
			`scorePerIssue: ${scorePerIssue}`,
			`reviewers (${reviewers.length}): ${reviewers.map((r) => `${r.id} (${r.model})`).join(", ")}`,
			`gate: ${runGateStep ? `yes (${gateModel})` : "no"}`,
			`prep rules: ${prep.rulePaths.join(", ") || "(none)"}`,
			`summary: ${prep.summary}`,
		];
		return { kind: "dry-run", plan: lines.join("\n") };
	}

	if (reviewers.length === 0) {
		return { kind: "skipped", reason: "No enabled reviewers match the requested filter." };
	}

	const startedAt = Date.now();
	onStatus?.(`reviewers 0/${reviewers.length}`);

	const reviewerResults = await runReviewers({
		reviewers,
		promptBody: taskBody,
		cwd,
		config,
	});

	onStatus?.(runGateStep ? "gate" : undefined);

	let gateResult = null;
	if (runGateStep) {
		gateResult = await runGate({
			reviewers: reviewerResults,
			promptBody: taskBody,
			gateModel,
			gateThinking: config.gate.thinking,
			threshold,
			cwd,
			config,
			scorePerIssue,
		});
	}

	const recheck = recheckBeforeOutput(input);
	if (!recheck.eligible) {
		return { kind: "skipped", reason: recheck.reason };
	}

	const report = buildReport({
		startedAt,
		reviewers: reviewerResults,
		gate: gateResult,
		input,
		prep: prepMeta,
	});

	onStatus?.(undefined);
	return { kind: "report", markdown: renderReport(report), report };
}
