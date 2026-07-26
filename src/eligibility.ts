/**
 * Phase 0 — eligibility checks before spawning reviewers.
 *
 * Mirrors Claude code-review step 1 (skip closed/trivial/empty). Local
 * adaptation: empty diff, non-git without explicit path, trivial lockfile-only.
 */
import type { ResolvedInput } from "./types.js";

export interface EligibilityInput {
	resolved: ResolvedInput | null;
	/** User passed `--diff` or an explicit PR ref that resolved to a diff. */
	hasExplicitInput: boolean;
	/** cwd is inside a git repository. */
	isGitRepo: boolean;
}

export type EligibilityResult =
	| { eligible: true }
	| { eligible: false; reason: string };

const LOCKFILE_ONLY = /^(?:.*\/)?(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock(?:\.bun)?|Cargo\.lock|Gemfile\.lock|poetry\.lock)(?:\n|$)/;

/** Run eligibility checks. Returns `{ eligible: false, reason }` to skip review. */
export function checkEligibility(input: EligibilityInput): EligibilityResult {
	if (!input.resolved || input.resolved.content.trim().length === 0) {
		if (!input.isGitRepo && !input.hasExplicitInput) {
			return {
				eligible: false,
				reason: "Not a git repository. Pass a PR URL/number, use --diff @file.diff, or run inside a git repo.",
			};
		}
		return {
			eligible: false,
			reason: "No changes to review (empty diff).",
		};
	}

	if (isTrivialDiff(input.resolved.content)) {
		return {
			eligible: false,
			reason: "Diff is trivial (lockfile-only or fewer than 3 changed lines).",
		};
	}

	return { eligible: true };
}

/** Re-check before render (Claude phase 6 lite). */
export function recheckBeforeOutput(resolved: ResolvedInput | null): EligibilityResult {
	if (!resolved || resolved.content.trim().length === 0) {
		return { eligible: false, reason: "Diff became empty before output." };
	}
	return { eligible: true };
}

/**
 * Heuristic trivial diff detection (v0.2).
 * - Fewer than 3 non-header diff lines
 * - Only lockfile paths in diff headers
 */
export function isTrivialDiff(content: string): boolean {
	const trimmed = content.trim();
	if (trimmed.length === 0) return true;

	const lines = trimmed.split("\n");
	const bodyLines = lines.filter(
		(l) => l.startsWith("+") || l.startsWith("-"),
	).filter((l) => !l.startsWith("+++") && !l.startsWith("---"));
	if (bodyLines.length < 3) return true;

	const fileHeaders = lines.filter((l) => l.startsWith("diff --git ") || l.startsWith("+++ b/"));
	if (fileHeaders.length > 0) {
		const onlyLockfiles = fileHeaders.every((h) => {
			const m = h.match(/(?:^diff --git a\/(.+?) b\/|^\+{3} b\/)(.+)$/);
			const file = m?.[1] ?? m?.[2] ?? "";
			return LOCKFILE_ONLY.test(file);
		});
		if (onlyLockfiles && bodyLines.length < 20) return true;
	}

	return false;
}
