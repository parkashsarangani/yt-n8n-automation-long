import test from "node:test";
import assert from "node:assert/strict";
import {
  assessWatchability,
  WATCHABILITY_AVERAGE_THRESHOLD,
  WATCHABILITY_THRESHOLDS,
} from "../src/workers/watchability-release.ts";

function scoresAt(value = 0.9): Record<string, number> {
  return Object.fromEntries(Object.keys(WATCHABILITY_THRESHOLDS).map((key) => [key, value]));
}

test("failed drafts are ordered by distance from the real release surface, not flattened at 0.789", () => {
  const highMeanButBadPayoff = scoresAt(0.90);
  highMeanButBadPayoff["payoff"] = 0.70; // raw mean stays very high, but misses payoff by 0.05

  const lowerMeanButNearPass = {
    hook: 0.82,
    first_30_fidelity: 0.80,
    package_fidelity: 0.84,
    suspense: 0.75,
    watchability: 0.77, // only 0.01 below its floor
    entertainment: 0.72,
    payoff: 0.75,
    youtube_fit: 0.75,
  };

  const a = assessWatchability({ verdict: "revise", scores: highMeanButBadPayoff });
  const b = assessWatchability({ verdict: "revise", scores: lowerMeanButNearPass });

  assert.equal(a.passed, false);
  assert.equal(b.passed, false);
  assert.ok(a.rawAverage > b.rawAverage, "fixture must reproduce the old arithmetic-mean trap");
  assert.ok(b.releaseDeficit < a.releaseDeficit, "near-pass draft must be objectively closer to the gate");
  assert.ok(b.average > a.average, "best-of-N must now restore the draft closest to passing all constraints");
  assert.ok(a.average < WATCHABILITY_AVERAGE_THRESHOLD && b.average < WATCHABILITY_AVERAGE_THRESHOLD,
    "no failed draft may receive a selection score at or above the release bar");
});

test("a passing draft still outranks every failed draft regardless of raw mean", () => {
  const failed = scoresAt(0.99);
  failed["payoff"] = 0.74;
  const passed = scoresAt(0.85);

  const rejected = assessWatchability({ verdict: "revise", scores: failed });
  const accepted = assessWatchability({ verdict: "pass", scores: passed });

  assert.ok(rejected.rawAverage > accepted.rawAverage);
  assert.ok(rejected.average < WATCHABILITY_AVERAGE_THRESHOLD);
  assert.ok(accepted.average >= WATCHABILITY_AVERAGE_THRESHOLD);
  assert.ok(accepted.average > rejected.average);
});
