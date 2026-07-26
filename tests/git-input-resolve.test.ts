import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { resetRunGh, setRunGh, resolveReviewInput } from "../src/git-input.js";

describe("resolveReviewInput", () => {
	afterEach(() => {
		resetRunGh();
	});

	test("fetches PR diff via gh when input is a PR URL", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-gh-"));
		setRunGh(async (args) => {
			assert.deepEqual(args, ["pr", "diff", "https://github.com/org/repo/pull/99"]);
			return {
				exitCode: 0,
				stdout: [
					"diff --git a/foo.ts b/foo.ts",
					"--- a/foo.ts",
					"+++ b/foo.ts",
					"@@ -1,3 +1,6 @@",
					" line1",
					"+added1",
					"+added2",
					"+added3",
				].join("\n"),
				stderr: "",
			};
		});

		const resolved = await resolveReviewInput(dir, {
			input: "https://github.com/org/repo/pull/99",
		});
		assert.ok(resolved);
		assert.equal(resolved?.source.kind, "pr");
		assert.equal(resolved?.userContext, "https://github.com/org/repo/pull/99");
	});

	test("--diff loads explicit file and keeps user input as context", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-diff-"));
		const diffPath = join(dir, "change.diff");
		writeFileSync(
			diffPath,
			[
				"diff --git a/foo.ts b/foo.ts",
				"--- a/foo.ts",
				"+++ b/foo.ts",
				"@@ -1,3 +1,6 @@",
				" line1",
				"+added1",
				"+added2",
				"+added3",
			].join("\n"),
		);

		const resolved = await resolveReviewInput(dir, {
			diffPath: `@${diffPath}`,
			input: "focus on backup restore edge cases",
		});
		assert.ok(resolved);
		assert.equal(resolved?.source.kind, "path");
		assert.equal(resolved?.userContext, "focus on backup restore edge cases");
	});

	test("throws when gh cannot fetch PR", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-gh-fail-"));
		setRunGh(async () => ({ exitCode: 1, stdout: "", stderr: "not found" }));

		await assert.rejects(
			() => resolveReviewInput(dir, { input: "https://github.com/org/repo/pull/1" }),
			/gh/i,
		);
	});
});
