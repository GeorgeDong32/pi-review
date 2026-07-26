/**
 * Programmatic smoke for v0.4 agent-driven acceptance (no live pi TUI / API keys).
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { parseReviewArgs } from "../src/cli-args.js";
import { resetRunGh, setRunGh } from "../src/git-input.js";
import { runReviewPipeline, type ReviewPipelineContext } from "../src/run.js";

function mockCtx(cwd: string): ReviewPipelineContext {
	return {
		cwd,
		hasUI: false,
		model: { provider: "google", id: "gemini-2.5-flash" },
		ui: {
			notify: () => {},
		},
	};
}

describe("smoke pipeline", () => {
	afterEach(() => {
		resetRunGh();
	});

	it("dry-run outside git without PR skips", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-smoke-"));
		writeFileSync(join(dir, "sample.ts"), "export const x = 1;\n");

		const args = parseReviewArgs("--no-spawn");
		const result = await runReviewPipeline({ args, ctx: mockCtx(dir) });

		assert.equal(result.kind, "skipped");
		assert.match((result as { reason: string }).reason, /git|diff|PR|review/i);
	});

	it("dry-run --lite uses single-agent mode with no gate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-smoke-lite-"));
		setRunGh(async (args) => {
			if (args[0] === "pr" && args[1] === "view") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						title: "lite pr",
						additions: 10,
						deletions: 2,
						changedFiles: 1,
						state: "OPEN",
					}),
					stderr: "",
				};
			}
			return { exitCode: 1, stdout: "", stderr: "no" };
		});

		const args = parseReviewArgs("--lite https://github.com/org/repo/pull/5 --no-spawn");
		const result = await runReviewPipeline({ args, ctx: mockCtx(dir) });

		assert.equal(result.kind, "dry-run");
		const plan = (result as { plan: string }).plan;
		assert.match(plan, /mode: lite/);
		assert.match(plan, /gate: no/);
		assert.match(plan, /reviewers \(1\)/);
		assert.match(plan, /lite-review/);
	});

	it("dry-run with oversized PR still succeeds (agent-fetch)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-smoke-pr-"));
		setRunGh(async (args) => {
			if (args[0] === "pr" && args[1] === "view") {
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						title: "big pr",
						additions: 30000,
						deletions: 100,
						changedFiles: 200,
						state: "OPEN",
					}),
					stderr: "",
				};
			}
			return { exitCode: 1, stdout: "", stderr: "no" };
		});

		const args = parseReviewArgs(
			"https://github.com/CherryHQ/cherry-studio/pull/17206 --no-spawn",
		);
		const result = await runReviewPipeline({ args, ctx: mockCtx(dir) });

		assert.equal(result.kind, "dry-run");
		const plan = (result as { plan: string }).plan;
		assert.match(plan, /PR 17206/);
		assert.match(plan, /agent-fetch/);
		assert.match(plan, /path-scoped|too_large|exceeds/i);
		assert.doesNotMatch(plan, /Could not fetch PR diff/);
		// Lightweight defaults: per-issue scorer off, gate on a cheap model.
		assert.match(plan, /scorePerIssue: off/);
		assert.match(plan, /gate: yes \(anthropic\/claude-haiku-4-5\)/);
	});
});
