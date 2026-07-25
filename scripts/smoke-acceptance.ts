/**
 * Manual acceptance smoke for v0.2 G1–G3 (run: bun scripts/smoke-acceptance.ts).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import ext from "../index.ts";
import { loadConfig } from "../src/config.js";
import { runReviewPipeline } from "../src/run.js";

const cwd = process.cwd();
const PARENT_MODEL = { provider: "CPA", id: "CherryCodex/gpt-5.5" };

type Handler = (args: string, ctx: Record<string, unknown>) => Promise<void>;

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		cwd,
		hasUI: true,
		model: PARENT_MODEL,
		ui: {
			notifications: [] as Array<{ msg: string; level: string }>,
			notify(msg: string, level: string) {
				this.notifications.push({ msg, level });
			},
			setStatus: () => {},
			editor: async () => undefined,
		},
		...overrides,
	};
}

async function loadHandlers() {
	const commands: Record<string, { handler: Handler }> = {};
	const messages: unknown[] = [];
	const entries: unknown[] = [];
	const api = {
		registerCommand(name: string, spec: { handler: Handler }) {
			commands[name] = spec;
		},
		sendMessage(m: unknown) {
			messages.push(m);
		},
		appendEntry(_type: string, data: unknown) {
			entries.push(data);
		},
		exec: async () => {},
	};
	ext(api);
	return { commands, messages, entries };
}

function pass(label: string) {
	console.log(`✓ ${label}`);
}

function fail(label: string, err: unknown) {
	console.error(`✗ ${label}`);
	console.error(err);
	process.exitCode = 1;
}

async function main() {
	console.log("=== pi-review v0.2 acceptance smoke ===\n");

	const { commands, messages, entries } = await loadHandlers();
		assert.ok(commands.review, "review command registered");
		assert.ok(commands["review-config"], "review-config registered");
		assert.ok(commands["review-agents"], "review-agents registered");
		pass("extension registers /review, /review-config, /review-agents");

		// G2: --no-spawn
		{
			messages.length = 0;
			await commands.review.handler("--no-spawn", makeCtx());
			const msg = messages[0] as { content?: string };
			assert.match(msg.content ?? "", /pi-review dry run/);
			assert.match(msg.content ?? "", /bugbot/);
			assert.match(msg.content ?? "", /threshold: 8/);
			pass("G2: /review --no-spawn prints resolved plan");
		}

		// G2: --reviewer bugbot --no-spawn
		{
			messages.length = 0;
			await commands.review.handler("--reviewer bugbot --no-spawn", makeCtx());
			const msg = messages[0] as { content?: string };
			assert.match(msg.content ?? "", /reviewers \(1\): bugbot/);
			pass("G2: --reviewer bugbot limits roster");
		}

		// G2: --no-gate (dry via pipeline, single reviewer, no spawn)
		{
			const result = await runReviewPipeline({
				args: {
					path: undefined,
					threshold: undefined,
					reviewers: ["bugbot"],
					noGate: true,
					gateModel: undefined,
					noSpawn: true,
				},
				ctx: makeCtx() as Parameters<typeof runReviewPipeline>[0]["ctx"],
			});
			assert.equal(result.kind, "dry-run");
			const plan = (result as { plan: string }).plan;
			assert.match(plan, /gate: no/);
			pass("G2: --no-gate skips gate in dry-run plan");
		}

		// G3: review-config round-trip (mock editor)
		{
			const { configPath, writeConfig, DEFAULT_CONFIG } = await import("../src/config.js");
			const path = configPath();
			const backup = existsSync(path) ? readFileSync(path, "utf-8") : null;
			try {
				writeConfig(DEFAULT_CONFIG);
				const edited = JSON.stringify(
					{ ...DEFAULT_CONFIG, gate: { ...DEFAULT_CONFIG.gate, threshold: 7 } },
					null,
					2,
				);
				const ctx = makeCtx({
					ui: {
						notifications: [] as Array<{ msg: string; level: string }>,
						notify(msg: string, level: string) {
							this.notifications.push({ msg, level });
						},
						setStatus: () => {},
						editor: async () => edited,
					},
				});
				await commands["review-config"].handler("", ctx);
				const { config } = loadConfig();
				assert.equal(config.gate.threshold, 7);
				pass("G3: /review-config editor save updates threshold");

				messages.length = 0;
				await commands["review-agents"].handler("", makeCtx());
				const agentsMsg = messages[0] as { content?: string };
				assert.match(agentsMsg.content ?? "", /threshold 7/);
				pass("G3: /review-agents reflects config change");

				writeConfig(DEFAULT_CONFIG);
			} finally {
				if (backup !== null) writeFileSync(path, backup, "utf-8");
				else if (existsSync(path)) unlinkSync(path);
			}
		}

		// G1: live spawn with a small explicit diff (single reviewer for speed)
		{
			const diffPath = join(cwd, ".smoke.diff");
			const diff = [
				"diff --git a/src/example.ts b/src/example.ts",
				"--- a/src/example.ts",
				"+++ b/src/example.ts",
				"@@ -1,4 +1,5 @@",
				" export function load(id: string) {",
				"-  return cache.get(id);",
				"+  const item = cache.get(id);",
				"+  return item.value;",
				" }",
				"",
			].join("\n");
			writeFileSync(diffPath, diff, "utf-8");
			console.log("\nG1: live spawn --reviewer bugbot @.smoke.diff (may take 1–3 min)…");
			messages.length = 0;
			entries.length = 0;
			const t0 = Date.now();
			try {
				await commands.review.handler("--reviewer bugbot @.smoke.diff", makeCtx({ hasUI: false }));
			} finally {
				try {
					unlinkSync(diffPath);
				} catch {
					// ignore
				}
			}
			const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
			const msg = messages[0] as { content?: string; details?: unknown };
			if (!msg?.content) {
				fail("G1: no report message", messages);
			} else if (/missing output file|spawn error|No API key/i.test(msg.content)) {
				fail("G1: reviewer spawn failed", msg.content.slice(0, 800));
			} else if (/— failed ·/i.test(msg.content) && !/— ok ·/i.test(msg.content)) {
				fail("G1: reviewer did not return valid structured output", msg.content.slice(0, 800));
			} else {
				assert.match(msg.content, /pi-review|verdict|reviewer/i);
				assert.ok(entries.length > 0, "appendEntry called");
				console.log(`  (${elapsed}s) preview:\n${msg.content.split("\n").slice(0, 12).join("\n")}\n  …`);
				pass(`G1: /review --reviewer bugbot on dirty repo (${elapsed}s)`);
			}
		}

	console.log("\n=== smoke complete ===");
	if (process.exitCode) process.exit(process.exitCode);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
