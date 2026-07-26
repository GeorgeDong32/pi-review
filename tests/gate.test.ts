/**
 * Tests for src/gate.ts: prompt rendering, single-spawn orchestration, and
 * error handling.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { DEFAULT_CONFIG } from "../src/config.js";
import { renderGatePrompt, runGate } from "../src/gate.js";
import { resetSpawnImpl, setSpawnImpl, type SpawnHandle } from "../src/spawn.js";
import type { ReviewerRunResult } from "../src/types.js";

type FakeHandle = SpawnHandle & {
	_fire(event: string, ...args: unknown[]): void;
};

function fakeHandle(): FakeHandle {
	const stdout = new Readable({ read() {} });
	const stderr = new Readable({ read() {} });
	const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
	const handle: FakeHandle = {
		stdout,
		stderr,
		pid: 99,
		on(event: string, cb: (...args: unknown[]) => void): SpawnHandle {
			(handlers[event] ??= []).push(cb as (...args: unknown[]) => void);
			return handle;
		},
		kill(): boolean {
			setImmediate(() => handle._fire("exit", 0, null));
			return true;
		},
		_fire(event: string, ...args: unknown[]): void {
			for (const cb of handlers[event] ?? []) cb(...args);
		},
	} as FakeHandle;
	Object.defineProperty(handle, "on", {
		value: (event: string, cb: (...args: unknown[]) => void): SpawnHandle => {
			(handlers[event] ??= []).push(cb);
			return handle;
		},
	});
	return handle;
}

let scratchDir: string;
afterEach(() => {
	resetSpawnImpl();
	if (scratchDir) {
		rmSync(scratchDir, { recursive: true, force: true });
		scratchDir = "";
	}
});

describe("renderGatePrompt", () => {
	test("does not embed a full diff body", () => {
		const prompt = renderGatePrompt({
			reviewers: [],
			gateContext: "Target: PR 1\nKind: pr",
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 5,
			cwd: "/tmp",
			config: DEFAULT_CONFIG,
		});
		assert.ok(prompt.includes("metadata only"));
		assert.ok(!prompt.includes("<diff>"));
		assert.ok(prompt.includes("Target: PR 1"));
	});

	test("includes threshold line", () => {
		const prompt = renderGatePrompt({
			reviewers: [],
			gateContext: "diff body",
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 5,
			cwd: "/tmp",
			config: DEFAULT_CONFIG,
		});
		assert.ok(prompt.includes("## Threshold: 5"));
	});

	test("includes each successful reviewer as JSON block", () => {
		const reviewers: ReviewerRunResult[] = [
			{
				id: "bug-detector",
				label: "Bug Detector",
				model: "x",
				ok: true,
				output: { issues: [], summary: "all clear" },
				durationMs: 100,
			},
			{
				id: "conventions",
				label: "Conventions",
				model: "x",
				ok: true,
				output: { issues: [{ file: "a.ts", category: "convention", severity: "nit", confidence: 3, evidence: "x" }], summary: "1 nit" },
				durationMs: 200,
			},
		];
		const prompt = renderGatePrompt({
			reviewers,
			gateContext: "diff",
			gateModel: "x",
			threshold: 3,
			cwd: "/tmp",
			config: DEFAULT_CONFIG,
		});
		assert.ok(prompt.includes("### Reviewer: bug-detector"));
		assert.ok(prompt.includes("### Reviewer: conventions"));
		assert.ok(prompt.includes('"all clear"'));
		assert.ok(prompt.includes('"1 nit"'));
	});

	test("marks failed reviewers as such", () => {
		const prompt = renderGatePrompt({
			reviewers: [
				{ id: "bug", label: "Bug", model: "x", ok: false, error: "timeout", durationMs: 1000 },
			],
			gateContext: "diff",
			gateModel: "x",
			threshold: 3,
			cwd: "/tmp",
			config: DEFAULT_CONFIG,
		});
		assert.ok(prompt.includes("### Reviewer: bug"));
		assert.ok(prompt.includes("(failed: timeout)"));
	});
});

describe("runGate", () => {
	test("returns ok=true with verdict on success", async () => {
		scratchDir = mkdtempSync(join(tmpdir(), "pi-review-gate-"));
		setSpawnImpl((_cmd, _args, opts) => {
			const h = fakeHandle();
			const out = opts.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
			if (typeof out === "string") {
				writeFileSync(
					out,
					JSON.stringify({ verdict: "comment", issues: [], reason: "no blockers" }),
					"utf-8",
				);
			}
			setImmediate(() => h._fire("exit", 0, null));
			return h;
		});
		const result = await runGate({
			reviewers: [],
			gateContext: "diff",
			gateModel: "anthropic/claude-haiku-4-5",
			threshold: 3,
			cwd: scratchDir,
			config: DEFAULT_CONFIG,
			scorePerIssue: "off",
		});
		assert.equal(result.ok, true);
		// Empty issues → code-side enforce forces approve (LLM "comment" is overridden).
		assert.equal(result.verdict?.verdict, "approve");
		assert.equal(result.model, "anthropic/claude-haiku-4-5");
	});

	test("enforces request_changes when LLM wrongly approves a high-confidence blocker", async () => {
		scratchDir = mkdtempSync(join(tmpdir(), "pi-review-gate-"));
		setSpawnImpl((_cmd, _args, opts) => {
			const h = fakeHandle();
			const out = opts.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
			if (typeof out === "string") {
				writeFileSync(
					out,
					JSON.stringify({
						verdict: "approve",
						issues: [
							{
								file: "a.ts",
								line: 1,
								category: "bug",
								severity: "blocker",
								confidence: 9,
								evidence: "null deref",
							},
						],
						reason: "looks fine",
					}),
					"utf-8",
				);
			}
			setImmediate(() => h._fire("exit", 0, null));
			return h;
		});
		const result = await runGate({
			reviewers: [],
			gateContext: "diff",
			gateModel: "haiku",
			threshold: 8,
			cwd: scratchDir,
			config: DEFAULT_CONFIG,
			scorePerIssue: "off",
		});
		assert.equal(result.ok, true);
		assert.equal(result.verdict?.verdict, "request_changes");
		assert.equal(result.verdict?.issues.length, 1);
	});

	test("returns ok=false when output is missing", async () => {
		scratchDir = mkdtempSync(join(tmpdir(), "pi-review-gate-"));
		setSpawnImpl(() => {
			const h = fakeHandle();
			setImmediate(() => h._fire("exit", 0, null));
			return h;
		});
		const result = await runGate({
			reviewers: [],
			gateContext: "diff",
			gateModel: "x",
			threshold: 3,
			cwd: scratchDir,
			config: DEFAULT_CONFIG,
		});
		assert.equal(result.ok, false);
		assert.ok((result.error ?? "").includes("missing output"));
	});

	test("returns ok=false when spawn errors", async () => {
		scratchDir = mkdtempSync(join(tmpdir(), "pi-review-gate-"));
		setSpawnImpl(() => {
			const h = fakeHandle();
			setImmediate(() => h._fire("error", new Error("spawn failed")));
			return h;
		});
		const result = await runGate({
			reviewers: [],
			gateContext: "diff",
			gateModel: "x",
			threshold: 3,
			cwd: scratchDir,
			config: DEFAULT_CONFIG,
		});
		assert.equal(result.ok, false);
		assert.ok((result.error ?? "").includes("spawn error"));
	});

	test("returns ok=false when gate verdict schema rejects output", async () => {
		scratchDir = mkdtempSync(join(tmpdir(), "pi-review-gate-"));
		setSpawnImpl((_cmd, _args, opts) => {
			const h = fakeHandle();
			const out = opts.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
			if (typeof out === "string") {
				writeFileSync(out, JSON.stringify({ verdict: "rejected" }), "utf-8");
			}
			setImmediate(() => h._fire("exit", 0, null));
			return h;
		});
		const result = await runGate({
			reviewers: [],
			gateContext: "diff",
			gateModel: "x",
			threshold: 3,
			cwd: scratchDir,
			config: DEFAULT_CONFIG,
		});
		assert.equal(result.ok, false);
		assert.ok((result.error ?? "").includes("validation failed"));
	});
});
