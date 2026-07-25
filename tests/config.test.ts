/**
 * Tests for src/config.ts: defaults, merge, validation, atomic write.
 *
 * Spawn-related calls are not exercised here — those live in tests/review.test.ts
 * and tests/gate.test.ts.
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
	DEFAULT_CONFIG,
	MAX_PARALLEL_CONCURRENCY,
	clampThreshold,
	configPath,
	loadConfig,
	loadRawConfig,
	mergeWithDefaults,
	resolveModel,
	validateConfig,
	writeConfig,
} from "../src/config.js";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "pi-review-config-"));
	// Point getAgentDir at the sandbox so configPath() resolves inside it.
	process.env.PI_CODING_AGENT_DIR = sandbox;
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("mergeWithDefaults", () => {
	test("returns DEFAULT_CONFIG when raw is empty", () => {
		const merged = mergeWithDefaults({});
		assert.equal(merged.schemaVersion, 1);
		assert.equal(merged.gate.model, "inherit");
		assert.equal(merged.gate.threshold, 8);
		assert.equal(merged.concurrency, 4);
		assert.equal(Object.keys(merged.reviewers).length, 6);
	});

	test("returns DEFAULT_CONFIG when raw is null/non-object", () => {
		assert.deepEqual(mergeWithDefaults(null), DEFAULT_CONFIG);
		assert.deepEqual(mergeWithDefaults(undefined), DEFAULT_CONFIG);
		assert.deepEqual(mergeWithDefaults(42), DEFAULT_CONFIG);
		assert.deepEqual(mergeWithDefaults([1, 2]), DEFAULT_CONFIG);
	});

	test("merges gate overrides on top of defaults", () => {
		const merged = mergeWithDefaults({
			gate: { model: "anthropic/claude-opus-4-6", thinking: "high", enabled: false, threshold: 7 },
		});
		assert.equal(merged.gate.model, "anthropic/claude-opus-4-6");
		assert.equal(merged.gate.thinking, "high");
		assert.equal(merged.gate.enabled, false);
		assert.equal(merged.gate.threshold, 7);
		assert.equal(merged.gate.scorePerIssue, "blocker-major");
	});

	test("merges gate.scorePerIssue", () => {
		const merged = mergeWithDefaults({ gate: { scorePerIssue: "off" } });
		assert.equal(merged.gate.scorePerIssue, "off");
	});

	test("clamps concurrency to [1, MAX_PARALLEL_CONCURRENCY]", () => {
		assert.equal(mergeWithDefaults({ concurrency: 0 }).concurrency, 1);
		assert.equal(mergeWithDefaults({ concurrency: 99 }).concurrency, MAX_PARALLEL_CONCURRENCY);
		assert.equal(mergeWithDefaults({ concurrency: 2.7 }).concurrency, 2);
	});

	test("clamps threshold to [0, 10]", () => {
		assert.equal(mergeWithDefaults({ gate: { threshold: -1 } }).gate.threshold, 0);
		assert.equal(mergeWithDefaults({ gate: { threshold: 11 } }).gate.threshold, 10);
		assert.equal(mergeWithDefaults({ gate: { threshold: 4.9 } }).gate.threshold, 4);
	});

	test("merges per-reviewer overrides", () => {
		const merged = mergeWithDefaults({
			reviewers: {
				bugbot: { model: "anthropic/claude-opus-4-6", thinking: "xhigh", enabled: false },
			},
		});
		const bug = merged.reviewers.bugbot;
		assert.equal(bug.model, "anthropic/claude-opus-4-6");
		assert.equal(bug.thinking, "xhigh");
		assert.equal(bug.enabled, false);
		// Other reviewers untouched.
		assert.equal(merged.reviewers["claude-md-compliance"].model, "inherit");
	});

	test("adds a brand-new reviewer", () => {
		const merged = mergeWithDefaults({
			reviewers: {
				"custom-foo": { label: "Custom Foo", model: "anthropic/claude-haiku-4-5", tools: ["read"] },
			},
		});
		assert.ok(merged.reviewers["custom-foo"]);
		assert.equal(merged.reviewers["custom-foo"].label, "Custom Foo");
		// Built-in reviewers still present.
		assert.equal(Object.keys(merged.reviewers).length, 7);
	});

	test("ignores invalid sub-objects under reviewers", () => {
		const merged = mergeWithDefaults({
			reviewers: { "claude-md-compliance": null, bugbot: "bad" },
		});
		// Built-in values kept when override is bad.
		assert.equal(merged.reviewers["claude-md-compliance"].model, "inherit");
		assert.equal(merged.reviewers.bugbot.model, "inherit");
	});

	test("merges inheritance block", () => {
		const merged = mergeWithDefaults({
			inheritance: { toolsDefault: ["read", "bash"], inheritSkills: true },
		});
		assert.deepEqual(merged.inheritance.toolsDefault, ["read", "bash"]);
		assert.equal(merged.inheritance.inheritSkills, true);
		assert.equal(merged.inheritance.inheritProjectContext, true); // unchanged
	});
});

describe("clampThreshold", () => {
	test("clamps and floors", () => {
		assert.equal(clampThreshold(-5), 0);
		assert.equal(clampThreshold(0), 0);
		assert.equal(clampThreshold(10), 10);
		assert.equal(clampThreshold(11), 10);
		assert.equal(clampThreshold(3.7), 3);
		assert.equal(clampThreshold(NaN), 8);
		assert.equal(clampThreshold(-Infinity), 0);
		assert.equal(clampThreshold(Infinity), 10);
	});
});

describe("validateConfig", () => {
	test("accepts DEFAULT_CONFIG", () => {
		assert.deepEqual(validateConfig(DEFAULT_CONFIG), { ok: true });
	});

	test("rejects wrong schemaVersion", () => {
		const cfg = { ...DEFAULT_CONFIG, schemaVersion: 2 as 1 };
		const v = validateConfig(cfg);
		assert.equal(v.ok, false);
		assert.ok((v as { ok: false; errors: string[] }).errors.some((e) => e.includes("schemaVersion")));
	});

	test("rejects out-of-range threshold", () => {
		const cfg = { ...DEFAULT_CONFIG, gate: { ...DEFAULT_CONFIG.gate, threshold: 11 } };
		const v = validateConfig(cfg);
		assert.equal(v.ok, false);
	});

	test("rejects empty model strings", () => {
		const cfg = {
			...DEFAULT_CONFIG,
			gate: { ...DEFAULT_CONFIG.gate, model: "" },
		};
		const v = validateConfig(cfg);
		assert.equal(v.ok, false);
		assert.ok((v as { ok: false; errors: string[] }).errors.some((e) => e.includes("gate.model")));
	});

	test("rejects concurrency out of bounds", () => {
		const v = validateConfig({ ...DEFAULT_CONFIG, concurrency: 99 });
		assert.equal(v.ok, false);
	});
});

describe("resolveModel", () => {
	test("returns parent model when 'inherit'", () => {
		assert.equal(resolveModel("inherit", "anthropic/claude-sonnet-4-6"), "anthropic/claude-sonnet-4-6");
	});

	test("falls back when inherit and no parent model", () => {
		assert.equal(resolveModel("inherit", undefined), "anthropic/claude-sonnet-4-6");
		assert.equal(resolveModel("inherit", ""), "anthropic/claude-sonnet-4-6");
	});

	test("returns explicit value untouched", () => {
		assert.equal(resolveModel("anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"), "anthropic/claude-haiku-4-5");
	});
});

describe("loadRawConfig / loadConfig / writeConfig", () => {
	test("loadRawConfig returns empty object when file missing", () => {
		assert.deepEqual(loadRawConfig(), {});
	});

	test("loadConfig returns merged defaults when file missing", () => {
		const { config, errors } = loadConfig();
		assert.deepEqual(errors, []);
		assert.equal(config.gate.model, "inherit");
	});

	test("writeConfig round-trips through loadConfig", () => {
		const cfg = mergeWithDefaults({
			gate: { model: "anthropic/claude-haiku-4-5", threshold: 5 },
		});
		writeConfig(cfg);
		// Confirm file lives where we expect.
		assert.ok(configPath().startsWith(sandbox));
		const reloaded = loadConfig();
		assert.equal(reloaded.config.gate.model, "anthropic/claude-haiku-4-5");
		assert.equal(reloaded.config.gate.threshold, 5);
	});

	test("loadConfig recovers from corrupt JSON", () => {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(configPath(), "{not json", "utf-8");
		const { config, errors } = loadConfig();
		assert.deepEqual(errors, []); // corrupt file = treat as empty, no errors
		assert.equal(config.gate.model, "inherit");
	});

	test("loadConfig reports validation errors when override is structurally bad", () => {
		mkdirSync(dirname(configPath()), { recursive: true });
		// Wrong schemaVersion cannot be auto-corrected → validation must catch it.
		writeFileSync(
			configPath(),
			JSON.stringify({ schemaVersion: 99 }),
			"utf-8",
		);
		const { errors } = loadConfig();
		assert.ok(errors.length > 0);
		assert.ok(errors.some((e) => e.includes("schemaVersion")));
	});

	test("loadConfig clamps out-of-range values silently", () => {
		mkdirSync(dirname(configPath()), { recursive: true });
		writeFileSync(
			configPath(),
			JSON.stringify({ gate: { threshold: 99 } }),
			"utf-8",
		);
		const { config, errors } = loadConfig();
		assert.deepEqual(errors, []);
		assert.equal(config.gate.threshold, 10);
	});
});
