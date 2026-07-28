/**
 * Mapping from pi-review reviewer ids → pi-subagents runtime agent names,
 * plus default turn/tool budgets for the token-lean directive path.
 *
 * Agents live in `agents/*.md` and are registered via package.json
 * `pi.subagents.agents` so pi-subagents discovers them as package agents
 * (`pi-review.<id>`).
 */

export const LEAN_AGENT_PACKAGE = "pi-review";

/** Runtime agent name for a reviewer id (e.g. bugbot → pi-review.bugbot). */
export function leanAgentName(reviewerId: string): string {
	return `${LEAN_AGENT_PACKAGE}.${reviewerId}`;
}

/** Gate agent runtime name. */
export const LEAN_GATE_AGENT = leanAgentName("gate");

export interface ToolBudgetSpec {
	soft: number;
	hard: number;
}

export interface LeanBudgetSpec {
	/** Top-level turn budget for the parallel fan-out call. */
	turnBudget: { maxTurns: number; graceTurns: number };
	/** Per-task tool budget (overrides by reviewer id when present). */
	defaultToolBudget: ToolBudgetSpec;
	/** Stricter budget for history-context. */
	historyToolBudget: ToolBudgetSpec;
	/** Gate subagent budgets. */
	gateTurnBudget: { maxTurns: number; graceTurns: number };
	gateToolBudget: ToolBudgetSpec;
	/** Wall-clock timeout for the fan-out / gate calls (ms). */
	timeoutMs: number;
}

/** Defaults tuned for read-only review (pi-subagents README guidance). */
export const LEAN_BUDGETS: LeanBudgetSpec = {
	turnBudget: { maxTurns: 12, graceTurns: 2 },
	defaultToolBudget: { soft: 15, hard: 25 },
	historyToolBudget: { soft: 10, hard: 18 },
	gateTurnBudget: { maxTurns: 6, graceTurns: 1 },
	gateToolBudget: { soft: 5, hard: 10 },
	timeoutMs: 600_000,
};

export function toolBudgetForReviewer(id: string): ToolBudgetSpec {
	if (id === "history-context") return LEAN_BUDGETS.historyToolBudget;
	return LEAN_BUDGETS.defaultToolBudget;
}

/** Shared false-positive list (injected once into the directive). */
export const FALSE_POSITIVE_GUIDANCE = [
	"Pre-existing issues on lines the author did not modify",
	"Pedantic nitpicks a senior engineer would not call out",
	"Issues a linter, typechecker, or CI would catch",
	"Generic quality (missing tests/docs) unless a project rule explicitly requires it",
	"Something that looks like a bug but is intentional given the change",
].join("; ");
