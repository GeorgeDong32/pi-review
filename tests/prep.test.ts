import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { formatGateContext, formatReviewTask, prepareContext, summarizeDiff } from "../src/prep.js";
import type { ReviewTarget } from "../src/types.js";

describe("summarizeDiff", () => {
	test("counts files and lines", () => {
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1 +1,2 @@",
			" line",
			"+added",
		].join("\n");
		const s = summarizeDiff(diff);
		assert.match(s, /1 file/);
		assert.match(s, /a\.ts/);
	});
});

describe("prepareContext", () => {
	test("returns summary for metadata", () => {
		const prep = prepareContext("/tmp", "PR 1 metadata");
		assert.equal(prep.summary, "PR 1 metadata");
	});
});

describe("formatReviewTask", () => {
	test("includes obtain-change playbook, not embedded diff body", () => {
		const target: ReviewTarget = {
			kind: "pr",
			label: "PR 17206 (agent-fetch)",
			prRef: "https://github.com/org/repo/pull/17206",
			userContext: "https://github.com/org/repo/pull/17206",
			probeNote: "gh pr diff too_large",
		};
		const body = formatReviewTask({ rulePaths: ["AGENTS.md"], summary: "PR meta" }, target);
		assert.match(body, /How to obtain the change/);
		assert.match(body, /too_large/);
		assert.match(body, /AGENTS\.md/);
		assert.doesNotMatch(body, /^## Diff$/m);
		assert.doesNotMatch(body, /diff --git/);
	});
});

describe("formatGateContext", () => {
	test("is metadata only", () => {
		const ctx = formatGateContext(
			{ rulePaths: ["CLAUDE.md"], summary: "summary" },
			{ kind: "pr", label: "PR 1", prRef: "1" },
		);
		assert.match(ctx, /PR: 1/);
		assert.doesNotMatch(ctx, /diff --git/);
	});
});
