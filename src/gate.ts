/**
 * Gate subagent execution: single spawn that aggregates reviewer outputs.
 *
 * Pattern ported from pi-subagents/src/runs/shared/acceptance.ts:681-797.
 *
 * The gate receives a markdown prompt containing:
 *   - input summary
 *   - threshold
 *   - one `## Reviewer: <id>` block per successful reviewer (containing
 *     the validated JSON output)
 *
 * It must call `structured_output` once with the gate verdict schema.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGateArgs, type BuiltArgs } from "./args.js";
import { GateOutputSchema } from "./schema.js";
import { createRuntimeDir, runSubagent } from "./spawn.js";
import type {
	GateRunResult,
	GateVerdict,
	PiReviewConfig,
	ReviewerOutput,
	ReviewerRunResult,
} from "./types.js";

/** Options for runGate. */
export interface RunGateInput {
	/** Successful reviewer results to feed into the gate. */
	reviewers: ReviewerRunResult[];
	/** The original input the reviewers saw (for context). */
	promptBody: string;
	/** Resolved model id for the gate (no "inherit" sentinel). */
	gateModel: string;
	/** Thinking level for the gate. */
	gateThinking?: string;
	/** Confidence floor — issues below this are dropped by the gate. */
	threshold: number;
	/** Working directory. */
	cwd: string;
	/** Full config (used for tool defaults; gate currently uses no tools). */
	config: PiReviewConfig;
}

/** Render the gate prompt: markdown with reviewer blocks. */
export function renderGatePrompt(input: RunGateInput): string {
	const blocks: string[] = [];
	blocks.push("# pi-review — gate input");
	blocks.push("");
	blocks.push("## Input summary");
	blocks.push(input.promptBody.slice(0, 2000));
	blocks.push("");
	blocks.push(`## Threshold: ${input.threshold}`);
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
		"Dedupe by (file, line, category), keep highest confidence. Drop issues with confidence < threshold. Apply verdict rules. Call structured_output once with the gate JSON schema.",
	);

	return blocks.join("\n");
}

/** Materialize the gate prompt into a temp file and spawn. */
export async function runGate(input: RunGateInput): Promise<GateRunResult> {
	const runtime = createRuntimeDir("pi-review-gate-");
	const promptFile = join(runtime.dir, "gate-prompt.md");
	mkdirSync(runtime.dir, { recursive: true });
	const promptBody = renderGatePrompt(input);
	writeFileSync(promptFile, promptBody, "utf-8");

	const args: BuiltArgs = buildGateArgs({
		model: input.gateModel,
		thinking: input.gateThinking,
		promptFile,
		schemaPath: runtime.schemaPath,
		outputPath: runtime.outputPath,
		taskText: promptBody,
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
