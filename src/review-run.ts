/**
 * High-level orchestration for `/review` v0.7:
 *   1. Resolve the ReviewTarget (PR URL / local-git / --diff).
 *   2. Acquire an accurate diff + SHA-256 + changed-files via the plugin's
 *      own `gh`/`git` calls (never re-fetched by reviewers).
 *   3. Prepare a target workspace (clone for PRs, user's cwd for local).
 *   4. Write the run manifest so reviewers + the report tool can read it.
 *   5. Build + emit the directive (now: single `subagent` call followed by
 *      the `pi_review_report` tool).
 *
 * This replaces the old "main agent obtains the diff itself" pattern that
 * silently failed on cross-repo PRs.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, loadConfig, resolveModel } from "./config.js";
import { buildReviewDirective } from "./directive.js";
import { extractPrRef } from "./pr-ref.js";
import {
	RunManifest,
	WORKSPACE_TTL_MS,
	discoverRulePathsLocal,
	ensureRunDir,
	generateRunId,
	parseChangedFilesFromDiff,
	parsePrRepo,
	pruneStaleRuns,
	readManifest,
	resetRunCmd,
	setRunCmd,
	sha256Hex,
	writeDiff,
	writeManifest,
} from "./review-report.js";
import {
	prepareWorkspace,
	resetTargetWorkspaceCmd,
	setTargetWorkspaceCmd,
} from "./target-workspace.js";
import type { ReviewTarget } from "./types.js";

export interface PrepareRunInput {
	cwd: string;
	input?: string;
	/** Support `--lite` single-agent mode. */
	lite?: boolean;
	/** Optional per-run gate model override. */
	gateModel?: string;
}

export interface PreparedRun {
	runId: string;
	manifest: RunManifest;
	directive: string;
	/** Path the main agent will receive as the directive message. */
	directiveText: string;
}

/** Public entrypoint for `index.ts` — prepare a run synchronously. */
export async function prepareRun(input: PrepareRunInput): Promise<PreparedRun | null> {
	const cwd = input.cwd;
	const { config } = loadConfig();
	const target = await resolveReviewTarget(input.cwd, { input: input.input });
	if (!target) return null;

	pruneStaleRuns(cwd);
	pruneLegacyFlatArtifacts(cwd);
	pruneStaleWorkspaces();

	const runId = generateRunId();
	const runDir = ensureRunDir(cwd, runId);

	const diffResult = await acquireDiff(cwd, target, runDir);
	const changedFiles = parseChangedFilesFromDiff(diffResult.diff);
	const rulePaths = discoverRulePathsLocal(cwd);
	// Pass the diff's head SHA so the workspace checkout can verify it landed
	// on the same commit (guards the force-push-between-calls TOCTOU window).
	let workspaceResult = await prepareWorkspace({
		cwd,
		target: { kind: target.kind, prRef: target.prRef, expectedHeadSha: diffResult.headSha },
	});
	if (workspaceResult.cloned && diffResult.headSha && workspaceResult.workspaceHeadSha &&
		workspaceResult.workspaceHeadSha !== diffResult.headSha) {
		// Retry once — a force-push may have raced the first clone.
		workspaceResult = await prepareWorkspace({
			cwd,
			target: { kind: target.kind, prRef: target.prRef, expectedHeadSha: diffResult.headSha },
		});
		if (workspaceResult.workspaceHeadSha && workspaceResult.workspaceHeadSha !== diffResult.headSha) {
			throw new Error(
				`pi-review: workspace HEAD ${workspaceResult.workspaceHeadSha.slice(0, 12)} does not match diff head ${diffResult.headSha.slice(0, 12)} — the PR moved during preparation; re-run /review.`,
			);
		}
	}

	const manifest: RunManifest = {
		runId,
		targetLabel: target.label,
		targetKind: target.kind,
		prRef: target.prRef,
		diffPath: diffResult.path,
		diffSha256: sha256Hex(diffResult.diff),
		changedFiles: changedFiles.files,
		docsOnly: changedFiles.docsOnly,
		rulePaths,
		historyAvailable: workspaceResult.historyAvailable,
		mode: diffResult.mode,
		baseSha: diffResult.baseSha,
		headSha: diffResult.headSha,
		mergeBase: diffResult.mergeBase,
		workspacePath: workspaceResult.workspacePath,
		workspaceHeadSha: workspaceResult.workspaceHeadSha,
		workspaceWarning: workspaceResult.warning,
		runDir,
		createdAt: Date.now(),
	};

	const gateModel = resolveModel(input.gateModel ?? config.gate.model, undefined);
	// Trivial change guard: an empty/placeholder diff (no +/- hunks) is not
	// worth fanning out reviewers.
	if (changedFiles.additions + changedFiles.deletions === 0) {
		return null;
	}
	const profile: ChangeProfile = {
		docsOnly: changedFiles.docsOnly,
		rulePaths,
		historyAvailable: workspaceResult.historyAvailable,
	};
	const reviewers = input.lite
		? [{ id: "lite-review", label: "Lite Review", enabled: true, model: "inherit" }]
		: reviewersForRouting(target, config, profile);
	const skippedReasons = adaptiveSkips(profile);
	const workspacePath = manifest.workspacePath;
	const manifestPath = join(runDir, "manifest.json");
	const diffPath = manifest.diffPath;
	// Build the directive with real paths inlined (JSON.stringify'd into the
	// workflowScript) — no placeholder + replaceAll substitutions. The old
	// replaceAll injected unquoted paths into the JS template, producing
	// invalid JS (`cwd: /var/folders/...` → SyntaxError).
	const directive = buildReviewDirective({
		target,
		reviewers,
		gateModel,
		gateThinking: input.lite ? undefined : config.gate.thinking,
		threshold: config.gate.threshold,
		verdictPolicy: config.gate.verdictPolicy,
		lite: Boolean(input.lite),
		cwd,
		workspacePath,
		manifestPath,
		diffPath,
	});
	// Remember which lanes adaptive routing dropped so the report can surface
	// them as coverage rather than letting users wonder where a reviewer went.
	if (!input.lite && config.routing.mode === "adaptive" && skippedReasons.length > 0) {
		const skippedByRouting: Array<{ id: string; reason: string }> = [];
		for (const [id, reason] of skippedReasons) {
			if (!reviewers.some((r) => r.id === id)) skippedByRouting.push({ id, reason });
		}
		manifest.skippedReviewers = skippedByRouting;
	}
	writeManifest(runDir, manifest);

	const directiveText = directive;

	return { runId, manifest, directive, directiveText };
}

/** Read a previously-prepared manifest from disk. */
export function loadManifestFor(cwd: string, runId: string): RunManifest {
	const runDir = join(cwd, ".pi", "pi-review", "runs", runId);
	return readManifest(runDir);
}

/* ------------------------------------------------------------------ */
/* Diff acquisition — replaces `src/obtain-diff.ts`'s bash block.     */
/* ------------------------------------------------------------------ */

interface DiffAcquisitionResult {
	path: string;
	diff: string;
	mode: RunManifest["mode"];
	baseSha?: string;
	headSha?: string;
	mergeBase?: string;
}

async function acquireDiff(
	cwd: string,
	target: ReviewTarget,
	runDir: string,
): Promise<DiffAcquisitionResult> {
	if (target.kind === "pr" && target.prRef) {
		return acquirePrDiff(cwd, target.prRef, runDir);
	}
	if (target.kind === "diff-file" && target.diffPath) {
		const text = safeRead(target.diffPath);
		const path = writeDiff(runDir, text);
		return { path, diff: text, mode: "local-uncommitted" };
	}
	return acquireLocalDiff(cwd, runDir);
}

async function acquirePrDiff(
	cwd: string,
	prRef: string,
	runDir: string,
): Promise<DiffAcquisitionResult> {
	const gh = await _runCmd(
		"gh",
		["pr", "view", prRef, "--json", "number,baseRefName,baseRefOid,headRefOid,headRepository,headRepositoryOwner"],
		{ cwd },
	);
	let prMeta: {
		number?: string;
		baseRefName?: string;
		baseRefOid?: string;
		headRefOid?: string;
		headRepository?: { name?: string };
		headRepositoryOwner?: { login?: string };
	} | null = null;
	if (gh.exitCode === 0 && gh.stdout.trim()) {
		try {
			prMeta = JSON.parse(gh.stdout);
		} catch {
			prMeta = null;
		}
	}

	const ghDiff = await _runCmd("gh", ["pr", "diff", prRef], { cwd });
	if (ghDiff.exitCode === 0 && ghDiff.stdout.trim().length > 0) {
		const path = writeDiff(runDir, ghDiff.stdout);
		return {
			path,
			diff: ghDiff.stdout,
			mode: "gh-pr-diff",
			baseSha: prMeta?.baseRefOid,
			headSha: prMeta?.headRefOid,
		};
	}

	return acquirePrDiffViaGit(cwd, prRef, runDir, 0);
}

/**
 * Git fallback when `gh pr diff` is unavailable.
 *
 * Hardening (post-mortem of the 2026-08-12 incident where a stale local ref
 * produced an 8583-line diff for a 3-file PR):
 *   - refresh the base remote-tracking ref with a forced fetch BEFORE
 *     computing the merge-base (a stale origin/main skews the whole diff);
 *   - fetch the PR head into FETCH_HEAD only — never a named branch, so a
 *     previously-created ref can never be silently reused;
 *   - verify the fetched head matches `gh pr view`'s headRefOid; on mismatch
 *     (PR force-pushed between calls) retry once, then fail loudly instead
 *     of reviewing the wrong commits.
 */
async function acquirePrDiffViaGit(
	cwd: string,
	prRef: string,
	runDir: string,
	attempt: number,
): Promise<DiffAcquisitionResult> {
	const view = await _runCmd(
		"gh",
		["pr", "view", prRef, "--json", "number,baseRefName,baseRefOid,headRefOid"],
		{ cwd },
	);
	let prMeta: { number?: string; baseRefName?: string; baseRefOid?: string; headRefOid?: string } | null = null;
	if (view.exitCode === 0 && view.stdout.trim()) {
		try {
			prMeta = JSON.parse(view.stdout);
		} catch {
			prMeta = null;
		}
	}
	const parsed = parsePrRepo(prRef);
	const number = prMeta?.number ?? parsed?.number ?? prRef.match(/(\d+)/)?.[1] ?? "";
	if (!number) {
		throw new Error(`pi-review: could not parse PR number from ${prRef} — refusing to guess a diff base.`);
	}
	const baseName = prMeta?.baseRefName ?? "main";
	const expectedHead = prMeta?.headRefOid;

	// 1) Refresh the base remote-tracking ref (force handles rewind).
	const baseFetch = await _runCmd(
		"git",
		["fetch", "origin", `+refs/heads/${baseName}:refs/remotes/origin/${baseName}`, "--quiet"],
		{ cwd },
	);
	// 2) Fetch the PR head into FETCH_HEAD (no named ref → no stale reuse).
	const headFetch = await _runCmd("git", ["fetch", "origin", `pull/${number}/head`, "--quiet"], { cwd });
	if (baseFetch.exitCode !== 0 || headFetch.exitCode !== 0) {
		throw new Error(
			`pi-review: git fallback failed to fetch PR ${number} (base: ${baseFetch.stderr.trim().slice(0, 120)}; head: ${headFetch.stderr.trim().slice(0, 120)}). Not falling back to stale local refs — fix gh auth/network and re-run.`,
		);
	}
	const fetchHead = (await _runCmd("git", ["rev-parse", "FETCH_HEAD"], { cwd })).stdout.trim();
	if (!fetchHead) {
		throw new Error(`pi-review: FETCH_HEAD empty after fetching PR ${number} — aborting instead of guessing.`);
	}
	if (expectedHead && fetchHead !== expectedHead) {
		if (attempt === 0) {
			// PR moved between gh view and fetch — one retry with fresh metadata.
			return acquirePrDiffViaGit(cwd, prRef, runDir, attempt + 1);
		}
		throw new Error(
			`pi-review: fetched PR ${number} head ${fetchHead.slice(0, 12)} != GitHub headRefOid ${expectedHead.slice(0, 12)} after retry — the PR is moving; re-run /review when it settles.`,
		);
	}

	const baseRef = (await _runCmd("git", ["rev-parse", "--verify", `refs/remotes/origin/${baseName}`], { cwd })).exitCode === 0
		? `refs/remotes/origin/${baseName}`
		: `origin/${baseName}`;
	const mergeBase = (await _runCmd("git", ["merge-base", baseRef, "FETCH_HEAD"], { cwd })).stdout.trim();
	const diffRes = await _runCmd("git", ["diff", `${baseRef}...FETCH_HEAD`], { cwd });
	const text = diffRes.stdout.length > 0 ? diffRes.stdout : "(no diff captured)\n";
	const path = writeDiff(runDir, text);
	return {
		path,
		diff: text,
		mode: "git-pr-fallback",
		baseSha: prMeta?.baseRefOid ?? mergeBase,
		headSha: expectedHead ?? fetchHead,
		mergeBase,
	};
}

async function acquireLocalDiff(cwd: string, runDir: string): Promise<DiffAcquisitionResult> {
	const status = await _runCmd("git", ["status", "--porcelain"], { cwd });
	if (status.stdout.trim().length > 0) {
		const diff = await _runCmd("git", ["diff", "HEAD"], { cwd });
		const text = diff.stdout.length > 0 ? diff.stdout : "";
		if (text) {
			const path = writeDiff(runDir, text);
			return { path, diff: text, mode: "local-uncommitted", headSha: await safeRev(cwd, "HEAD") };
		}
		const diff2 = await _runCmd("git", ["diff"], { cwd });
		const text2 = diff2.stdout;
		if (text2.length > 0) {
			const path = writeDiff(runDir, text2);
			return { path, diff: text2, mode: "local-uncommitted", headSha: await safeRev(cwd, "HEAD") };
		}
		const untracked = (await _runCmd("git", ["ls-files", "--others", "--exclude-standard"], { cwd })).stdout;
		if (untracked.trim().length > 0) {
			const files = untracked.trim().split("\n");
			const parts: string[] = [];
			for (const f of files) {
				try {
					const content = readFileSync(join(cwd, f), "utf-8");
					const lines = content.split("\n");
					parts.push(
						`diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`,
					);
				} catch {
					/* ignore */
				}
			}
			const text = parts.join("\n");
			const path = writeDiff(runDir, text);
			return { path, diff: text, mode: "local-uncommitted" };
		}
	}

	const base = await detectDefaultBranch(cwd);
	if (!base) {
		const placeholder = `(no diff captured: clean tree, no default branch detected)\n`;
		const path = writeDiff(runDir, placeholder);
		return { path, diff: placeholder, mode: "local-vs-default" };
	}
	await _runCmd("git", ["fetch", "origin", base, "--quiet"], { cwd });
	const compare = (await _runCmd("git", ["rev-parse", "--verify", `origin/${base}`], { cwd })).exitCode === 0
		? `origin/${base}`
		: base;
	const diff = await _runCmd("git", ["diff", `${compare}...HEAD`], { cwd });
	const text = diff.stdout.length > 0 ? diff.stdout : `(no diff vs ${compare})\n`;
	const path = writeDiff(runDir, text);
	return {
		path,
		diff: text,
		mode: "local-vs-default",
		baseSha: await safeRev(cwd, compare),
		headSha: await safeRev(cwd, "HEAD"),
		mergeBase: (await _runCmd("git", ["merge-base", compare, "HEAD"], { cwd })).stdout.trim() || undefined,
	};
}

async function safeRev(cwd: string, ref: string): Promise<string | undefined> {
	const r = await _runCmd("git", ["rev-parse", ref], { cwd });
	if (r.exitCode !== 0) return undefined;
	return r.stdout.trim() || undefined;
}

async function detectDefaultBranch(cwd: string): Promise<string | null> {
	const sym = await _runCmd("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd });
	if (sym.exitCode === 0) {
		const v = sym.stdout.trim();
		return v.startsWith("origin/") ? v.slice("origin/".length) : v;
	}
	for (const candidate of ["main", "master"]) {
		const probe = await _runCmd("git", ["rev-parse", "--verify", `refs/heads/${candidate}`], { cwd });
		if (probe.exitCode === 0) return candidate;
	}
	const head = await _runCmd("git", ["symbolic-ref", "--short", "HEAD"], { cwd });
	if (head.exitCode === 0) return head.stdout.trim();
	return null;
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

let _runCmd: (cmd: string, args: string[], opts: { cwd: string }) => Promise<CmdResult>;
async function defaultRunCmd(
	cmd: string,
	args: string[],
	opts: { cwd: string },
): Promise<CmdResult> {
	const { spawn } = await import("node:child_process");
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
_runCmd = defaultRunCmd;

/** Tests inject a fake. */
export function setReviewRunCmd(fn: (cmd: string, args: string[], opts: { cwd: string }) => Promise<CmdResult>): void {
	_runCmd = fn;
}
export function resetReviewRunCmd(): void {
	_runCmd = defaultRunCmd;
}

/* ------------------------------------------------------------------ */
/* Reviewer roster — adaptive routing based on target / change-kind.  */
/* ------------------------------------------------------------------ */

import type { PiReviewConfig, ReviewerSpec } from "./types.js";

export interface ChangeProfile {
	docsOnly: boolean;
	rulePaths: string[];
	historyAvailable: boolean;
}

/**
 * Select enabled reviewers, then — in `adaptive` mode — drop lanes that
 * cannot add signal for THIS change:
 *  - no rule files          → skip claude-md-compliance
 *  - docs-only diff         → skip bugbot / security-review (no code to scan)
 *  - no git history         → skip history-context
 *  - docs-only              → skip code-comments (nothing but prose touched)
 *
 * The directive still tells reviewer children to return `status: skipped`
 * for these conditions when running in `routing.mode = "all"`, so coverage
 * stays honest even when the lane cannot run.
 */
export function reviewersForRouting(
	target: ReviewTarget,
	config: PiReviewConfig,
	profile?: ChangeProfile,
): ReviewerSpec[] {
	const all = Object.values(config.reviewers).filter((r) => r.enabled);
	if (config.routing.mode !== "adaptive" || !profile) return all;

	const skippedReasons = adaptiveSkips(profile);
	if (skippedReasons.length === 0) return all;

	const reasons = new Map(skippedReasons);
	return all.filter((r) => !reasons.has(r.id));
}

/** Return reviewer-id → reason for every lane that adaptive mode should drop. */
export function adaptiveSkips(profile: ChangeProfile): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	if (profile.rulePaths.length === 0) {
		out.push(["claude-md-compliance", "no rule files (AGENTS.md / CLAUDE.md / .pi rules)"]);
	}
	if (profile.docsOnly) {
		out.push(["bugbot", "docs-only change (no code to scan)"]);
		out.push(["security-review", "docs-only change (no code to scan)"]);
		out.push(["code-comments", "docs-only change (no inline comments to violate)"]);
	}
	if (!profile.historyAvailable) {
		out.push(["history-context", "no git history available in the target workspace"]);
	}
	return out;
}

function safeRead(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

/**
 * One-time-per-run回收 of the v0.5/0.6 flat layout (`.pi/pi-review/*.txt`
 * + `change.diff` at the root). Those leftovers were repeatedly misread as
 * the current run's inputs by later sessions; only known legacy filenames
 * directly under `.pi/pi-review/` are touched — `runs/` is never scanned.
 */
export function pruneLegacyFlatArtifacts(cwd: string): string[] {
	const root = join(cwd, ".pi", "pi-review");
	const legacyNames = ["change.diff", "changed-files.txt", "change-kind.txt", "diff-meta.txt"];
	const removed: string[] = [];
	for (const name of legacyNames) {
		const p = join(root, name);
		try {
			if (existsSync(p)) {
				rmSync(p, { force: true });
				removed.push(p);
			}
		} catch {
			/* best effort */
		}
	}
	return removed;
}

/** Prune scratch workspace clones older than WORKSPACE_TTL_MS from the tmpdir. */
export function pruneStaleWorkspaces(now = Date.now()): string[] {
	const removed: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(tmpdir());
	} catch {
		return removed;
	}
	for (const entry of entries) {
		if (!entry.startsWith("pi-review-ws-")) continue;
		const path = join(tmpdir(), entry);
		try {
			const stat = statSync(path);
			if (now - stat.mtimeMs > WORKSPACE_TTL_MS) {
				rmSync(path, { recursive: true, force: true });
				removed.push(path);
			}
		} catch {
			/* already gone or unreadable */
		}
	}
	return removed;
}

/** Resolve a ReviewTarget locally (mirrors src/git-input.ts without the `gh pr diff` call). */
async function resolveReviewTarget(
	cwd: string,
	opts: { input?: string },
): Promise<ReviewTarget | null> {
	const userContext = opts.input?.trim() || undefined;
	const prRef = userContext ? extractPrRef(userContext) : null;
	if (prRef) {
		return {
			kind: "pr",
			label: prLabel(prRef),
			userContext,
			prRef,
			hint: `Obtain PR ${prRef} yourself via gh and/or git. The plugin already prepared the target repo + diff.`,
		};
	}
	const git = await _runCmd("git", ["rev-parse", "--git-dir"], { cwd }).then((r) => r.exitCode === 0);
	if (!git) return null;
	const status = await _runCmd("git", ["status", "--porcelain"], { cwd });
	const dirty = status.stdout.trim().length > 0;
	const base = await detectDefaultBranch(cwd);
	const baseHint = base ?? "main";
	if (dirty) {
		return {
			kind: "local-git",
			label: "uncommitted changes",
			userContext,
			hint: "Working tree is dirty.",
		};
	}
	return {
		kind: "local-git",
		label: `vs ${baseHint}`,
		userContext,
		hint: `Working tree is clean. Diff vs ${baseHint} is already prepared.`,
	};
}

function prLabel(prRef: string): string {
	const n = prRef.match(/pull\/(\d+)/i)?.[1] ?? prRef.replace(/^#/, "");
	return `PR ${n}`;
}

// Re-exports for tests
export { setRunCmd, resetRunCmd, setTargetWorkspaceCmd, resetTargetWorkspaceCmd };

void DEFAULT_CONFIG;
void writeFileSync;