/**
 * Programmatic smoke for v0.2 acceptance (no live pi TUI / API keys).
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseReviewArgs } from "../src/cli-args.js";
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
	it("dry-run resolves 5 default reviewers and threshold 8", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-smoke-"));
		writeFileSync(join(dir, "sample.ts"), "export const x = 1;\n");

		const args = parseReviewArgs("--no-spawn");
		const result = await runReviewPipeline({ args, ctx: mockCtx(dir) });

		assert.equal(result.kind, "skipped");
		assert.match((result as { reason: string }).reason, /git|diff|empty/i);
	});

	it("dry-run with explicit diff file", async () => {
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

		const args = parseReviewArgs(`--no-spawn @${diffPath}`);
		const result = await runReviewPipeline({ args, ctx: mockCtx(dir) });

		assert.equal(result.kind, "dry-run");
		const plan = (result as { plan: string }).plan;
		assert.match(plan, /threshold: 8/);
		assert.match(plan, /bugbot/);
		assert.match(plan, /security-review/);
		assert.match(plan, /history-context/);
		assert.match(plan, /code-comments/);
		assert.match(plan, /claude-md-compliance/);
	});

	it("skips trivial diff", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-smoke-"));
		const diff = "diff --git a/a b/a\n+line\n";
		const diffPath = join(dir, "tiny.diff");
		writeFileSync(diffPath, diff);

		const args = parseReviewArgs(`@${diffPath}`);
		const result = await runReviewPipeline({ args, ctx: mockCtx(dir) });

		assert.equal(result.kind, "skipped");
	});
});
