import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { resetRunGh, setRunGh, resolveReviewTarget } from "../src/git-input.js";

describe("resolveReviewTarget", () => {
	afterEach(() => {
		resetRunGh();
	});

	test("PR URL returns agent-fetch target without calling gh pr diff", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-gh-"));
		let calledDiff = false;
		setRunGh(async (args) => {
			if (args[0] === "pr" && args[1] === "diff") {
				calledDiff = true;
				return { exitCode: 1, stdout: "", stderr: "should not be called" };
			}
			return { exitCode: 0, stdout: "{}", stderr: "" };
		});

		const target = await resolveReviewTarget(dir, {
			input: "https://github.com/org/repo/pull/99",
		});
		assert.ok(target);
		assert.equal(target?.kind, "pr");
		assert.equal(target?.prRef, "https://github.com/org/repo/pull/99");
		assert.match(target?.label ?? "", /PR 99/);
		assert.equal(calledDiff, false);
	});

	test("--diff records path without embedding content", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-diff-"));
		const diffPath = join(dir, "change.diff");
		writeFileSync(diffPath, "diff --git a/foo.ts b/foo.ts\n+added\n");

		const target = await resolveReviewTarget(dir, {
			diffPath: `@${diffPath}`,
			input: "focus on backup restore edge cases",
		});
		assert.ok(target);
		assert.equal(target?.kind, "diff-file");
		assert.equal(target?.diffPath, diffPath);
		assert.equal(target?.userContext, "focus on backup restore edge cases");
	});

	test("throws when --diff file is missing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-missing-"));
		await assert.rejects(
			() => resolveReviewTarget(dir, { diffPath: join(dir, "nope.diff") }),
			/not found/i,
		);
	});
});
