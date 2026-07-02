/**
 * Tests for src/args.ts: applyThinkingSuffix, buildReviewerArgs, buildGateArgs.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { applyThinkingSuffix, buildGateArgs, buildReviewerArgs } from "../src/args.js";

describe("applyThinkingSuffix", () => {
	test("returns model unchanged when thinking is undefined", () => {
		assert.equal(applyThinkingSuffix("anthropic/claude-sonnet-4-6", undefined), "anthropic/claude-sonnet-4-6");
	});

	test("returns model unchanged when thinking is 'off'", () => {
		assert.equal(applyThinkingSuffix("anthropic/claude-sonnet-4-6", "off"), "anthropic/claude-sonnet-4-6");
	});

	test("appends thinking suffix when set", () => {
		assert.equal(applyThinkingSuffix("anthropic/claude-sonnet-4-6", "high"), "anthropic/claude-sonnet-4-6:high");
		assert.equal(applyThinkingSuffix("anthropic/claude-haiku-4-5", "minimal"), "anthropic/claude-haiku-4-5:minimal");
	});
});

describe("buildReviewerArgs", () => {
	const base = {
		model: "anthropic/claude-sonnet-4-6",
		thinking: "medium",
		tools: ["read", "grep", "find"],
		promptFile: "/tmp/reviewer-prompt.md",
		schemaPath: "/tmp/schema.json",
		outputPath: "/tmp/output.json",
		reviewerId: "bug-detector",
		taskText: "Review the diff",
	};

	test("emits --no-session/--no-extensions/--no-skills for isolation", () => {
		const { args } = buildReviewerArgs(base);
		assert.ok(args.includes("--no-session"));
		assert.ok(args.includes("--no-extensions"));
		assert.ok(args.includes("--no-skills"));
	});

	test("emits --model with thinking suffix", () => {
		const { args } = buildReviewerArgs(base);
		const i = args.indexOf("--model");
		assert.ok(i >= 0);
		assert.equal(args[i + 1], "anthropic/claude-sonnet-4-6:medium");
	});

	test("emits --tools csv when tools provided", () => {
		const { args } = buildReviewerArgs(base);
		const i = args.indexOf("--tools");
		assert.ok(i >= 0);
		assert.equal(args[i + 1], "read,grep,find");
	});

	test("omits --tools when tools is empty/undefined", () => {
		const { args } = buildReviewerArgs({ ...base, tools: [] });
		assert.equal(args.includes("--tools"), false);
		const { args: args2 } = buildReviewerArgs({ ...base, tools: undefined });
		assert.equal(args2.includes("--tools"), false);
	});

	test("emits --no-project-context when inheritProjectContext is false", () => {
		const { args } = buildReviewerArgs({ ...base, inheritProjectContext: false });
		assert.ok(args.includes("--no-project-context"));
	});

	test("does not emit --no-project-context by default", () => {
		const { args } = buildReviewerArgs(base);
		assert.equal(args.includes("--no-project-context"), false);
	});

	test("emits --system-prompt with prompt file", () => {
		const { args } = buildReviewerArgs(base);
		const i = args.indexOf("--system-prompt");
		assert.ok(i >= 0);
		assert.equal(args[i + 1], "/tmp/reviewer-prompt.md");
	});

	test("task text is the last positional argument", () => {
		const { args } = buildReviewerArgs(base);
		assert.equal(args[args.length - 1], "Review the diff");
	});

	test("env carries schema, output, and reviewer id markers", () => {
		const { env } = buildReviewerArgs(base);
		assert.equal(env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA, "/tmp/schema.json");
		assert.equal(env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE, "/tmp/output.json");
		assert.equal(env.PI_REVIEW_REVIEWER_ID, "bug-detector");
	});
});

describe("buildGateArgs", () => {
	const base = {
		model: "anthropic/claude-haiku-4-5",
		thinking: "low",
		promptFile: "/tmp/gate-prompt.md",
		schemaPath: "/tmp/schema.json",
		outputPath: "/tmp/output.json",
		taskText: "Aggregate reviewer outputs",
	};

	test("omits --tools (gate is pure reasoning)", () => {
		const { args } = buildGateArgs(base);
		assert.equal(args.includes("--tools"), false);
	});

	test("emits --model with thinking suffix", () => {
		const { args } = buildGateArgs(base);
		const i = args.indexOf("--model");
		assert.equal(args[i + 1], "anthropic/claude-haiku-4-5:low");
	});

	test("env carries PI_REVIEW_GATE marker", () => {
		const { env } = buildGateArgs(base);
		assert.equal(env.PI_REVIEW_GATE, "1");
		assert.equal(env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA, "/tmp/schema.json");
	});

	test("task text is the last positional argument", () => {
		const { args } = buildGateArgs(base);
		assert.equal(args[args.length - 1], "Aggregate reviewer outputs");
	});
});
