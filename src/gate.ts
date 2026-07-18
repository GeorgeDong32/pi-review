/**
 * Gate subagent — Phase 3 score + filter (compressed Claude steps 5–6).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGateArgs, type BuiltArgs } from "./args.js";
import { readGatePromptBody } from "./paths.js";
import { GateOutputSchema } from "./schema.js";
import { createRuntimeDir, runSubagent } from "./spawn.js";
import type {
	GateRunResult,
	GateVerdict,
	PiReviewConfig,
	ReviewerOutput,
	ReviewerRunResult,
} from "./types.js";

const MAX_TASK_ARG_CHARS = 24_000;

export interface RunGateInput {
	reviewers: ReviewerRunResult[];
	promptBody: string;
	gateModel: string;
	gateThinking?: string;
	threshold: number;
	cwd: string;
	config: PiReviewConfig;
}

function materializeGateSystemPrompt(): string {
	const dir = join(tmpdir(), `pi-review-gate-sys-${process.pid}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "gate-system.md");
	writeFileSync(path, readGatePromptBody(), "utf-8");
	return path;
}

function materializeTaskArg(text: string): string {
	if (text.length <= MAX_TASK_ARG_CHARS) return text;
	const dir = join(tmpdir(), `pi-review-gate-task-${process.pid}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "task.md");
	writeFileSync(path, text, "utf-8");
	return `@${path}`;
}

/** Render the gate task prompt: reviewer JSON blocks + threshold. */
export function renderGatePrompt(input: RunGateInput): string {
	const blocks: string[] = [];
	blocks.push("# pi-review — gate input");
	blocks.push("");
	blocks.push("## Input summary");
	blocks.push(input.promptBody.slice(0, 2000));
	blocks.push("");
	blocks.push(`## Threshold: ${input.threshold} (on 1–10 scale; keep issues with confidence >= threshold)`);
	blocks.push("");
	blocks.push("## Reviewer outputs");
	blocks.push("");

	for (const r of input.reviewers) {
		if (!r.ok || !r.output) {
			blocks.push(`### Reviewer: ${r.id}`);
			blocks.push("");
			blocks.push(`(failed: ${r.error ?? "unknown error"})`);
			blocks.push("");
			continue;
		}
		const output: ReviewerOutput = r.output;
		blocks.push(`### Reviewer: ${r.id}`);
		blocks.push("");
		blocks.push("```json");
		blocks.push(JSON.stringify(output, null, 2));
		blocks.push("```");
		blocks.push("");
	}

	blocks.push("## Instructions");
	blocks.push("");
	blocks.push(
		"Dedupe by (file, line, category). Re-score each issue 1–10 using the rubric in your system prompt. Drop issues below threshold. Apply verdict rules. Call structured_output once.",
	);

	return blocks.join("\n");
}

export async function runGate(input: RunGateInput): Promise<GateRunResult> {
	const runtime = createRuntimeDir("pi-review-gate-");
	const systemPromptFile = materializeGateSystemPrompt();
	const promptBody = renderGatePrompt(input);
	const taskText = materializeTaskArg(promptBody);

	const args: BuiltArgs = buildGateArgs({
		model: input.gateModel,
		thinking: input.gateThinking,
		promptFile: systemPromptFile,
		schemaPath: runtime.schemaPath,
		outputPath: runtime.outputPath,
		taskText,
	});

	const result = await runSubagent({
		args: args.args,
		env: args.env,
		cwd: input.cwd,
		timeoutMs: 300_000,
		schema: GateOutputSchema,
		schemaPath: runtime.schemaPath,
		outputPath: runtime.outputPath,
	});

	if (!result.ok) {
		return {
			ok: false,
			error: result.error,
			exitCode: result.exitCode ?? undefined,
			durationMs: result.durationMs,
			model: input.gateModel,
		};
	}

	const verdict = result.value as GateVerdict;
	return {
		ok: true,
		verdict,
		durationMs: result.durationMs,
		model: input.gateModel,
	};
}
