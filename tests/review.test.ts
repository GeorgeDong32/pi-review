/**
 * Tests for src/review.ts: fan-out, partial failure, schema validation surfacing.
 *
 * Uses setSpawnImpl from src/spawn.ts to inject a fake spawn that writes a
 * controlled output file and exits 0. We do NOT spawn real `pi` processes.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { DEFAULT_CONFIG } from "../src/config.js";
import { resetSpawnImpl, setSpawnImpl, type SpawnHandle } from "../src/spawn.js";
import { runReviewers } from "../src/review.js";
import type { ReviewerSpec } from "../src/types.js";

type FakeHandle = SpawnHandle & {
	_fire(event: string, ...args: unknown[]): void;
};

/**
 * Build a fake SpawnHandle whose `on` records listeners and `_fire`
 * synchronously invokes them. Tests control exit/error timing.
 */
function fakeHandle(): FakeHandle {
	const stdout = new Readable({ read() {} });
	const stderr = new Readable({ read() {} });
	const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
	const handle: FakeHandle = {
		stdout,
		stderr,
		pid: 12345,
		// Cast through any: the SpawnHandle type has overloaded on() signatures
		// mirroring ChildProcess, which is too strict for our test fake.
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
	// Restore the on() method with a permissive signature that satisfies
	// SpawnHandle's overloaded form. Use defineProperty to avoid the structural
	// mismatch the compiler flags.
	Object.defineProperty(handle, "on", {
		value: (event: string, cb: (...args: unknown[]) => void): SpawnHandle => {
			(handlers[event] ??= []).push(cb);
			return handle;
		},
	});
	return handle;
}

const REVIEWER_OK: ReviewerSpec = {
	id: "bugbot",
	label: "Bugbot",
	enabled: true,
	model: "anthropic/claude-sonnet-4-6",
	thinking: "medium",
	tools: ["read", "grep", "find"],
};

let scratchDir: string;
afterEach(() => {
	resetSpawnImpl();
	if (scratchDir) {
		rmSync(scratchDir, { recursive: true, force: true });
		scratchDir = "";
	}
});

/** Convenience: spawn impl that writes a known output then exits 0. */
function implThatWrites(value: unknown): () => SpawnHandle {
	return () => {
		const h = fakeHandle();
		setImmediate(() => {
			h._fire("exit", 0, null);
		});
		void value; // unused — caller writes file themselves before exiting
		return h;
	};
}

function getCapturePath(env: NodeJS.ProcessEnv): string | undefined {
	const out = env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
	return typeof out === "string" ? out : undefined;
}

describe("runReviewers", () => {
	test("returns one result per reviewer, in input order", async () => {
		scratchDir = mkdtempSync(join(tmpdir(), "pi-review-"));
		setSpawnImpl((_cmd, _args, opts) => {
			const h = fakeHandle();
			const out = getCapturePath(opts.env);
			if (out) writeFileSync(out, JSON.stringify({ issues: [], summary: "ok" }), "utf-8");
			setImmediate(() => h._fire("exit", 0, null));
			return h;
		});
		const results = await runReviewers({
			reviewers: [REVIEWER_OK, REVIEWER_OK],
			promptBody: "diff",
			cwd: scratchDir,
			config: { ...DEFAULT_CONFIG, concurrency: 2 },
		});
		assert.equal(results.length, 2);
		assert.equal(results[0].ok, true);
		assert.equal(results[1].ok, true);
	});

	test("records ok=false when spawn errors", async () => {
		scratchDir = mkdtempSync(join(tmpdir(), "pi-review-"));
		setSpawnImpl(() => {
			const h = fakeHandle();
			setImmediate(() => h._fire("error", new Error("ENOENT: pi not found")));
			return h;
		});
		const results = await runReviewers({
			reviewers: [REVIEWER_OK],
			promptBody: "diff",
			cwd: scratchDir,
			config: { ...DEFAULT_CONFIG, concurrency: 1 },
		});
		assert.equal(results[0].ok, false);
		assert.ok((results[0].error ?? "").includes("spawn error"));
	});

	test("records ok=false when output is missing", async () => {
		scratchDir = mkdtempSync(join(tmpdir(), "pi-review-"));
		setSpawnImpl(() => {
			const h = fakeHandle();
			setImmediate(() => h._fire("exit", 0, null));
			return h;
		});
		const results = await runReviewers({
			reviewers: [REVIEWER_OK],
			promptBody: "diff",
			cwd: scratchDir,
			config: { ...DEFAULT_CONFIG, concurrency: 1 },
		});
		assert.equal(results[0].ok, false);
		assert.ok((results[0].error ?? "").includes("missing output"));
	});

	test("records ok=false when output is invalid JSON", async () => {
		scratchDir = mkdtempSync(join(tmpdir(), "pi-review-"));
		setSpawnImpl((_cmd, _args, opts) => {
			const h = fakeHandle();
			const out = getCapturePath(opts.env);
			if (out) writeFileSync(out, "{not json", "utf-8");
			setImmediate(() => h._fire("exit", 0, null));
			return h;
		});
		const results = await runReviewers({
			reviewers: [REVIEWER_OK],
			promptBody: "diff",
			cwd: scratchDir,
			config: { ...DEFAULT_CONFIG, concurrency: 1 },
		});
		assert.equal(results[0].ok, false);
		assert.ok((results[0].error ?? "").includes("not valid JSON"));
	});

	test("records ok=false when output fails schema validation", async () => {
		scratchDir = mkdtempSync(join(tmpdir(), "pi-review-"));
		setSpawnImpl((_cmd, _args, opts) => {
			const h = fakeHandle();
			const out = getCapturePath(opts.env);
			if (out) writeFileSync(out, JSON.stringify({ issues: "not-an-array", summary: "x" }), "utf-8");
			setImmediate(() => h._fire("exit", 0, null));
			return h;
		});
		const results = await runReviewers({
			reviewers: [REVIEWER_OK],
			promptBody: "diff",
			cwd: scratchDir,
			config: { ...DEFAULT_CONFIG, concurrency: 1 },
		});
		assert.equal(results[0].ok, false);
		assert.ok((results[0].error ?? "").includes("validation failed"));
	});

	test("success path: issues + summary are surfaced", async () => {
		scratchDir = mkdtempSync(join(tmpdir(), "pi-review-"));
		setSpawnImpl((_cmd, _args, opts) => {
			const h = fakeHandle();
			const out = getCapturePath(opts.env);
			if (out) {
				writeFileSync(
					out,
					JSON.stringify({
						issues: [
							{ file: "x.ts", category: "bug", severity: "major", confidence: 8, evidence: "race" },
						],
						summary: "one race",
					}),
					"utf-8",
				);
			}
			setImmediate(() => h._fire("exit", 0, null));
			return h;
		});
		const results = await runReviewers({
			reviewers: [REVIEWER_OK],
			promptBody: "diff",
			cwd: scratchDir,
			config: { ...DEFAULT_CONFIG, concurrency: 1 },
		});
		assert.equal(results[0].ok, true);
		assert.equal(results[0].output?.issues.length, 1);
		assert.equal(results[0].output?.issues[0].file, "x.ts");
		assert.equal(results[0].output?.summary, "one race");
	});

	test("empty reviewer list returns empty results", async () => {
		const results = await runReviewers({
			reviewers: [],
			promptBody: "diff",
			cwd: "/tmp",
			config: DEFAULT_CONFIG,
		});
		assert.deepEqual(results, []);
	});

	test("partial failure: one reviewer ok, one errors, both reported", async () => {
		scratchDir = mkdtempSync(join(tmpdir(), "pi-review-"));
		let callCount = 0;
		setSpawnImpl((_cmd, _args, opts) => {
			const h = fakeHandle();
			callCount++;
			if (callCount === 1) {
				// First call: write valid output.
				const out = getCapturePath(opts.env);
				if (out) writeFileSync(out, JSON.stringify({ issues: [], summary: "ok" }), "utf-8");
				setImmediate(() => h._fire("exit", 0, null));
			} else {
				// Second call: spawn error.
				setImmediate(() => h._fire("error", new Error("boom")));
			}
			return h;
		});
		const results = await runReviewers({
			reviewers: [REVIEWER_OK, REVIEWER_OK],
			promptBody: "diff",
			cwd: scratchDir,
			config: { ...DEFAULT_CONFIG, concurrency: 2 },
		});
		assert.equal(results.length, 2);
		const okCount = results.filter((r) => r.ok).length;
		const failCount = results.filter((r) => !r.ok).length;
		assert.equal(okCount, 1);
		assert.equal(failCount, 1);
	});
});
