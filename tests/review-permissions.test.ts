import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
	CC_GH_ALLOW,
	REVIEW_PERMISSION_ALLOW,
	ensureReviewPermissions,
	projectPermissionsLocalPath,
} from "../src/review-permissions.js";

const temps: string[] = [];
afterEach(() => {
	for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("REVIEW_PERMISSION_ALLOW", () => {
	test("includes exact CC gh allowlist (7 rules)", () => {
		assert.equal(CC_GH_ALLOW.length, 7);
		for (const rule of CC_GH_ALLOW) {
			assert.ok(REVIEW_PERMISSION_ALLOW.includes(rule), rule);
			assert.match(rule, /^Bash\(gh /);
			assert.ok(rule.endsWith(":*)"));
		}
	});

	test("includes history git + obtain git + Read/Grep", () => {
		assert.ok(REVIEW_PERMISSION_ALLOW.includes("Bash(git blame:*)"));
		assert.ok(REVIEW_PERMISSION_ALLOW.includes("Bash(git log:*)"));
		assert.ok(REVIEW_PERMISSION_ALLOW.includes("Bash(git diff:*)"));
		assert.ok(REVIEW_PERMISSION_ALLOW.includes("Bash(git fetch:*)"));
		assert.ok(REVIEW_PERMISSION_ALLOW.includes("Bash(git merge-base:*)"));
		assert.ok(REVIEW_PERMISSION_ALLOW.includes("Read"));
		assert.ok(REVIEW_PERMISSION_ALLOW.includes("Grep"));
	});
});

describe("ensureReviewPermissions", () => {
	test("creates permissions.local.json and merges allow rules", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-review-perm-"));
		temps.push(cwd);
		const first = ensureReviewPermissions(cwd);
		assert.equal(first.added.length, REVIEW_PERMISSION_ALLOW.length);
		const path = projectPermissionsLocalPath(cwd);
		assert.equal(first.path, path);
		const raw = JSON.parse(readFileSync(path, "utf-8")) as {
			permissions: { allow: string[] };
		};
		assert.ok(raw.permissions.allow.includes("Bash(gh pr diff:*)"));

		const second = ensureReviewPermissions(cwd);
		assert.equal(second.added.length, 0);
		assert.equal(second.alreadyPresent, REVIEW_PERMISSION_ALLOW.length);
	});
});
