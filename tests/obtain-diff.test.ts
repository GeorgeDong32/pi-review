import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { buildObtainDiffScript } from "../src/obtain-diff.js";

const CWD = "/tmp/pi-review-obtain";
const paths = {
	cwd: CWD,
	diffPath: `${CWD}/.pi/pi-review/change.diff`,
	filesPath: `${CWD}/.pi/pi-review/changed-files.txt`,
	kindPath: `${CWD}/.pi/pi-review/change-kind.txt`,
	metaPath: `${CWD}/.pi/pi-review/diff-meta.txt`,
};

describe("buildObtainDiffScript", () => {
	test("local clean path fetches origin base and three-dots against COMP", () => {
		const s = buildObtainDiffScript(paths);
		assert.match(s, /git status --porcelain/);
		assert.match(s, /git fetch origin "\$BASE"/);
		assert.match(s, /origin\/\$BASE/);
		assert.match(s, /git diff "\$COMP\.\.\.HEAD"/);
		assert.match(s, /mode=vs-default/);
		assert.match(s, /merge_base=/);
		assert.match(s, /diff-meta\.txt|META=/);
	});

	test("PR path prefers gh pr diff then fetch pull\/N\/head fallback", () => {
		const s = buildObtainDiffScript({
			...paths,
			prRef: "https://github.com/o/r/pull/42",
		});
		assert.match(s, /gh pr diff 'https:\/\/github\.com\/o\/r\/pull\/42'/);
		assert.match(s, /mode=gh-pr-diff/);
		assert.match(s, /pull\/\$PR_NUM\/head:refs\/pi-review\/pr-head/);
		assert.match(s, /mode=git-pr-fallback/);
		assert.match(s, /git fetch origin "\$PR_BASE"/);
	});

	test("dirty path uses git diff HEAD without fetch", () => {
		const s = buildObtainDiffScript(paths);
		assert.match(s, /mode=uncommitted/);
		assert.match(s, /git diff HEAD >/);
	});
});
