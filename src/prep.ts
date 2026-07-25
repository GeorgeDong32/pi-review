/**
 * Phase 1 — prep context before content reviewers run.
 *
 * Mirrors Claude code-review steps 2–3 (rule file paths + change summary).
 * v0.2 uses synchronous heuristics — no extra LLM spawn.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export interface PrepContext {
	/** Repo-relative or absolute paths to rule files (paths only, like Claude step 2). */
	rulePaths: string[];
	/** Short human summary of the diff. */
	summary: string;
}

const RULE_CANDIDATES = [
	"AGENTS.md",
	"CLAUDE.md",
	"CONVENTIONS.md",
	".pi/conventions.md",
] as const;

/**
 * Discover rule files at repo root and under `.pi/rules/`.
 * Returns paths relative to `cwd` when possible.
 */
export function discoverRulePaths(cwd: string): string[] {
	const found: string[] = [];
	for (const name of RULE_CANDIDATES) {
		const abs = join(cwd, name);
		if (existsSync(abs)) {
			found.push(relative(cwd, abs) || name);
		}
	}
	const rulesDir = join(cwd, ".pi", "rules");
	if (existsSync(rulesDir)) {
		try {
			for (const entry of readdirSync(rulesDir)) {
				if (typeof entry === "string" && entry.endsWith(".md")) {
					found.push(relative(cwd, join(rulesDir, entry)) || join(".pi/rules", entry));
				}
			}
		} catch {
			// ignore unreadable rules dir
		}
	}
	const agentsRules = join(cwd, ".agents", "rules");
	if (existsSync(agentsRules)) {
		try {
			for (const entry of readdirSync(agentsRules)) {
				if (typeof entry === "string" && entry.endsWith(".md")) {
					found.push(relative(cwd, join(agentsRules, entry)) || join(".agents/rules", entry));
				}
			}
		} catch {
			// ignore
		}
	}
	return [...new Set(found)];
}

/** Build a short summary from diff text (files, hunks, line counts). */
export function summarizeDiff(diff: string): string {
	const files = new Set<string>();
	let hunks = 0;
	let additions = 0;
	let deletions = 0;

	for (const line of diff.split("\n")) {
		if (line.startsWith("+++ b/")) {
			files.add(line.slice("+++ b/".length).trim());
		} else if (line.startsWith("@@")) {
			hunks++;
		} else if (line.startsWith("+") && !line.startsWith("+++")) {
			additions++;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			deletions++;
		}
	}

	const fileList = [...files].slice(0, 8);
	const more = files.size > 8 ? ` (+${files.size - 8} more)` : "";
	const filesPart = fileList.length > 0 ? fileList.join(", ") + more : "unknown files";

	return `${files.size} file(s) [${filesPart}]; ${hunks} hunk(s); +${additions}/-${deletions} lines.`;
}

/** Build prep metadata for a cwd + diff. */
export function prepareContext(cwd: string, diff: string): PrepContext {
	return {
		rulePaths: discoverRulePaths(cwd),
		summary: summarizeDiff(diff),
	};
}

/** Format prep block + diff for reviewer/gate task text. */
export function formatReviewTask(prep: PrepContext, diff: string): string {
	const rules =
		prep.rulePaths.length > 0
			? prep.rulePaths.map((p) => `- ${p}`).join("\n")
			: "- (no AGENTS.md / CLAUDE.md / .pi rules found at repo root)";

	return [
		"# Review task",
		"",
		"## Context",
		"",
		"### Rule files (paths only — read as needed)",
		rules,
		"",
		"### Change summary",
		prep.summary,
		"",
		"## Diff",
		"",
		diff,
		"",
		"## Output",
		"",
		"Call the `structured_output` tool exactly once with JSON matching the schema from your instructions. Do not reply in prose.",
	].join("\n");
}
