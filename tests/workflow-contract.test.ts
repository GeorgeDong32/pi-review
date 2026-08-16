/**
 * Workflow contract tests — pin the generated workflowScript API shape that
 * pi-subagents validates. These tests guard against the real failures
 * observed during PR #18689 (agent-fetch) review and the follow-up P0:
 *
 *  - invalid `chatProgress` enum value (rejected by pi-subagents schema)
 *  - reviewer model inheritance leaked into explicit model overrides
 *  - free-text output treated as a successful reviewer result
 *  - gate consuming Markdown text instead of structured objects
 *  - "exactly one subagent call" + single workflowScript + fresh context +
 *    async:false + inline gate inside the same script
 *  - raw paths leaking into the workflowScript as UNQUOTED JS (SyntaxError:
 *    Invalid regular expression flags) — paths must be JSON.stringify'd
 *    inline so the final script parses as valid JS (see assertScriptParses).
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { buildReviewDirective } from "../src/directive.js";
import { LEAN_BUDGETS, leanAgentName } from "../src/lean-agents.js";
import type { ReviewerSpec, ReviewTarget } from "../src/types.js";

const CWD = "/tmp/pi-review-contract";
const WORKSPACE = "/private/var/folders/ab/pi-review-ws-123/cherry-studio-18689";
const MANIFEST = "/tmp/pi-review-contract/.pi/pi-review/runs/r1/manifest.json";
const DIFF = "/tmp/pi-review-contract/.pi/pi-review/runs/r1/change.diff";

/**
 * Extract the `workflowScript: "..."` JSON string literal from the directive
 * and JSON.parse it back into the plain script body. Much more robust than
 * asserting against the escaped JSON form.
 */
function scriptOf(d: string): string {
	const m = d.match(/workflowScript: ("(?:\\.|[^"\\])*")/);
	assert.ok(m, "expected a workflowScript JSON string literal in the directive");
	return JSON.parse(m[1]!);
}

/**
 * P0 regression (real run failure): the script must **parse as valid JS**.
 * The old buildReviewDirective emitted unquoted paths (`cwd: /var/...`)
 * which the JS engine parsed as a RegExp literal → `SyntaxError: Invalid
 * regular expression flags` at subagent() call time. We assert every cwd / diff
 * / manifest occurrence is a properly JSON-quoted string.
 */
function assertScriptParses(script: string): void {
	// Every path-bearing field must be a quoted string literal.
	for (const field of ["cwd:", "toolBudget:", "turnBudget:", "outputSchema:"]) {
		assert.match(script, new RegExp(`${field} `), `script should contain ${field}`);
	}
	// cwd values must be JSON strings (backtick-adjacent), never bare /path.
	assert.doesNotMatch(script, /cwd: \/[A-Za-z_]/);
	// And the overall script must be parseable JS (async wrapper permits
	// top-level await inside the body). `new Function` only parses — never runs.
	const wrapped = `(async () => {\n${script}\n})`;
	new Function(wrapped); // eslint-disable-line no-new-func -- parse-only check
}

function fakeTarget(overrides: Partial<ReviewTarget> = {}): ReviewTarget {
	return {
		kind: "local-git",
		label: "uncommitted changes",
		hint: "Working tree is dirty.",
		...overrides,
	};
}

function fakeReviewer(id: string, overrides: Partial<ReviewerSpec> = {}): ReviewerSpec {
	return { id, label: id, enabled: true, model: "inherit", ...overrides };
}

function defaultReviewers(): ReviewerSpec[] {
	return [
		fakeReviewer("claude-md-compliance"),
		fakeReviewer("bugbot"),
		fakeReviewer("security-review"),
		fakeReviewer("code-comments"),
		fakeReviewer("history-context"),
	];
}

function baseInput(overrides: Partial<Parameters<typeof buildReviewDirective>[0]> = {}) {
	return {
		target: fakeTarget(),
		reviewers: defaultReviewers(),
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

function runsAllOf(script: string): string {
	return script.slice(script.indexOf("runs.all(["), script.indexOf("gate: await"));
}

function gateBlockOf(script: string): string {
	return script.slice(script.indexOf("gate: await"));
}

describe("buildReviewDirective — pi-subagents API contract", () => {
	test("chatProgress is a value pi-subagents accepts", () => {
		const d = buildReviewDirective(baseInput({ gateThinking: "low" }));
		assert.match(d, /chatProgress: "(auto|off|live-card)"/);
		assert.doesNotMatch(d, /chatProgress: "milestones"/);
		assert.doesNotMatch(d, /chatProgress: "on"/);
		assert.doesNotMatch(d, /chatProgress: "stream"/);
	});

	test("exactly one subagent tool call (no per-reviewer fallback path)", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		assert.match(script, /^return \{/);
		const runsAll = (script.match(/runs\.all\(\[/g) ?? []).length;
		assert.equal(runsAll, 1, "workflowScript must invoke runs.all once");
		const runsRunGate = (script.match(/runs\.run\('gate'/g) ?? []).length;
		assert.equal(runsRunGate, 1, "workflowScript must invoke runs.run('gate') once");
		assert.doesNotMatch(script, /runs\.run\('claude-md-compliance'/);
		assert.doesNotMatch(script, /runs\.run\('bugbot'/);
		assert.doesNotMatch(script, /runs\.run\('security-review'/);
	});

	test("top-level shape matches pi-subagents schema", () => {
		const d = buildReviewDirective(baseInput());
		assert.match(d, /async: false/);
		assert.match(d, /context: "fresh"/);
		assert.match(d, /timeoutMs: \d+/);
		assert.match(d, /workflowScript: "return \\?\{/);
	});

	test("P0: the generated workflowScript parses as valid JS (unquoted-path regression)", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		assertScriptParses(script);
		// cwd values are the actual workspace path, JSON-quoted.
		assert.match(script, new RegExp(`cwd: ${JSON.stringify(WORKSPACE)}`));
	});

	test("P0: paths are inlined via JSON.stringify — no placeholder tokens survive", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		assert.ok(script.includes(WORKSPACE), "workspace path must be inlined");
		assert.ok(script.includes(DIFF), "diff path must be inlined");
		assert.ok(script.includes(MANIFEST), "manifest path must be inlined");
		assert.doesNotMatch(script, /\$\{TARGET_WORKSPACE\}/);
		assert.doesNotMatch(script, /\$\{MANIFEST_PATH\}/);
		assert.doesNotMatch(script, /\$\{DIFF_PATH\}/);
	});

	test("reviewer models use 'inherit' when config says so (no parent model leakage)", () => {
		const inherited: ReviewerSpec[] = [
			fakeReviewer("bugbot", { model: "inherit" }),
			fakeReviewer("history-context", { model: "inherit" }),
		];
		const d = buildReviewDirective(baseInput({ reviewers: inherited }));
		const script = scriptOf(d);
		const block = runsAllOf(script);
		assert.doesNotMatch(block, /model: "(anthropic|google|openai|CPA)\//);
	});

	test("explicit per-reviewer model override flows into the script", () => {
		const reviewersWithModel: ReviewerSpec[] = [
			fakeReviewer("bugbot", { model: "anthropic/claude-opus-4-6" }),
			fakeReviewer("history-context", { model: "inherit" }),
			fakeReviewer("security-review", { model: "google/gemini-2.5-flash" }),
		];
		const d = buildReviewDirective(baseInput({ reviewers: reviewersWithModel }));
		const script = scriptOf(d);
		const block = runsAllOf(script);
		assert.match(block, /model: "anthropic\/claude-opus-4-6"/);
		assert.match(block, /model: "google\/gemini-2\.5-flash"/);
		const historyItem = block.slice(
			block.indexOf('key: "history-context"'),
			block.indexOf('key: "history-context"') + 400,
		);
		assert.doesNotMatch(historyItem, /model:/);
	});

	test("per-child cwd is passed so reviewer can reach target repo", () => {
		// Real failure (PR #18689): reviewers had cwd === plugin repo, so
		// history-context / code-comments saw no relevant files.
		const reviewers = defaultReviewers();
		const d = buildReviewDirective(
			baseInput({
				target: fakeTarget({
					kind: "pr",
					label: "PR 18689 (agent-fetch)",
					prRef: "https://github.com/CherryHQ/cherry-studio/pull/18689",
					hint: "PR belongs to CherryHQ/cherry-studio.",
				}),
			}),
		);
		const script = scriptOf(d);
		const cwdOccurrences = script.split(`cwd: ${JSON.stringify(WORKSPACE)}`).length - 1;
		// One cwd per reviewer + one for the gate child.
		assert.equal(cwdOccurrences, reviewers.length + 1, "every reviewer + gate child must set cwd to the target workspace");
	});

	test("every reviewer and the gate declare an outputSchema", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		const allBlock = runsAllOf(script);
		const gateBlock = gateBlockOf(script);
		assert.match(allBlock, /outputSchema: \{/);
		assert.match(gateBlock, /outputSchema: \{/);
		assert.doesNotMatch(allBlock, /JSON\.parse\(result\.output/);
	});

	test("gate inputs are reviewer structuredOutput objects (not Markdown blocks)", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		const gateBlock = gateBlockOf(script);
		assert.match(gateBlock, /reviewerInputs/);
		assert.match(gateBlock, /structuredOutput/);
		assert.match(gateBlock, /limitations/);
		assert.doesNotMatch(gateBlock, /```json/);
	});

	test("per-reviewer budgets are pinned and inherited", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		const allBlock = runsAllOf(script);
		assert.match(
			allBlock,
			new RegExp(`toolBudget: \\{ soft: ${LEAN_BUDGETS.defaultToolBudget.soft}, hard: ${LEAN_BUDGETS.defaultToolBudget.hard} \\}`),
		);
		assert.match(
			allBlock,
			new RegExp(`toolBudget: \\{ soft: ${LEAN_BUDGETS.historyToolBudget.soft}, hard: ${LEAN_BUDGETS.historyToolBudget.hard} \\}`),
		);
		assert.match(
			allBlock,
			new RegExp(`turnBudget: \\{ maxTurns: ${LEAN_BUDGETS.turnBudget.maxTurns}, graceTurns: ${LEAN_BUDGETS.turnBudget.graceTurns} \\}`),
		);
	});

	test("gate child passes structured-output schema and strict model", () => {
		const d = buildReviewDirective(baseInput({ gateThinking: "low" }));
		const script = scriptOf(d);
		const gateBlock = gateBlockOf(script);
		assert.match(gateBlock, /model: "anthropic\/claude-haiku-4-5:low"/);
		assert.match(
			gateBlock,
			new RegExp(`toolBudget: \\{ soft: ${LEAN_BUDGETS.gateToolBudget.soft}, hard: ${LEAN_BUDGETS.gateToolBudget.hard} \\}`),
		);
		assert.match(
			gateBlock,
			new RegExp(`turnBudget: \\{ maxTurns: ${LEAN_BUDGETS.gateTurnBudget.maxTurns}, graceTurns: ${LEAN_BUDGETS.gateTurnBudget.graceTurns} \\}`),
		);
		assert.match(gateBlock, /dispositions/);
	});

	test("agent names use pi-review.* namespace and never builtin reviewer", () => {
		const d = buildReviewDirective(baseInput());
		const script = scriptOf(d);
		for (const id of defaultReviewers().map((r) => r.id)) {
			assert.match(script, new RegExp(`agent: "${leanAgentName(id)}"`));
			assert.match(script, new RegExp(`key: "${id}"`));
		}
		assert.doesNotMatch(script, /agent: "reviewer"/);
	});
});

describe("buildReviewDirective — directive copy", () => {
	const reviewers: ReviewerSpec[] = [
		fakeReviewer("bugbot"),
		fakeReviewer("history-context"),
	];

	test("hard rules pin single subagent call and forbid re-review", () => {
		const d = buildReviewDirective(baseInput({ reviewers }));
		assert.match(d, /Call `subagent` \*\*exactly one\*\* time/);
		assert.match(d, /Do not retry/);
		assert.match(d, /never one call per reviewer/);
		assert.match(d, /pi_review_report/);
	});

	test("Step 1 points at deterministic manifest, not LLM-obtained diff", () => {
		const d = buildReviewDirective(baseInput({ reviewers }));
		assert.ok(d.includes(MANIFEST));
		assert.ok(d.includes(DIFF));
		assert.ok(d.includes(WORKSPACE));
	});

	test("lite mode keeps the single-wave guarantee", () => {
		const d = buildReviewDirective(
			baseInput({ reviewers: [fakeReviewer("lite-review")], lite: true }),
		);
		const script = scriptOf(d);
		assert.equal((script.match(/runs\.all\(\[/g) ?? []).length, 1);
		assert.doesNotMatch(script, /runs\.run\('gate'\)/);
		assert.match(script, /gate: null/);
	});
});