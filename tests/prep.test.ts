import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { formatReviewTask, prepareContext, summarizeDiff } from "../src/prep.js";

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
	test("returns summary for diff", () => {
		const prep = prepareContext("/tmp", "+++ b/x\n+line\n+line2\n+line3\n");
		assert.ok(prep.summary.length > 0);
	});
});

describe("formatReviewTask", () => {
	test("includes diff section", () => {
		const body = formatReviewTask({ rulePaths: ["AGENTS.md"], summary: "1 file" }, "+change\n+line\n+more");
		assert.match(body, /## Diff/);
		assert.match(body, /\+change/);
		assert.match(body, /AGENTS\.md/);
	});
});
