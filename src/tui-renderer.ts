/**
 * TUI renderer for `pi-review` custom messages. v0.8.3 (user decision):
 * the FULL report is always rendered — no collapsed/expanded split (the
 * host's global expansion toggle made the card look like it "didn't show
 * the report"). A `pi-review result:` summary line sits at the TOP of the
 * card; the report body follows verbatim.
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
	const m = markdown.match(/Verdict:\s*([A-Za-z_]+)\s*(?:（[^)]*）)?\s*\*{0,2}\s*\(([^)]*)\)/);
	if (!m) return { verdict: "comment" };
	const raw = m[1]?.toLowerCase() as ReportHeader["verdict"];
	const verdict = raw === "approve" || raw === "request_changes" || raw === "comment"
		? raw
		: raw === "no-gate" || raw === "error" || raw === "partial"
			? raw
			: "comment";
	const counts = (m[2] ?? "").match(/(\d+)\s*blocker\s*[·•]\s*(\d+)\s*major\s*[·•]\s*(\d+)\s*minor\s*[·•]\s*(\d+)\s*nit/);
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

/** Title-case display form: approve -> Approve, request_changes -> Request changes. */
function displayVerdict(v: ReportHeader["verdict"]): string {
	switch (v) {
		case "approve":
			return "Approve";
		case "request_changes":
			return "Request changes";
		case "comment":
			return "Comment";
		case "no-gate":
			return "No gate";
		case "error":
			return "Error";
		case "partial":
			return "Partial";
	}
}

/** `pi-review result: Approve · 0 blocker · 0 major · 0 minor · 0 nit` */
export function summaryLine(header: ReportHeader): string {
	const t = header.totals;
	const counts = t
		? ` · ${t.blocker} blocker · ${t.major} major · ${t.minor} minor · ${t.nit} nit`
		: "";
	return `pi-review result: ${displayVerdict(header.verdict)}${counts}`;
}

export function registerPiReviewRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("pi-review", (message, _options, theme) => {
		const contentText = typeof message.content === "string"
			? message.content
			: (() => {
					const parts: string[] = [];
					for (const block of message.content) {
						if (block.type === "text") parts.push(block.text);
					}
					return parts.join("\n");
				})();
		// The `/review` command echo shares this customType with reports.
		// Echoes render verbatim with their own prefix.
		if (contentText.startsWith("/review")) {
			const echo = theme.fg("toolTitle", "[pi-review] ") + contentText;
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(echo, 0, 0));
			return box;
		}
		const header = extractHeader(contentText);
		const summary = theme.bold(theme.fg("toolTitle", summaryLine(header)));
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(summary, 0, 0));
		box.addChild(new Text("", 0, 0));
		// Full report body, always rendered (v0.8.3).
		box.addChild(new Text(contentText, 0, 0));
		return box;
	});
}
