/**
 * Fan-out execution of N reviewer subagents in parallel.
 *
 * Pattern ported from pi-subagents/src/runs/shared/parallel-utils.ts +
 * src/extension/index.ts:253-506.
 *
 * For each reviewer:
 *   1. Materialize the prompt (bundled markdown + diff/task text).
 *   2. Build a structured-output runtime dir.
 *   3. Spawn `pi` with --model/--tools/--system-prompt and the right env.
 *   4. Validate the output JSON against ReviewerOutputSchema.
 *
 * A single reviewer failure never aborts the others; each is recorded as
 * a `ReviewerRunResult` with `ok: false` and a descriptive error.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReviewerArgs, type BuiltArgs } from "./args.js";
import { mapConcurrent } from "./parallel.js";
import { ReviewerOutputSchema } from "./schema.js";
import { createRuntimeDir, runSubagent } from "./spawn.js";
import type { PiReviewConfig, ReviewerOutput, ReviewerRunResult, ReviewerSpec } from "./types.js";

/** Options for runReviewers. */
export interface RunReviewersInput {
	reviewers: ReviewerSpec[];
	/** The diff or prompt body the reviewers will see as their task text. */
	promptBody: string;
	/** Working directory for the spawned subagents. */
	cwd: string;
	/** Full config — used to look up inheritance defaults for tools. */
	config: PiReviewConfig;
}

/** Materialize a single reviewer's full prompt into a temp file. */
function materializeReviewerPrompt(reviewer: ReviewerSpec, promptBody: string): string {
	const dir = join(tmpdir(), `pi-review-prompt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "prompt.md");
	const body = [
		`# Reviewer: ${reviewer.id}`,
		``,
		reviewer.promptPath ? `# Bundled prompt: ${reviewer.promptPath}` : ``,
		``,
		`## Task`,
		``,
		promptBody,
		``,
		`## Output instructions`,
		``,
		`You MUST call the \`structured_output\` tool exactly once with a JSON object matching the schema provided via env var PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA. Do not write to stdout, do not reply in prose.`,
	].filter((l) => l !== "" || true).join("\n");
	writeFileSync(path, body, "utf-8");
	return path;
}

/** Run every reviewer in parallel, returning one result per input. */
export async function runReviewers(input: RunReviewersInput): Promise<ReviewerRunResult[]> {
	if (input.reviewers.length === 0) return [];

	return mapConcurrent(input.reviewers, input.config.concurrency, async (reviewer) => {
		const runtime = createRuntimeDir(`pi-review-${reviewer.id}-`);
		const promptFile = materializeReviewerPrompt(reviewer, input.promptBody);
		const tools = reviewer.tools ?? input.config.inheritance.toolsDefault;

		const args: BuiltArgs = buildReviewerArgs({
			model: reviewer.model as string,
			thinking: reviewer.thinking,
			tools,
			promptFile,
			schemaPath: runtime.schemaPath,
			outputPath: runtime.outputPath,
			reviewerId: reviewer.id,
			taskText: input.promptBody,
			inheritProjectContext: input.config.inheritance.inheritProjectContext,
			inheritSkills: input.config.inheritance.inheritSkills,
		});

		const result = await runSubagent({
			args: args.args,
			env: args.env,
			cwd: input.cwd,
			timeoutMs: reviewer.timeoutMs,
			schema: ReviewerOutputSchema,
			schemaPath: runtime.schemaPath,
			outputPath: runtime.outputPath,
		});

		if (!result.ok) {
			return {
				id: reviewer.id,
				label: reviewer.label,
				model: reviewer.model as string,
				ok: false,
				error: result.error,
				exitCode: result.exitCode ?? undefined,
				durationMs: result.durationMs,
			} satisfies ReviewerRunResult;
		}

		// Validation already happened inside runSubagent; the value is safe to cast.
		const output = result.value as ReviewerOutput;
		return {
			id: reviewer.id,
			label: reviewer.label,
			model: reviewer.model as string,
			ok: true,
			output,
			durationMs: result.durationMs,
		} satisfies ReviewerRunResult;
	});
}
