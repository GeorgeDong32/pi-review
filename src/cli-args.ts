/**
 * Parse `/review` command arguments (flags + freeform user input).
 *
 * CC alignment: text after flags is **user context** for the review (PR URL,
 * PR number, natural language) — not a filesystem path. Use `--diff` for an
 * explicit diff file.
 */

import { clampThreshold, parseScorePerIssueMode } from "./config.js";
import type { ScorePerIssueMode } from "./types.js";

export interface ParsedReviewArgs {
	/** Freeform user context (CC-style), e.g. PR URL or instructions. */
	input?: string;
	/** Explicit diff file via `--diff path` or `--diff @file`. */
	diffPath?: string;
	threshold?: number;
	reviewers: string[];
	noGate: boolean;
	gateModel?: string;
	noSpawn: boolean;
	scorePerIssue?: ScorePerIssueMode;
}

export function parseReviewArgs(raw: string): ParsedReviewArgs {
	const tokens = tokenize(raw);
	const result: ParsedReviewArgs = {
		reviewers: [],
		noGate: false,
		noSpawn: false,
	};
	const inputParts: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--threshold") {
			const n = Number(tokens[++i]);
			if (Number.isFinite(n)) result.threshold = clampThreshold(n);
			continue;
		}
		if (t === "--reviewer") {
			const id = tokens[++i];
			if (id) result.reviewers.push(id);
			continue;
		}
		if (t === "--no-gate") {
			result.noGate = true;
			continue;
		}
		if (t === "--gate-model") {
			result.gateModel = tokens[++i];
			continue;
		}
		if (t === "--score-per-issue") {
			const mode = parseScorePerIssueMode(tokens[++i] ?? "");
			if (mode) result.scorePerIssue = mode;
			continue;
		}
		if (t === "--no-spawn") {
			result.noSpawn = true;
			continue;
		}
		if (t === "--diff") {
			const path = tokens[++i];
			if (path) result.diffPath = path;
			continue;
		}
		if (t.startsWith("-")) {
			continue;
		}
		inputParts.push(t);
	}

	const input = inputParts.join(" ").trim();
	if (input.length > 0) {
		result.input = input;
	}

	return result;
}

/** Split on whitespace preserving quoted segments. */
function tokenize(raw: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (quote) {
			if (c === quote) {
				quote = null;
			} else {
				cur += c;
			}
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			continue;
		}
		if (/\s/.test(c)) {
			if (cur.length > 0) {
				out.push(cur);
				cur = "";
			}
			continue;
		}
		cur += c;
	}
	if (cur.length > 0) out.push(cur);
	return out;
}
