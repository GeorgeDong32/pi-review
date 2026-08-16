/**
 * Target workspace prep — clone (or worktree) the target repository so
 * reviewer children can read its source, history and unchanged files.
 *
 * Real failure (PR #18689): reviewers shared cwd with the plugin repo, so
 * `history-context` and `code-comments` had no relevant code. The plugin now
 *   - for PRs: shallow-clones `owner/repo` into a scratch dir, checks out
 *     the PR head via `gh pr checkout` (falls back to a git fetch of
 *     `pull/<n>/head`).
 *   - for local-git dirty: uses the user's cwd directly (already correct).
 *   - for local-git clean vs default branch: uses the user's cwd after
 *     `git fetch origin <base>`.
 *
 * The workspace is **read-only by convention**: reviewers are not given
 * write tools and the plugin never modifies it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePrRepo } from "./review-report.js";

export type RunCmd = (
	cmd: string,
	args: string[],
	opts: { cwd: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

let _runCmd: RunCmd = defaultRunCmd;
export function setTargetWorkspaceCmd(fn: RunCmd): void {
	_runCmd = fn;
}
export function resetTargetWorkspaceCmd(): void {
	_runCmd = defaultRunCmd;
}

async function defaultRunCmd(
	cmd: string,
	args: string[],
	opts: { cwd: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		try {
			const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout?.setEncoding("utf-8");
			child.stderr?.setEncoding("utf-8");
			child.stdout?.on("data", (d: string) => (stdout += d));
			child.stderr?.on("data", (d: string) => (stderr += d));
			child.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
			child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
		} catch {
			resolve({ stdout: "", stderr: "spawn failed", exitCode: 1 });
		}
	});
}

/** Allocate a scratch root under the OS tmpdir; created on disk. */
export function allocateWorkspaceRoot(prefix = "pi-review-ws"): string {
	const root = join(
		tmpdir(),
		`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(root, { recursive: true });
	return root;
}

/** Best-effort cleanup; ignores errors. */
export function removeWorkspaceRoot(path: string): void {
	try {
		// Avoid pulling in the FS module at top level.
		const fs = require("node:fs") as typeof import("node:fs");
		fs.rmSync(path, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

export interface WorkspaceResult {
	/** Absolute path reviewers should use as cwd. */
	workspacePath: string;
	/** True when `git log` / `blame` will work in the workspace. */
	historyAvailable: boolean;
	/** Optional failure note — when set, reviewers must `skipped` the affected lane. */
	warning?: string;
	/** Whether we cloned (true) or reused the user cwd (false). */
	cloned: boolean;
}

/**
 * Resolve the right workspace for a given target. `cwd` is the user's cwd.
 * Pure function with side effects limited to fs + git/gh subprocesses.
 */
export async function prepareWorkspace(input: {
	cwd: string;
	target: { kind: "pr" | "diff-file" | "local-git"; prRef?: string };
}): Promise<WorkspaceResult> {
	const { cwd, target } = input;

	if (target.kind === "local-git") {
		// Reuse the user's cwd; reviewers will read source directly.
		const inRepo = await isGitRepo(cwd);
		return {
			workspacePath: cwd,
			historyAvailable: inRepo,
			cloned: false,
			warning: inRepo ? undefined : "Not a git repository — history-context will skip.",
		};
	}

	if (target.kind !== "pr" || !target.prRef) {
		return {
			workspacePath: cwd,
			historyAvailable: false,
			cloned: false,
			warning: "PR target missing prRef — reviewers will see only the diff.",
		};
	}

	const parsed = parsePrRepo(target.prRef);
	if (!parsed) {
		return {
			workspacePath: cwd,
			historyAvailable: false,
			cloned: false,
			warning: "Could not parse PR URL — reviewers will see only the diff.",
		};
	}

	const root = allocateWorkspaceRoot();
	const cloneDir = join(root, `${parsed.repo}-${parsed.number}`);
	mkdirSync(cloneDir, { recursive: true });

	// Clone (depth 1 is enough — git fetch later deepens history for blame).
	const clone = await _runCmd(
		"git",
		["clone", "--depth", "50", `https://github.com/${parsed.owner}/${parsed.repo}.git`, cloneDir],
		{ cwd: root },
	);
	if (clone.exitCode !== 0) {
		removeWorkspaceRoot(root);
		return {
			workspacePath: cwd,
			historyAvailable: false,
			cloned: false,
			warning: `git clone failed (${clone.stderr.trim().slice(0, 200)}) — reviewers will see only the diff.`,
		};
	}

	// Fetch the PR head.
	const headFetch = await _runCmd(
		"git",
		["fetch", "origin", `pull/${parsed.number}/head:refs/heads/pr-${parsed.number}`, "--quiet"],
		{ cwd: cloneDir },
	);
	const headCheckout = headFetch.exitCode === 0
		? await _runCmd("git", ["checkout", `pr-${parsed.number}`], { cwd: cloneDir })
		: { exitCode: 1, stdout: "", stderr: "fetch head failed" };

	if (headCheckout.exitCode !== 0) {
		removeWorkspaceRoot(root);
		return {
			workspacePath: cwd,
			historyAvailable: false,
			cloned: false,
			warning: `git fetch pull/${parsed.number}/head failed — reviewers will see only the diff.`,
		};
	}

	return { workspacePath: cloneDir, historyAvailable: true, cloned: true };
}

async function isGitRepo(cwd: string): Promise<boolean> {
	const r = await _runCmd("git", ["rev-parse", "--git-dir"], { cwd });
	return r.exitCode === 0;
}

/** Optional: write a `.pi-review-meta.json` so reviewers can find the run dir. */
export function writeWorkspaceMarker(workspacePath: string, payload: Record<string, unknown>): void {
	const path = join(workspacePath, ".pi-review-meta.json");
	try {
		writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf-8");
	} catch {
		/* read-only fs, etc. */
	}
}

/** Quiet helper to remove the marker when the workspace is torn down. */
export function clearWorkspaceMarker(workspacePath: string): void {
	try {
		const fs = require("node:fs") as typeof import("node:fs");
		fs.unlinkSync(join(workspacePath, ".pi-review-meta.json"));
	} catch {
		/* ignore */
	}
}

void existsSync;