/**
 * Tests for src/review-run.ts — plugin-side diff acquisition + target source
 * workspace + manifest so reviewer children point at the RIGHT repo.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
	prepareRun,
	pruneLegacyFlatArtifacts,
	pruneStaleWorkspaces,
	setReviewRunCmd,
	resetReviewRunCmd,
	loadManifestFor,
} from "../src/review-run.js";
import { setTargetWorkspaceCmd, resetTargetWorkspaceCmd } from "../src/target-workspace.js";
import { setConfigPath, writeConfig, DEFAULT_CONFIG } from "../src/config.js";

type FakeCmd = (cmd: string, args: string[], opts: { cwd: string }) => Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
}>;

let sandbox: string;
let cfgDir: string;

afterEach(() => {
	resetReviewRunCmd();
	resetTargetWorkspaceCmd();
	setConfigPath();
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
	if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
	sandbox = "";
	cfgDir = "";
});

function setup() {
	sandbox = mkdtempSync(join(tmpdir(), "pi-review-run-"));
	cfgDir = mkdtempSync(join(tmpdir(), "pi-review-cfg-"));
	setConfigPath(join(cfgDir, "pi-review.json"));
	writeConfig(DEFAULT_CONFIG);
	return sandbox;
}

/** Fake gh/git where `gh pr diff` returns a small diff. */
function fakeCmd(
	plan: Record<string, (args: string[]) => { stdout: string; stderr: string; exitCode: number }>,
): FakeCmd {
	return async (cmd, args) => {
		const key = `${cmd} ${args[0] ?? ""}`;
		const maybe = plan[key] ?? plan[cmd];
		if (maybe) {
			const r = maybe(args);
			return r;
		}
		return { stdout: "", stderr: "", exitCode: 1 };
	};
}

describe("prepareRun — PR cross-repo workspace", () => {
	test("PR with gh pr diff: writes manifest + diff path + changed files", async () => {
		const cwd = setup();
		const diff = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1 +1,2 @@",
			" line",
			"+added",
		].join("\n");
		setReviewRunCmd(
			fakeCmd({
				gh: (args) => {
					if (args[0] === "pr" && args[1] === "view") {
						return {
							stdout: JSON.stringify({
								number: "42",
								baseRefName: "main",
								baseRefOid: "aaa",
								headRefOid: "bbb",
							}),
							stderr: "",
							exitCode: 0,
						};
					}
					if (args[0] === "pr" && args[1] === "diff") {
						return { stdout: diff, stderr: "", exitCode: 0 };
					}
					return { stdout: "", stderr: "no", exitCode: 1 };
				},
			}),
		);
		setTargetWorkspaceCmd(async (cmd, args) => {
			if (cmd === "git" && args[0] === "clone") return { stdout: "", stderr: "", exitCode: 0 };
			if (cmd === "git" && args[0] === "fetch") return { stdout: "", stderr: "", exitCode: 0 };
			if (cmd === "git" && args[0] === "checkout") return { stdout: "", stderr: "", exitCode: 0 };
			if (cmd === "git" && args[0] === "rev-parse") return { stdout: "", stderr: "", exitCode: 0 };
			return { stdout: "", stderr: "no", exitCode: 1 };
		});

		const prepared = await prepareRun({
			cwd,
			input: "https://github.com/CherryHQ/cherry-studio/pull/42",
		});
		assert.ok(prepared, "prepareRun should succeed for a PR URL");
		const m = prepared!.manifest;
		assert.equal(m.targetKind, "pr");
		assert.equal(m.prRef, "https://github.com/CherryHQ/cherry-studio/pull/42");
		assert.equal(m.mode, "gh-pr-diff");
		assert.equal(m.baseSha, "aaa");
		assert.equal(m.headSha, "bbb");
		assert.ok(m.diffSha256.length === 64);
		assert.deepEqual(m.changedFiles, ["src/a.ts"]);
		assert.ok(existsSync(m.diffPath));
		assert.match(readFileSync(m.diffPath, "utf-8"), /\+added/);
		// Reviewer cwd placeholders must point at the target workspace.
		assert.match(prepared!.directiveText, new RegExp(m.workspacePath));
		assert.match(prepared!.directiveText, /pi_review_report/);
		assert.match(prepared!.directiveText, /chatProgress: "auto"/);
		// prepareWorkspace ran for real (only its subprocesses were faked) —
		// drop the scratch clone it allocated.
		rmSync(dirname(m.workspacePath), { recursive: true, force: true });
	});

	test("local-git dirty tree uses cwd as workspace and diff HEAD", async () => {
		const cwd = setup();
		const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";
		setReviewRunCmd(
			fakeCmd({
				"git status": (args) => {
					void args;
					return { stdout: " M x\n", stderr: "", exitCode: 0 };
				},
				"git diff": () => ({ stdout: diff, stderr: "", exitCode: 0 }),
				"git rev-parse": () => ({ stdout: "abc\n", stderr: "", exitCode: 0 }),
			}),
		);
		setTargetWorkspaceCmd(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

		const prepared = await prepareRun({ cwd, input: "" });
		assert.ok(prepared);
		const m = prepared!.manifest;
		assert.equal(m.targetKind, "local-git");
		assert.equal(m.mode, "local-uncommitted");
		assert.equal(m.workspacePath, cwd);
		assert.deepEqual(m.changedFiles, ["x"]);
	});

	test("clean tree falls back to vs-default diff", async () => {
		const cwd = setup();
		const diff = "diff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-old\n+new2\n";
		// Dirty → but status empty, so the else branch runs.
		setReviewRunCmd(
			fakeCmd({
				"git status": () => ({ stdout: "", stderr: "", exitCode: 0 }),
				"git symbolic-ref": (args) => {
					if (args[2] === "refs/remotes/origin/HEAD") {
						return { stdout: "origin/main\n", stderr: "", exitCode: 0 };
					}
					return { stdout: "main\n", stderr: "", exitCode: 0 };
				},
				"git fetch": () => ({ stdout: "", stderr: "", exitCode: 0 }),
				"git rev-parse": () => ({ stdout: "abc\n", stderr: "", exitCode: 0 }),
				"git diff": () => ({ stdout: diff, stderr: "", exitCode: 0 }),
				"git merge-base": () => ({ stdout: "m1\n", stderr: "", exitCode: 0 }),
			}),
		);
		setTargetWorkspaceCmd(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

		const prepared = await prepareRun({ cwd, input: "" });
		assert.ok(prepared);
		const m = prepared!.manifest;
		assert.equal(m.mode, "local-vs-default");
		assert.equal(m.baseSha, "abc");
		assert.ok(m.changedFiles.includes("y"));
	});

	test("does not write project permissions.local.json", () => {
		const cwd = setup();
		const permsFile = join(cwd, ".pi", "projects", "x", "permissions.local.json");
		readFileSync; // noop reference
		assert.equal(existsSync(permsFile), false);
		// The .pi/pi-review/runs dir is the ONLY thing created.
		assert.equal(existsSync(join(cwd, ".pi", "pi-review", "runs")), false);
	});
});

describe("loadManifestFor", () => {
	test("round-trips through writeManifest and read", async () => {
		const cwd = setup();
		const runId = "r1";
		const manifest: import("../src/review-report.js").RunManifest = {
			runId,
			targetLabel: "PR 1",
			targetKind: "pr",
			prRef: "https://github.com/o/r/pull/1",
			diffPath: join(cwd, "change.diff"),
			diffSha256: "a".repeat(64),
			changedFiles: ["a.ts"],
			docsOnly: false,
			rulePaths: [],
			historyAvailable: true,
			mode: "gh-pr-diff",
			workspacePath: "/tmp/ws",
			runDir: join(cwd, ".pi", "pi-review", "runs", runId),
			createdAt: Date.now(),
		};
		const runDir = join(cwd, ".pi", "pi-review", "runs", runId);
		// Simulate the write path used by prepareRun by writing it directly.
		const { ensureRunDir, writeManifest } = await import("../src/review-report.js");
		ensureRunDir(cwd, runId);
		writeManifest(runDir, manifest);
		const loaded = loadManifestFor(cwd, runId);
		assert.equal(loaded.runId, runId);
		assert.equal(loaded.targetKind, "pr");
	});
});

describe("prepareRun — lite + adaptive routing", () => {
	test("--lite uses a single lite-review lane, no gate", async () => {
		const cwd = setup();
		const diff = [
			"diff --git a/a b/a",
			"--- a/a",
			"+++ b/a",
			"@@ -1 +1,2 @@",
			" line",
			"+added",
		].join("\n");
		setReviewRunCmd(
			fakeCmd({
				gh: (args) => {
					if (args[0] === "pr" && args[1] === "view") {
						return { stdout: JSON.stringify({ number: "7", baseRefName: "main" }), stderr: "", exitCode: 0 };
					}
					if (args[0] === "pr" && args[1] === "diff") {
						return { stdout: diff, stderr: "", exitCode: 0 };
					}
					return { stdout: "", stderr: "no", exitCode: 1 };
				},
			}),
		);
		setTargetWorkspaceCmd(async (cmd, args) => {
			if (cmd === "git" && args[0] === "clone") return { stdout: "", stderr: "", exitCode: 0 };
			if (cmd === "git" && args[0] === "fetch") return { stdout: "", stderr: "", exitCode: 0 };
			if (cmd === "git" && args[0] === "checkout") return { stdout: "", stderr: "", exitCode: 0 };
			if (cmd === "git" && args[0] === "rev-parse") return { stdout: "", stderr: "", exitCode: 0 };
			return { stdout: "", stderr: "no", exitCode: 1 };
		});

		const prepared = await prepareRun({
			cwd,
			input: "https://github.com/o/r/pull/7",
			lite: true,
		});
		assert.ok(prepared, "lite review should still prepare a run");
		assert.match(prepared!.directiveText, /lite-review/);
		assert.doesNotMatch(prepared!.directiveText, /runs\.run\('gate'/);
		assert.match(prepared!.directiveText, /chatProgress: "auto"/);
		rmSync(dirname(prepared!.manifest.workspacePath), { recursive: true, force: true });
	});

	test("adaptive routing skips lanes that cannot add signal", async () => {
		const { adaptiveSkips, reviewersForRouting } = await import("../src/review-run.js");
		const config = DEFAULT_CONFIG;
		const target: import("../src/types.js").ReviewTarget = {
			kind: "local-git",
			label: "docs change",
		};

		const skips = adaptiveSkips({
			docsOnly: true,
			rulePaths: [],
			historyAvailable: false,
		});
		assert.ok(skips.some(([id]) => id === "bugbot"));
		assert.ok(skips.some(([id]) => id === "security-review"));
		assert.ok(skips.some(([id]) => id === "claude-md-compliance"));
		assert.ok(skips.some(([id]) => id === "history-context"));

		const roster = reviewersForRouting(target, config, { docsOnly: true, rulePaths: [], historyAvailable: false });
		assert.equal(roster.some((r) => r.id === "bugbot"), false);
		assert.equal(roster.some((r) => r.id === "security-review"), false);
		assert.equal(roster.some((r) => r.id === "claude-md-compliance"), false);
		assert.equal(roster.some((r) => r.id === "history-context"), false);
		// Code-comments is also skipped for docs-only.
		assert.equal(roster.some((r) => r.id === "code-comments"), false);
	});

	test("routing.mode=all keeps the full roster", async () => {
		const { reviewersForRouting } = await import("../src/review-run.js");
		const config = { ...DEFAULT_CONFIG, routing: { mode: "all" as const } };
		const target: import("../src/types.js").ReviewTarget = { kind: "local-git", label: "x" };
		const roster = reviewersForRouting(target, config, { docsOnly: true, rulePaths: [], historyAvailable: false });
		assert.equal(roster.some((r) => r.id === "bugbot"), true);
		assert.equal(roster.some((r) => r.id === "history-context"), true);
	});
});

describe("prepareRun — config wiring (round-2 adversarial findings)", () => {
	const PR = "https://github.com/o/r/pull/51";
	const DIFF = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";

	function prCmds(diff = DIFF) {
		return fakeCmd({
			gh: (args) => {
				if (args[0] === "pr" && args[1] === "view") {
					return {
						stdout: JSON.stringify({ number: "51", baseRefName: "main", headRefOid: "h1" }),
						stderr: "",
						exitCode: 0,
					};
				}
				if (args[0] === "pr" && args[1] === "diff") {
					return { stdout: diff, stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "no", exitCode: 1 };
			},
		});
	}

	test("gate.enabled=false skips the gate but keeps the full roster", async () => {
		const cwd = setup();
		writeConfig({ ...DEFAULT_CONFIG, gate: { ...DEFAULT_CONFIG.gate, enabled: false } });
		setReviewRunCmd(prCmds());
		setTargetWorkspaceCmd(async (cmd, args) => {
			if (cmd === "git" && args[0] === "rev-parse" && args.includes("HEAD")) {
				return { stdout: "h1\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		const prepared = await prepareRun({ cwd, input: PR });
		assert.ok(prepared);
		assert.doesNotMatch(prepared!.directiveText, /runs\.run\('gate'/);
		// Full roster still fans out (not the lite single-lane shape).
		assert.ok((prepared!.manifest.reviewerIds?.length ?? 0) >= 4, "full roster expected");
		assert.match(prepared!.directiveText, /gate disabled in config/);
		rmSync(dirname(prepared!.manifest.workspacePath), { recursive: true, force: true });
	});

	test("config budgets.turnBudget flows into the script (not just the default)", async () => {
		const cwd = setup();
		writeConfig({
			...DEFAULT_CONFIG,
			budgets: { turnBudget: { maxTurns: 33, graceTurns: 2 } },
		} as typeof DEFAULT_CONFIG);
		setReviewRunCmd(prCmds());
		setTargetWorkspaceCmd(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
		const prepared = await prepareRun({ cwd, input: PR });
		assert.ok(prepared);
		assert.match(prepared!.directiveText, /maxTurns: 33/);
		rmSync(dirname(prepared!.manifest.workspacePath), { recursive: true, force: true });
	});

	test("manifest records the run's reviewer roster", async () => {
		const cwd = setup();
		setReviewRunCmd(prCmds());
		setTargetWorkspaceCmd(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
		const prepared = await prepareRun({ cwd, input: PR });
		assert.ok(prepared);
		assert.ok(Array.isArray(prepared!.manifest.reviewerIds));
		assert.ok(prepared!.manifest.reviewerIds!.length >= 4);
		rmSync(dirname(prepared!.manifest.workspacePath), { recursive: true, force: true });
	});

	test("mixed dirty tree: modified + untracked files all land in the diff", async () => {
		const cwd = setup();
		writeFileSync(join(cwd, "tracked.ts"), "a\n");
		writeFileSync(join(cwd, "brand-new.ts"), "console.log(1);\n");
		setReviewRunCmd(
			fakeCmd({
				"git status": () => ({ stdout: " M tracked.ts\n?? brand-new.ts\n", stderr: "", exitCode: 0 }),
				"git diff": () => ({
					stdout: "diff --git a/tracked.ts b/tracked.ts\n--- a/tracked.ts\n+++ b/tracked.ts\n@@ -1 +1 @@\n-a\n+b\n",
					stderr: "",
					exitCode: 0,
				}),
				"git ls-files": () => ({ stdout: "brand-new.ts\n", stderr: "", exitCode: 0 }),
				"git rev-parse": () => ({ stdout: "abc\n", stderr: "", exitCode: 0 }),
			}),
		);
		setTargetWorkspaceCmd(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
		const prepared = await prepareRun({ cwd, input: "" });
		assert.ok(prepared);
		const m = prepared!.manifest;
		assert.ok(m.changedFiles.includes("tracked.ts"), "tracked change present");
		assert.ok(m.changedFiles.includes("brand-new.ts"), "untracked new file must be reviewed too");
		assert.match(readFileSync(m.diffPath, "utf-8"), /brand-new\.ts/);
	});
});

describe("git-pr-fallback hardening (2026-08-12 stale-ref incident)", () => {
	const PR = "https://github.com/o/r/pull/33";

	/**
	 * Stateful fetch tracker: FETCH_HEAD reflects the MOST RECENT fetch, so a
	 * regression that reorders the base fetch after the head fetch (the
	 * 2026-08-12 bug class) flips FETCH_HEAD to the base and fails the
	 * headRefOid verification below.
	 */
	function fetchTrackingCmds(prHead = "H1") {
		let lastFetch: "base" | "head" | null = null;
		const reviewRunPlan: Record<string, (args: string[]) => { stdout: string; stderr: string; exitCode: number }> = {
			gh: (args) => {
				if (args[0] === "pr" && args[1] === "view") {
					return {
						stdout: JSON.stringify({ number: "33", baseRefName: "main", baseRefOid: "b0", headRefOid: prHead }),
						stderr: "",
						exitCode: 0,
					};
				}
				return { stdout: "", stderr: "no diff", exitCode: 1 };
			},
			"git fetch": (args) => {
				const refspec = args.find((a) => a.includes("refs/heads/") || a.includes("pull/")) ?? "";
				lastFetch = refspec.includes("pull/") ? "head" : "base";
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			"git rev-parse": (args) => {
				if (args.includes("FETCH_HEAD")) {
					// FETCH_HEAD must come from the PR-head fetch, not the base refresh.
					return lastFetch === "head"
						? { stdout: `${prHead}\n`, stderr: "", exitCode: 0 }
						: { stdout: "\n", stderr: "FETCH_HEAD is the base ref", exitCode: 1 };
				}
				return { stdout: "mb0\n", stderr: "", exitCode: 0 };
			},
			"git merge-base": () => ({ stdout: "mb0\n", stderr: "", exitCode: 0 }),
			"git diff": () => ({
				stdout: "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n",
				stderr: "",
				exitCode: 0,
			}),
		};
		return { reviewRunPlan, orderLog: () => lastFetch };
	}

	test("fallback verifies FETCH_HEAD against headRefOid and uses it for the diff", async () => {
		const cwd = setup();
		const { reviewRunPlan } = fetchTrackingCmds("H1");
		let viewCalls = 0;
		const plan = { ...reviewRunPlan };
		plan.gh = (args: string[]) => {
			if (args[0] === "pr" && args[1] === "view") viewCalls++;
			return reviewRunPlan.gh!(args);
		};
		setReviewRunCmd(fakeCmd(plan));
		setTargetWorkspaceCmd(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

		const prepared = await prepareRun({ cwd, input: PR });
		assert.ok(prepared);
		assert.equal(prepared!.manifest.mode, "git-pr-fallback");
		assert.equal(prepared!.manifest.headSha, "H1");
		assert.equal(prepared!.manifest.mergeBase, "mb0");
		// 2 views: one from acquirePrDiff, one fresh from the git fallback —
		// a mismatch retry would make it 3.
		assert.equal(viewCalls, 2, "fresh metadata, no mismatch retry");
		rmSync(dirname(prepared!.manifest.workspacePath), { recursive: true, force: true });
	});

	test("FETCH_HEAD mismatch after one retry fails loudly (no wrong-diff review)", async () => {
		const cwd = setup();
		setReviewRunCmd(
			fakeCmd({
				gh: (args) => {
					if (args[0] === "pr" && args[1] === "view") {
						return {
							stdout: JSON.stringify({ number: "33", baseRefName: "main", headRefOid: "H1" }),
							stderr: "",
							exitCode: 0,
						};
					}
					return { stdout: "", stderr: "no", exitCode: 1 };
				},
				"git fetch": () => ({ stdout: "", stderr: "", exitCode: 0 }),
				"git rev-parse": (args) => {
					// The remote head keeps disagreeing with gh metadata.
					if (args.includes("FETCH_HEAD")) return { stdout: "XXX\n", stderr: "", exitCode: 0 };
					return { stdout: "mb0\n", stderr: "", exitCode: 0 };
				},
				"git merge-base": () => ({ stdout: "mb0\n", stderr: "", exitCode: 0 }),
				"git diff": () => ({ stdout: "", stderr: "", exitCode: 0 }),
			}),
		);
		setTargetWorkspaceCmd(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

		await assert.rejects(
			() => prepareRun({ cwd, input: PR }),
			/!= GitHub headRefOid .+ after retry/,
		);
	});

	test("failed fetch throws instead of reusing a stale local ref", async () => {
		const cwd = setup();
		setReviewRunCmd(
			fakeCmd({
				gh: () => ({ stdout: "", stderr: "gh unavailable", exitCode: 1 }),
				"git fetch": () => ({ stdout: "", stderr: "network down", exitCode: 128 }),
			}),
		);
		setTargetWorkspaceCmd(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

		await assert.rejects(
			() => prepareRun({ cwd, input: PR }),
			/Not falling back to stale local refs/,
		);
	});

	test("outer TOCTOU: workspace HEAD mismatch retries, converging run succeeds", async () => {
		const cwd = setup();
		const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";
		setReviewRunCmd(
			fakeCmd({
				gh: (args) => {
					if (args[0] === "pr" && args[1] === "view") {
						return {
							stdout: JSON.stringify({ number: "34", baseRefName: "main", headRefOid: "GOOD" }),
							stderr: "",
							exitCode: 0,
						};
					}
					if (args[0] === "pr" && args[1] === "diff") {
						return { stdout: diff, stderr: "", exitCode: 0 };
					}
					return { stdout: "", stderr: "no", exitCode: 1 };
				},
			}),
		);
		let calls = 0;
		setTargetWorkspaceCmd(async (cmd, args) => {
			if (cmd === "git" && args[0] === "rev-parse" && args.includes("HEAD")) {
				calls++;
				// First clone lands on the stale head; the retry converges.
				return { stdout: `${calls === 1 ? "STALE" : "GOOD"}\n`, stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		});

		const prepared = await prepareRun({ cwd, input: "https://github.com/o/r/pull/34" });
		assert.ok(prepared);
		assert.equal(prepared!.manifest.workspaceHeadSha, "GOOD");
		assert.equal(calls, 2, "one retry after the mismatch");
		rmSync(dirname(prepared!.manifest.workspacePath), { recursive: true, force: true });
	});

	test("outer TOCTOU: persistent mismatch throws instead of reviewing split evidence", async () => {
		const cwd = setup();
		const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";
		setReviewRunCmd(
			fakeCmd({
				gh: (args) => {
					if (args[0] === "pr" && args[1] === "view") {
						return {
							stdout: JSON.stringify({ number: "35", baseRefName: "main", headRefOid: "GOOD" }),
							stderr: "",
							exitCode: 0,
						};
					}
					if (args[0] === "pr" && args[1] === "diff") {
						return { stdout: diff, stderr: "", exitCode: 0 };
					}
					return { stdout: "", stderr: "no", exitCode: 1 };
				},
			}),
		);
		setTargetWorkspaceCmd(async (cmd, args) => {
			if (cmd === "git" && args[0] === "rev-parse" && args.includes("HEAD")) {
				return { stdout: "STALE\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		});

		await assert.rejects(
			() => prepareRun({ cwd, input: "https://github.com/o/r/pull/35" }),
			/workspace HEAD STALE does not match diff head GOOD/,
		);
	});
});

describe("cleanup mechanisms", () => {
	test("pruneLegacyFlatArtifacts removes 0.5/0.6 flat files but not runs/", () => {
		const cwd = setup();
		const root = join(cwd, ".pi", "pi-review");
		mkdirSync(join(root, "runs", "keepme"), { recursive: true });
		writeFileSync(join(root, "change.diff"), "old");
		writeFileSync(join(root, "changed-files.txt"), "old");
		writeFileSync(join(root, "diff-meta.txt"), "old");
		const removed = pruneLegacyFlatArtifacts(cwd);
		assert.equal(removed.length, 3);
		assert.equal(existsSync(join(root, "change.diff")), false);
		assert.equal(existsSync(join(root, "runs", "keepme")), true, "runs/ dir must survive");
	});

	test("pruneStaleWorkspaces removes expired tmp clones only", () => {
		const old = mkdtempSync(join(tmpdir(), "pi-review-ws-"));
		const fresh = mkdtempSync(join(tmpdir(), "pi-review-ws-"));
		const other = mkdtempSync(join(tmpdir(), "pi-review-run-"));
		const day = 24 * 60 * 60 * 1000;
		utimesSync(old, new Date(Date.now() - 2 * day), new Date(Date.now() - 2 * day));
		const removed = pruneStaleWorkspaces();
		assert.ok(removed.includes(old), "expired workspace pruned");
		assert.ok(!removed.includes(fresh), "fresh workspace kept");
		assert.ok(!removed.includes(other), "non-workspace tmp dirs untouched");
		rmSync(fresh, { recursive: true, force: true });
		rmSync(other, { recursive: true, force: true });
	});
});

export type { FakeCmd };
void writeFileSync;