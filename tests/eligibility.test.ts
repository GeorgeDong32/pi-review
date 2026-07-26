import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { checkEligibility, isTrivialDiff } from "../src/eligibility.js";

describe("checkEligibility", () => {
	test("rejects when no target and not git", () => {
		const r = checkEligibility({ target: null, hasExplicitInput: false, isGitRepo: false });
		assert.equal(r.eligible, false);
	});

	test("accepts PR target without probed diff content", () => {
		const r = checkEligibility({
			target: {
				kind: "pr",
				label: "PR 1 (agent-fetch)",
				prRef: "https://github.com/org/repo/pull/1",
			},
			hasExplicitInput: true,
			isGitRepo: true,
		});
		assert.equal(r.eligible, true);
	});

	test("rejects trivial probed local diff", () => {
		const r = checkEligibility({
			target: { kind: "local-git", label: "uncommitted" },
			hasExplicitInput: false,
			isGitRepo: true,
			probedDiff: "diff --git a/a b/a\n+line\n",
		});
		assert.equal(r.eligible, false);
	});

	test("accepts local-git without probe", () => {
		const r = checkEligibility({
			target: { kind: "local-git", label: "vs main (agent-fetch)" },
			hasExplicitInput: false,
			isGitRepo: true,
		});
		assert.equal(r.eligible, true);
	});
});

describe("isTrivialDiff", () => {
	test("empty is trivial", () => {
		assert.equal(isTrivialDiff(""), true);
	});

	test("few lines is trivial", () => {
		assert.equal(isTrivialDiff("--- a\n+++ b\n+one\n"), true);
	});
});
