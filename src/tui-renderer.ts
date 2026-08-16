/**
 * Optional TUI renderer — collapses long review reports into a verdict
 * preview line. Falls back to full markdown when expanded.
 */
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { IssueSeverity, Verdict } from "./types.js";

interface SeverityTotals {
	blocker: number;
	major: number;
	minor: number;
	nit: number;
}

interface ReportHeader {
	verdict: Verdict | "no-gate" | "error" | "partial";
	totals?: SeverityTotals;
}

function extractHeader(markdown: string): ReportHeader {
	const m = markdown.match(/Verdict:\s*([A-Z_]+)\*\*\s*\(([^)]*)\)/);
	if (!m) return { verdict: "comment" };
	const verdict = m[1]?.toLowerCase() as ReportHeader["verdict"];
	const counts = (m[2] ?? "").match(/(\d+)\s*blocker\s*·\s*(\d+)\s*major\s*·\s*(\d+)\s*minor\s*·\s*(\d+)\s*nit/);
	const totals: SeverityTotals | undefined = counts
		? {
				blocker: Number(counts[1] ?? 0),
				major: Number(counts[2] ?? 0),
				minor: Number(counts[3] ?? 0),
				nit: Number(counts[4] ?? 0),
			}
		: undefined;
	return { verdict, totals };
}

export function registerPiReviewRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("pi-review", (message, options, theme) => {
		const contentText = typeof message.content === "string"
			? message.content
			: (() => {
					const parts: string[] = [];
					for (const block of message.content) {
						if (block.type === "text") parts.push(block.text);
					}
					return parts.join("\n");
				})();
		const header = extractHeader(contentText);
		const label = header.verdict.toUpperCase();
		const counts = header.totals
			? ` · ${header.totals.blocker} blocker · ${header.totals.major} major · ${header.totals.minor} minor · ${header.totals.nit} nit`
			: "";
		const previewText = theme.bold(theme.fg("toolTitle", `pi-review · ${label}`)) + counts;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		if (!options.expanded) {
			box.addChild(new Text(previewText, 0, 0));
			return box;
		}
		box.addChild(new Text(previewText, 0, 0));
		box.addChild(new Text(contentText, 0, 0));
		return box;
	});
}