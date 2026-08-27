/**
 * Prose / directive-copy tests for src/directive.ts.
 *
 * The JSON-stringified workflowScript body assertions live in
 * tests/workflow-contract.test.ts (which parses the script back and asserts
 * against plain text). This file only asserts the human-facing directive
 * copy that is NOT embedded in the JSON string.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, test } from "node:test";

import { buildReviewDirective } from "../src/directive.js";
import {
	LEAN_BUDGETS,
	LEAN_GATE_AGENT,
	leanAgentName,
	resolveLeanBudgets,
	withThinkingSuffix,
} from "../src/lean-agents.js";
import type { ReviewerSpec, ReviewTarget } from "../src/types.js";

const CWD = "/tmp/pi-review-test-cwd";
const WORKSPACE = "/tmp/pi-review-tgt-ws";
const MANIFEST = "/tmp/pi-review-test-cwd/.pi/pi-review/runs/r1/manifest.json";
const DIFF = "/tmp/pi-review-test-cwd/.pi/pi-review/runs/r1/change.diff";
const DIMENSIONS = [
	"bugbot",
	"security-review",
	"claude-md-compliance",
	"code-comments",
	"history-context",
];

function fakeTarget(overrides: Partial<ReviewTarget> = {}): ReviewTarget {
	return {
		kind: "local-git",
		label: "uncommitted changes",
		hint: "Working tree is dirty. Use git status then git diff HEAD.",
		...overrides,
	};
}

function fakeReviewer(id: string): ReviewerSpec {
	return { id, label: id, enabled: true, model: "inherit" };
}

function baseInput(overrides: Partial<Parameters<typeof buildReviewDirective>[0]> = {}) {
	return {
		target: fakeTarget(),
		reviewers: DIMENSIONS.map(fakeReviewer),
		gateModel: "anthropic/claude-haiku-4-5",
		threshold: 8,
		lite: false,
		cwd: CWD,
		workspacePath: WORKSPACE,
		manifestPath: MANIFEST,
		diffPath: DIFF,
		...overrides,
	};
}

describe("buildReviewDirective — user-facing copy", () => {
	const reviewers = DIMENSIONS.map(fakeReviewer);

	test("emits exactly one subagent call reference in the steps section", () => {
		const d = buildReviewDirective(baseInput());
		assert.match(d, /Call `subagent` \*\*exactly one\*\* time/);
		assert.match(d, /Step 2 must be a \*\*single\*\* `subagent\(/);
		assert.match(d, /never one call per reviewer/);
		assert.match(d, /pi_review_report/);
		const step2 = d.slice(d.indexOf("## Step 2"));
		const calls = step2.match(/^subagent\(\{$/gm) ?? [];
		assert.equal(calls.length, 1, "Step 2 must contain exactly one subagent({ }) call");
	});

	test("uses a chatProgress value accepted by pi-subagents", () => {
		const d = buildReviewDirective(baseInput());
		const m = d.match(/chatProgress: "(auto|off|live-card)"/);
		assert.ok(m, "must emit a valid chatProgress enum value");
	});

	test("chatProgress enum is not 'milestones' (PR #18689 regression)", () => {
		const d = buildReviewDirective(baseInput());
		assert.doesNotMatch(d, /chatProgress: "milestones"/);
	});

	test("top-level shape stays compatible with the workflowScript API", () => {
		const d = buildReviewDirective(baseInput());
		assert.match(d, /async: false/);
		assert.match(d, /context: "fresh"/);
		assert.match(d, /timeoutMs: \d+/);
	});

	test("Step 1 confirms plugin-prepared manifest + target workspace with real inline paths", () => {
		const d = buildReviewDirective(
			baseInput({
				target: fakeTarget({ kind: "pr", label: "PR 99", prRef: "https://github.com/o/r/pull/99", hint: "" }),
			}),
		);
		assert.match(d, /has \*\*already\*\* cloned\/checked out the target repo/);
		assert.ok(d.includes(MANIFEST));
		assert.ok(d.includes(DIFF));
		assert.ok(d.includes(WORKSPACE));
		// No template placeholders survive.
		assert.doesNotMatch(d, /\$\{TARGET_WORKSPACE\}/);
		assert.doesNotMatch(d, /\$\{MANIFEST_PATH\}/);
	});

	test("Step 3 names the pi_review_report tool with runId + workflowReturn", () => {
		const d = buildReviewDirective(baseInput());
		assert.match(d, /pi_review_report/);
		assert.match(d, /runId, workflowReturn/);
		assert.match(d, /exactly once/);
	});

	test("budget override flows into turnBudget line", () => {
		const d = buildReviewDirective(
			baseInput({ budgets: resolveLeanBudgets({ turnBudget: { maxTurns: 24, graceTurns: 2 } }) }),
		);
		assert.match(d, /turnBudget: \{ maxTurns: 24, graceTurns: 2 \}/);
	});

	test("hard rules preserve single-wave and no-retry guidance", () => {
		const d = buildReviewDirective(baseInput());
		assert.match(d, /Do not retry/);
		assert.match(d, /Do not re-write or summarize findings in chat/);
		assert.match(d, new RegExp(leanAgentName("bugbot")));
	});

	test("PR target copies PR ref into the directive", () => {
		const d = buildReviewDirective(
			baseInput({
				target: fakeTarget({ kind: "pr", label: "PR 99", prRef: "https://github.com/o/r/pull/99" }),
			}),
		);
		assert.match(d, /PR 99/);
	});
});

describe("lean helpers", () => {
	test("leanAgentName namespaces under pi-review", () => {
		assert.equal(leanAgentName("bugbot"), "pi-review.bugbot");
		assert.equal(LEAN_GATE_AGENT, "pi-review.gate");
	});

	test("default turnBudget is 26 (raised from 20 — field runs wrapped partial)", () => {
		assert.equal(LEAN_BUDGETS.turnBudget.maxTurns, 26);
		// The gate must be able to actually verify high-severity candidates
		// (user-tuned 2026-08-25: 12 → 16 turns, 10 → 14 soft tools).
		assert.ok(LEAN_BUDGETS.gateTurnBudget.maxTurns >= 16, "gate turns >= 16");
		assert.ok(LEAN_BUDGETS.gateToolBudget.soft >= 14, "gate tool budget soft >= 14");
	});

	test("withThinkingSuffix", () => {
		assert.equal(withThinkingSuffix("anthropic/claude-haiku-4-5", "low"), "anthropic/claude-haiku-4-5:low");
		assert.equal(withThinkingSuffix("anthropic/claude-haiku-4-5:medium", "low"), "anthropic/claude-haiku-4-5:low");
		assert.equal(withThinkingSuffix("anthropic/claude-haiku-4-5", undefined), "anthropic/claude-haiku-4-5");
	});
});

describe("bundled agent prompts — pi-subagents ≥0.5 acceptance contract", () => {
	/**
	 * pi-subagents appends an Acceptance Contract to every child run and
	 * expects a closing ```acceptance-report fence. Agents whose prompts end
	 * with only "return JSON and stop" got meta acceptance: rejected on every
	 * run (observed in the field). Each bundled agent must tell the model to
	 * comply.
	 */
	const agentsDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "agents");
	for (const name of [
		"gate",
		"lite-review",
		"bugbot",
		"security-review",
		"conventions",
		"code-comments",
		"claude-md-compliance",
		"history-context",
	]) {
		test(`${name}.md ends with acceptance-report compliance`, () => {
			const body = readFileSync(join(agentsDir, `${name}.md`), "utf-8");
			assert.match(body, /acceptance-report/, `${name}.md must mention acceptance-report`);
		});
	}

	test("gate.md declares read-only role and verification duty", () => {
		const body = readFileSync(join(agentsDir, "gate.md"), "utf-8");
		assert.match(body, /^acceptanceRole: read-only$/m);
		assert.match(body, /Verification duty/);
		assert.match(body, /never score a finding above 8 without your own verification evidence/i);
		assert.match(body, /unverified:/);
		assert.doesNotMatch(body, /You do \*\*not\*\* have the full diff/);
	});

	test("v0.8: reviewers use Markdown output; gate/lite end with a fenced JSON block", () => {
		// User decision (2026-08-27): drop the structured-output tool contract
		// entirely — reviewers write Markdown reports, and only the gate /
		// lite-reviewer finish with a fenced ```json block that the report
		// tool machine-reads.
		for (const name of [
			"bugbot",
			"security-review",
			"conventions",
			"code-comments",
			"claude-md-compliance",
			"history-context",
		]) {
			const body = readFileSync(join(agentsDir, `${name}.md`), "utf-8");
			assert.match(body, /## Output format \(Markdown report\)/, `${name}.md must define the Markdown output format`);
			assert.doesNotMatch(body, /structured_output tool/, `${name}.md must not reference the structured_output tool`);
		}
		for (const name of ["gate", "lite-review"]) {
			const body = readFileSync(join(agentsDir, `${name}.md`), "utf-8");
			assert.match(body, /```json/, `${name}.md must show the fenced JSON block template`);
			assert.match(body, /fenced.*json block|EXACTLY one fenced JSON block/i, `${name}.md must instruct the fenced block`);
		}
	});
});