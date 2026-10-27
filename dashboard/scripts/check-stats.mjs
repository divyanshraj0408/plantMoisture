// Run: node scripts/check-stats.mjs
import assert from "node:assert/strict";
import { parseLine, mean, median, stdDev, linearRegression, movingAverage, minutesUntil } from "../src/lib/stats.ts";

assert.deepEqual(parseLine("812,0,30,Watering...", 5), { t: 5, raw: 812, pct: 0, start: 30, status: "Watering..." });
assert.equal(parseLine("alive ms=12", 0), null);

assert.equal(mean([2, 4, 6]), 4);
assert.equal(median([5, 1, 3]), 3);
assert.equal(median([4, 1, 3, 2]), 2.5);
assert.equal(stdDev([2, 4, 4, 4, 5, 5, 7, 9]), 2);

const fit = linearRegression([0, 1, 2, 3], [50, 48, 46, 44]);
assert.equal(fit.slope, -2);
assert.equal(fit.intercept, 50);
assert.equal(fit.r2, 1);

assert.deepEqual(movingAverage([1, 2, 3, 4], 2), [1, 1.5, 2.5, 3.5]);

assert.equal(minutesUntil(30, -2, 50, 3), 7); // hits 30 at x=10
assert.equal(minutesUntil(30, 1, 50, 3), null);

console.log("stats ok");
