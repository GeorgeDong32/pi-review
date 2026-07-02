/**
 * Default diff source for `/review` when no path is given.
 *
 * Strategy:
 *   1. `git status --porcelain` — if non-empty, return `git diff` of all
 *      uncommitted changes (staged + unstaged + untracked text files).
 *   2. If working tree is clean, probe the default branch and return
 *      `git diff <base>...HEAD`.
 *   3. If not a git repo or every step fails, return null and let the caller
 *      surface a helpful error to the user.
 *
 * The function accepts a `runGit` dependency so tests can mock git output
 * without forking a real repo.
 */
import type { ResolvedInput } from "./types.js";

/** Minimal git invocation. Tests inject a fake. */
export type RunGit = (args: string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

let _runGit: RunGit = defaultRunGit;

/** Override the git runner (tests). */
export function setRunGit(fn: RunGit): void {
	_runGit = fn;
}

/** Reset the git runner to the real child_process.spawn-based implementation. */
export function resetRunGit(): void {
	_runGit = defaultRunGit;
}

async function defaultRunGit(args: string[], opts: { cwd: string }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolve) => {
		try {
			const child = spawn("git", args, {
				cwd: opts.cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.setEncoding("utf-8");
			child.stderr?.setEncoding("utf-8");
			child.stdout?.on("data", (d: string) => (stdout += d));
			child.stderr?.on("data", (d: string) => (stderr += d));
			child.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
			child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
		} catch {
			resolve({ stdout: "", stderr: "", exitCode: 1 });
		}
	});
}

/**
 * Read a path's file content. Tests inject a fake. Falls back to throwing on
 * any error so the caller can surface "file not found".
 */
export type ReadFile = (path: string) => Promise<string>;

let _readFile: ReadFile = async (path) => {
	const { readFile } = await import("node:fs/promises");
	return readFile(path, "utf-8");
};

export function setReadFile(fn: ReadFile): void {
	_readFile = fn;
}

export function resetReadFile(): void {
	_readFile = async (path) => {
		const { readFile } = await import("node:fs/promises");
		return readFile(path, "utf-8");
	};
}

/**
 * Resolve the default diff input for a cwd. Returns null when nothing is
 * available (not a git repo, no changes, no default branch).
 */
export async function resolveDefaultDiff(cwd: string): Promise<ResolvedInput | null> {
	// First: try the porcelain status. If it errors, cwd is not a git repo.
	const status = await _runGit(["status", "--porcelain"], { cwd });
	if (status.exitCode !== 0) {
		return null;
	}

	if (status.stdout.trim().length > 0) {
		// Uncommitted changes — diff working tree against index + staged.
		// `git diff HEAD` covers both staged and unstaged; that is the
		// canonical "what would I commit" view.
		const diff = await _runGit(["diff", "HEAD"], { cwd });
		if (diff.exitCode === 0 && diff.stdout.trim().length > 0) {
			return {
				content: diff.stdout,
				source: { kind: "uncommitted" },
				label: "uncommitted changes",
			};
		}
		// HEAD might not exist (fresh repo) — fall back to `git diff` against
		// the index.
		const diff2 = await _runGit(["diff"], { cwd });
		if (diff2.exitCode === 0 && diff2.stdout.trim().length > 0) {
			return {
				content: diff2.stdout,
				source: { kind: "uncommitted" },
				label: "unstaged changes",
			};
		}
		// Untracked files only — synthesize a diff using `git add -N` style.
		const untracked = await _runGit(["ls-files", "--others", "--exclude-standard"], { cwd });
		if (untracked.exitCode === 0 && untracked.stdout.trim().length > 0) {
			const files = untracked.stdout.trim().split("\n");
			const parts: string[] = [];
			for (const f of files) {
				try {
					const content = await _readFile(joinSafe(cwd, f));
					parts.push(`diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${content.split("\n").length} @@\n${content.split("\n").map((l) => `+${l}`).join("\n")}\n`);
				} catch {
					// Skip unreadable files.
				}
			}
			if (parts.length > 0) {
				return {
					content: parts.join("\n"),
					source: { kind: "uncommitted" },
					label: "untracked files",
				};
			}
		}
		return null;
	}

	// Clean working tree — diff against the default branch.
	const base = await detectDefaultBranch(cwd);
	if (!base) return null;
	const diff = await _runGit(["diff", `${base}...HEAD`], { cwd });
	if (diff.exitCode !== 0) return null;
	if (diff.stdout.trim().length === 0) {
		// No diff vs base — empty commit history?
		return null;
	}
	return {
		content: diff.stdout,
		source: { kind: "vs-default-branch", base },
		label: `vs ${base}`,
	};
}

function joinSafe(cwd: string, file: string): string {
	// Lazy require to avoid bundling path in unit tests that only use mock.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { join } = require("node:path") as typeof import("node:path");
	return join(cwd, file);
}

/**
 * Detect the default branch. Tries, in order:
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` (most common, fastest)
 *   2. Probe `main`, then `master`
 *   3. Return whatever HEAD is
 */
export async function detectDefaultBranch(cwd: string): Promise<string | null> {
	const sym = await _runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd });
	if (sym.exitCode === 0) {
		const v = sym.stdout.trim();
		// Strip the "origin/" prefix if present.
		return v.startsWith("origin/") ? v.slice("origin/".length) : v;
	}
	for (const candidate of ["main", "master"]) {
		const probe = await _runGit(["rev-parse", "--verify", `refs/heads/${candidate}`], { cwd });
		if (probe.exitCode === 0) return candidate;
	}
	// Fall back to the current branch.
	const head = await _runGit(["symbolic-ref", "--short", "HEAD"], { cwd });
	if (head.exitCode === 0) return head.stdout.trim();
	return null;
}
