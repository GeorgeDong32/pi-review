/**
 * Tests for src/git-input.ts: resolveDefaultDiff fallback chain.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, test } from "node:test";

import { detectDefaultBranch, resetReadFile, resetRunGit, resolveDefaultDiff, setReadFile, setRunGit, type RunGit } from "../src/git-input.js";

const gitScript: { [cmd: string]: (args: string[]) => { stdout: string; exitCode: number } } = {};
function setGitScript(plan: typeof gitScript): void {
	Object.keys(gitScript).forEach((k) => delete gitScript[k]);
	Object.assign(gitScript, plan);
}
const fakeRunGit: RunGit = async (args, _opts) => {
	const key = args[0] ?? "";
	for (const pattern of Object.keys(gitScript)) {
		if (key === pattern || pattern === "*") {
			const result = gitScript[pattern](args);
			return { stdout: result.stdout, stderr: "", exitCode: result.exitCode };
		}
	}
	return { stdout: "", stderr: "", exitCode: 1 };
};

function debugRunGit(label: string): RunGit {
	return async (args, _opts) => {
		const r = await fakeRunGit(args, _opts);
		console.log(`[${label}]`, args, "->", r);
		return r;
	};
}
void debugRunGit; // kept for ad-hoc debugging

afterEach(() => {
	resetRunGit();
	resetReadFile();
});

describe("resolveDefaultDiff", () => {
	test("returns null when not a git repo", async () => {
		setRunGit(async () => ({ stdout: "", stderr: "fatal: not a git repo", exitCode: 128 }));
		const result = await resolveDefaultDiff("/tmp");
		assert.equal(result, null);
	});

	test("returns uncommitted diff when working tree is dirty", async () => {
		setGitScript({
			"status": () => ({ stdout: "M src/foo.ts\n", exitCode: 0 }),
			"diff": () => ({ stdout: "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n", exitCode: 0 }),
		});
		setRunGit(fakeRunGit);
		const result = await resolveDefaultDiff("/tmp");
		assert.ok(result);
		assert.equal(result?.source.kind, "uncommitted");
		assert.ok(result?.content.includes("+new"));
	});

	test("falls back to diff against default branch when tree is clean", async () => {
		setGitScript({
			"status": () => ({ stdout: "", exitCode: 0 }),
			"symbolic-ref": (args) => {
				// Real invocation: git symbolic-ref --short refs/remotes/origin/HEAD
				// → args = ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"].
				if (args[2] === "refs/remotes/origin/HEAD") {
					return { stdout: "origin/main\n", exitCode: 0 };
				}
				return { stdout: "", exitCode: 1 };
			},
			"diff": (args) => {
				// args = ["diff", "main...HEAD"] — the comparator is in args[1].
				if (args[1] === "main...HEAD") {
					return { stdout: "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n", exitCode: 0 };
				}
				return { stdout: "", exitCode: 1 };
			},
		});
		setRunGit(fakeRunGit);
		const result = await resolveDefaultDiff("/tmp");
		assert.ok(result);
		assert.equal(result?.source.kind, "vs-default-branch");
		if (result?.source.kind === "vs-default-branch") {
			assert.equal(result.source.base, "main");
		}
	});

	test("returns null when clean tree and no default branch detected", async () => {
		setGitScript({
			"status": () => ({ stdout: "", exitCode: 0 }),
			"symbolic-ref": () => ({ stdout: "", exitCode: 1 }),
			"rev-parse": () => ({ stdout: "", exitCode: 1 }),
		});
		setRunGit(fakeRunGit);
		const result = await resolveDefaultDiff("/tmp");
		assert.equal(result, null);
	});

	test("synthesizes diff for untracked files when tree is dirty with no staged/unstaged", async () => {
		setGitScript({
			"status": () => ({ stdout: "?? new.ts\n", exitCode: 0 }),
			"diff": () => ({ stdout: "", exitCode: 1 }),
			"ls-files": () => ({ stdout: "new.ts\n", exitCode: 0 }),
		});
		setRunGit(fakeRunGit);
		setReadFile(async () => "hello\nworld\n");
		const result = await resolveDefaultDiff("/tmp");
		assert.ok(result);
		assert.equal(result?.source.kind, "uncommitted");
		assert.ok(result?.content.includes("+hello"));
		assert.ok(result?.content.includes("+world"));
	});
});

describe("detectDefaultBranch", () => {
	test("returns main from origin/HEAD when set", async () => {
		setGitScript({
			"symbolic-ref": (args) => {
				// args = ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"].
				if (args[2] === "refs/remotes/origin/HEAD") {
					return { stdout: "origin/main\n", exitCode: 0 };
				}
				return { stdout: "", exitCode: 1 };
			},
		});
		setRunGit(fakeRunGit);
		const result = await detectDefaultBranch("/tmp");
		assert.equal(result, "main");
	});

	test("falls back to probing main", async () => {
		setGitScript({
			"symbolic-ref": () => ({ stdout: "", exitCode: 1 }),
			"rev-parse": (args) => {
				if (args[2] === "refs/heads/main") return { stdout: "abc123", exitCode: 0 };
				return { stdout: "", exitCode: 1 };
			},
		});
		setRunGit(fakeRunGit);
		const result = await detectDefaultBranch("/tmp");
		assert.equal(result, "main");
	});

	test("falls back to probing master when main missing", async () => {
		setGitScript({
			"symbolic-ref": () => ({ stdout: "", exitCode: 1 }),
			"rev-parse": (args) => {
				// Real invocation: git rev-parse --verify refs/heads/<name>.
				// args[0]="rev-parse", args[1]="--verify", args[2]="refs/heads/<name>".
				if (args[2] === "refs/heads/main") return { stdout: "", exitCode: 1 };
				if (args[2] === "refs/heads/master") return { stdout: "abc123", exitCode: 0 };
				return { stdout: "", exitCode: 1 };
			},
		});
		setRunGit(fakeRunGit);
		const result = await detectDefaultBranch("/tmp");
		assert.equal(result, "master");
	});

	test("falls back to current HEAD branch when all else fails", async () => {
		setRunGit(async (args) => {
			const a0 = args[0];
			// Real invocation is `git symbolic-ref --short HEAD` → args = ["symbolic-ref", "--short", "HEAD"].
			if (a0 === "symbolic-ref" && args[2] === "refs/remotes/origin/HEAD") {
				return { stdout: "", stderr: "", exitCode: 1 };
			}
			if (a0 === "rev-parse") {
				return { stdout: "", stderr: "", exitCode: 1 };
			}
			if (a0 === "symbolic-ref" && args[2] === "HEAD") {
				return { stdout: "feature/branch\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		});
		const result = await detectDefaultBranch("/tmp");
		assert.equal(result, "feature/branch");
	});
});
