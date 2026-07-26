/**
 * @georgedong32/pi-review — fan-out code review for Pi.
 *
 * Pipeline: eligibility → prep → parallel reviewers → gate → report.
 * See reference/pi-review-roadmap.md and reference/v0.2-plan.md.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";

import { parseReviewArgs } from "./src/cli-args.js";
import {
	configPath,
	DEFAULT_CONFIG,
	loadConfig,
	mergeWithDefaults,
	resolveModel,
	validateConfig,
	writeConfig,
} from "./src/config.js";
import { runReviewPipeline } from "./src/run.js";

function parentModelId(ctx: ExtensionCommandContext): string | undefined {
	const m = ctx.model;
	if (!m) return undefined;
	return `${m.provider}/${m.id}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("review", {
		description: "Fan-out code review: parallel reviewers + confidence gate",
		handler: async (args, ctx) => {
			const setStatus = (text: string | undefined) => {
				if (ctx.hasUI) ctx.ui.setStatus("pi-review", text);
			};
			const notify = (msg: string, level: "info" | "warning" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
				else console.log(`pi-review: ${msg}`);
			};

			try {
				const parsed = parseReviewArgs(args);
				setStatus("resolving target…");
				notify(
					parsed.input
						? `pi-review starting: ${parsed.input.slice(0, 80)}${parsed.input.length > 80 ? "…" : ""}`
						: "pi-review starting (local git)…",
					"info",
				);

				const result = await runReviewPipeline({
					args: parsed,
					ctx,
					onStatus: setStatus,
				});

				setStatus(undefined);

				if (result.kind === "skipped") {
					notify(result.reason, "info");
					return;
				}

				if (result.kind === "dry-run") {
					pi.sendMessage({
						customType: "pi-review",
						content: result.plan,
						display: true,
					});
					return;
				}

				pi.sendMessage({
					customType: "pi-review",
					content: result.markdown,
					display: true,
					details: result.report,
				});
				pi.appendEntry("pi-review", result.report);
			} catch (err) {
				setStatus(undefined);
				const message = err instanceof Error ? err.message : String(err);
				notify(`pi-review failed: ${message}`, "error");
				pi.sendMessage({
					customType: "pi-review",
					content: `## pi-review failed\n\n${message}`,
					display: true,
				});
			}
		},
	});

	pi.registerCommand("review-config", {
		description: "Edit pi-review config (~/.pi/agent/extensions/pi-review/config.json)",
		handler: async (_args, ctx) => {
			const path = configPath();
			if (!existsSync(path)) {
				writeConfig(DEFAULT_CONFIG);
			}

			let raw: string;
			if (ctx.hasUI) {
				const current = readFileSync(path, "utf-8");
				const edited = await ctx.ui.editor("Edit pi-review config (JSON)", current);
				if (edited === undefined) {
					ctx.ui.notify("Config edit cancelled.", "info");
					return;
				}
				raw = edited;
			} else {
				const editor = process.env.VISUAL ?? process.env.EDITOR;
				if (!editor) {
					ctx.ui.notify(`Set $EDITOR or use TUI. Config path: ${path}`, "warning");
					return;
				}
				await pi.exec(editor, [path], { cwd: ctx.cwd });
				raw = readFileSync(path, "utf-8");
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				ctx.ui.notify("Invalid JSON — config not saved.", "error");
				return;
			}

			const merged = mergeWithDefaults(parsed);
			const validation = validateConfig(merged);
			if (!validation.ok) {
				ctx.ui.notify(`Config errors: ${validation.errors.join("; ")}`, "error");
				return;
			}
			writeConfig(merged);
			ctx.ui.notify("pi-review config saved.", "info");
		},
	});

	pi.registerCommand("review-agents", {
		description: "List bundled reviewers and resolved models",
		handler: async (_args, ctx) => {
			const { config } = loadConfig();
			const parent = parentModelId(ctx);
			const lines: string[] = ["## pi-review agents", ""];
			for (const r of Object.values(config.reviewers)) {
				const model = resolveModel(r.model, parent);
				const tools = (r.tools ?? config.inheritance.toolsDefault).join(", ");
				const status = r.enabled ? "enabled" : "disabled";
				lines.push(`- **${r.id}** (${r.label}) — ${status}`);
				lines.push(`  - model: ${model}`);
				lines.push(`  - thinking: ${r.thinking ?? "default"}`);
				lines.push(`  - tools: ${tools}`);
			}
			lines.push("");
			lines.push(`Gate: ${resolveModel(config.gate.model, parent)} · threshold ${config.gate.threshold}`);
			const body = lines.join("\n");
			pi.sendMessage({ customType: "pi-review-agents", content: body, display: true });
		},
	});
}
