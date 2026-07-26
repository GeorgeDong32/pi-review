import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
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

	test("sets userContext from input (user review request)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-review-ctx-"));
		setRunGh(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));

		const target = await resolveReviewTarget(dir, {
			input: "https://github.com/org/repo/pull/77",
		});
		assert.ok(target);
		// Freeform input flows through as the user review request.
		assert.equal(target?.userContext, "https://github.com/org/repo/pull/77");
	});
});
