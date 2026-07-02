/**
 * Tests for src/parallel.ts: mapConcurrent concurrency cap, order preservation,
 * and error propagation.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MAX_PARALLEL_CONCURRENCY, mapConcurrent } from "../src/parallel.js";

describe("mapConcurrent", () => {
	test("returns empty array for empty input", async () => {
		const out = await mapConcurrent([], 4, async () => 1);
		assert.deepEqual(out, []);
	});

	test("preserves result order regardless of completion order", async () => {
		const items = [3, 1, 4, 1, 5, 9, 2, 6];
		const out = await mapConcurrent(items, 4, async (n) => {
			// Reverse ordering: bigger n sleeps longer.
			await new Promise((r) => setTimeout(r, 10 - Math.min(n, 9)));
			return n * 2;
		});
		assert.deepEqual(out, items.map((n) => n * 2));
	});

	test("caps concurrency at MAX_PARALLEL_CONCURRENCY (4)", async () => {
		let inFlight = 0;
		let observedMax = 0;
		const items = Array.from({ length: 12 }, (_, i) => i);
		await mapConcurrent(items, 99, async (i) => {
			inFlight++;
			observedMax = Math.max(observedMax, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return i;
		});
		assert.equal(observedMax, MAX_PARALLEL_CONCURRENCY);
	});

	test("honors smaller limit", async () => {
		let inFlight = 0;
		let observedMax = 0;
		const items = Array.from({ length: 8 }, (_, i) => i);
		await mapConcurrent(items, 2, async (i) => {
			inFlight++;
			observedMax = Math.max(observedMax, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return i;
		});
		assert.equal(observedMax, 2);
	});

	test("propagates errors from fn", async () => {
		await assert.rejects(
			mapConcurrent([1, 2, 3], 2, async (n) => {
				if (n === 2) throw new Error("boom");
				return n;
			}),
			/boom/,
		);
	});

	test("treats limit <= 0 as 1", async () => {
		let inFlight = 0;
		let observedMax = 0;
		const items = [1, 2, 3];
		await mapConcurrent(items, 0, async (n) => {
			inFlight++;
			observedMax = Math.max(observedMax, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return n;
		});
		assert.equal(observedMax, 1);
	});

	test("passes index to fn", async () => {
		const seen: number[] = [];
		await mapConcurrent(["a", "b", "c"], 2, async (_v, i) => {
			seen.push(i);
			return i;
		});
		assert.deepEqual(seen, [0, 1, 2]);
	});
});
