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

	it("dry-run outside git without PR/--diff skips", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-smoke-"));
		writeFileSync(join(dir, "sample.ts"), "export const x = 1;\n");

		const args = parseReviewArgs("--no-spawn");
		const result = await runReviewPipeline({ args, ctx: mockCtx(dir) });

		assert.equal(result.kind, "skipped");
		assert.match((result as { reason: string }).reason, /git|diff|PR|review/i);
	});

	it("dry-run with explicit diff file uses agent-fetch mode", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-smoke-"));
		const diff = [
			"diff --git a/foo.ts b/foo.ts",
			"--- a/foo.ts",
			"+++ b/foo.ts",
			"@@ -1,3 +1,3 @@",
			"-const a = 1",
			"-const b = 2",
			"+const a = 2",
			"+const b = 3",
			"",
		].join("\n");
		const diffPath = join(dir, "change.diff");
		writeFileSync(diffPath, diff);

		const args = parseReviewArgs(`--no-spawn --diff @${diffPath}`);
		const result = await runReviewPipeline({ args, ctx: mockCtx(dir) });

		assert.equal(result.kind, "dry-run");
		const plan = (result as { plan: string }).plan;
		assert.match(plan, /threshold: 8/);
		assert.match(plan, /scorePerIssue: blocker-major/);
		assert.match(plan, /agent-fetch/);
		assert.match(plan, /bugbot/);
		assert.match(plan, /security-review/);
		assert.match(plan, /history-context/);
		assert.match(plan, /code-comments/);
		assert.match(plan, /claude-md-compliance/);
	});

	it("dry-run with oversized PR still succeeds (agent-fetch)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-smoke-pr-"));
		setRunGh(async (args) => {
			if (args[0] === "pr" && args[1] === "diff") {
				return {
					exitCode: 1,
					stdout: "",
					stderr: "HTTP 406: exceeded the maximum number of lines (20000)\nPullRequest.diff too_large",
				};
			}
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
		assert.doesNotMatch(plan, /Could not fetch PR diff/);
	});
});
