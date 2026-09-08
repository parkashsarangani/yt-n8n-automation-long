import test from "node:test";
import assert from "node:assert/strict";
import {
  assessWatchability,
  WATCHABILITY_THRESHOLDS,
  WATCHABILITY_AVERAGE_THRESHOLD,
} from "../src/workers/watchability-release.ts";
import {
  COMPACT_WATCHABILITY_AVERAGE_THRESHOLD,
  COMPACT_WATCHABILITY_THRESHOLDS,
  watchabilityPolicyForDuration,
} from "../src/watchability-policy.ts";

function passingScores() {
  const out: Record<string, number> = {};
  for (const key of Object.keys(WATCHABILITY_THRESHOLDS)) out[key] = 0.9;
  return out;
}

test("passes when every growth dimension and the average clear the bar", () => {
  const result = assessWatchability({ verdict: "pass", abandon_recommended: false, abandon_reason: "", scores: passingScores() });
  assert.equal(result.passed, true); assert.equal(result.abandonRecommended, false); assert.deepEqual(result.failures, []);
  assert.ok(result.average >= WATCHABILITY_AVERAGE_THRESHOLD);
  assert.equal(result.average, result.rawAverage);
});

test("an execution-level weakness blocks for revision without abandoning the topic", () => {
  const scores = passingScores(); scores["suspense"] = 0.6;
  const result = assessWatchability({ verdict: "revise", abandon_recommended: false, abandon_reason: "", scores });
  assert.equal(result.passed, false); assert.equal(result.abandonRecommended, false);
  assert.ok(result.failures.some((f) => f.startsWith("suspense=0.60")));
});

test("long-form thresholds stay exactly unchanged when duration is absent or >=180s", () => {
  for (const duration of [undefined, 180, 600]) {
    const policy = watchabilityPolicyForDuration(duration);
    assert.equal(policy.profile, "long_form");
    assert.deepEqual(policy.thresholds, WATCHABILITY_THRESHOLDS);
    assert.equal(policy.averageThreshold, WATCHABILITY_AVERAGE_THRESHOLD);
  }
});

test("60s compact profile only relaxes duration-sensitive first30/suspense/average floors", () => {
  const policy = watchabilityPolicyForDuration(60);
  assert.equal(policy.profile, "compact");
  assert.equal(policy.thresholds.first_30_fidelity, COMPACT_WATCHABILITY_THRESHOLDS.first_30_fidelity);
  assert.equal(policy.thresholds.suspense, COMPACT_WATCHABILITY_THRESHOLDS.suspense);
  assert.equal(policy.averageThreshold, COMPACT_WATCHABILITY_AVERAGE_THRESHOLD);
  for (const dimension of ["hook", "package_fidelity", "watchability", "entertainment", "payoff", "youtube_fit"] as const) {
    assert.equal(policy.thresholds[dimension], WATCHABILITY_THRESHOLDS[dimension], `${dimension} must not become easier for compact probes`);
  }
});

test("90-180s transition interpolates monotonically back to the established long-form contract", () => {
  const compact = watchabilityPolicyForDuration(90);
  const middle = watchabilityPolicyForDuration(135);
  const long = watchabilityPolicyForDuration(180);
  assert.equal(middle.profile, "transition");
  assert.ok(middle.thresholds.first_30_fidelity > compact.thresholds.first_30_fidelity);
  assert.ok(middle.thresholds.first_30_fidelity < long.thresholds.first_30_fidelity);
  assert.ok(middle.thresholds.suspense > compact.thresholds.suspense);
  assert.ok(middle.thresholds.suspense < long.thresholds.suspense);
  assert.ok(middle.averageThreshold > compact.averageThreshold);
  assert.ok(middle.averageThreshold < long.averageThreshold);
});

test("a compact-probe draft can clear proportionate duration floors while the same scores still fail long-form", () => {
  const scores = {
    hook: 0.84,
    first_30_fidelity: 0.72,
    package_fidelity: 0.86,
    suspense: 0.70,
    watchability: 0.82,
    entertainment: 0.78,
    payoff: 0.80,
    youtube_fit: 0.82,
  };
  const compact = assessWatchability({ verdict: "pass", abandon_recommended: false, abandon_reason: "", scores }, 60);
  const long = assessWatchability({ verdict: "pass", abandon_recommended: false, abandon_reason: "", scores }, 600);
  assert.equal(compact.passed, true);
  assert.equal(long.passed, false);
  assert.ok(long.failures.some((f) => f.startsWith("first_30_fidelity=")));
  assert.ok(long.failures.some((f) => f.startsWith("suspense=")));
});

test("a rejected high-average draft can never outrank a genuinely passing draft", () => {
  const rejectedScores = passingScores();
  for (const key of Object.keys(rejectedScores)) rejectedScores[key] = 0.99;
  rejectedScores["payoff"] = 0.74;
  const rejected = assessWatchability({ verdict: "revise", abandon_recommended: false, abandon_reason: "", scores: rejectedScores });

  const passing = passingScores();
  for (const key of Object.keys(passing)) passing[key] = 0.85;
  const accepted = assessWatchability({ verdict: "pass", abandon_recommended: false, abandon_reason: "", scores: passing });

  assert.equal(rejected.passed, false);
  assert.ok(rejected.rawAverage > accepted.rawAverage);
  assert.ok(rejected.average < WATCHABILITY_AVERAGE_THRESHOLD);
  assert.ok(accepted.average > rejected.average);
});

test("material package weakness becomes an abandonment outcome", () => {
  const scores = passingScores(); scores["package_fidelity"] = 0.4;
  const result = assessWatchability({ verdict: "revise", abandon_recommended: false, abandon_reason: "", scores });
  assert.equal(result.passed, false); assert.equal(result.abandonRecommended, true);
  assert.match(result.abandonReason, /package\/first-30\/youtube-fit/);
});

test("critic can explicitly abandon a premise even when numeric scores are not catastrophic", () => {
  const scores = passingScores(); scores["youtube_fit"] = 0.7;
  const result = assessWatchability({ verdict: "abandon", abandon_recommended: true, abandon_reason: "The premise has no sustainable turn after the click promise.", scores });
  assert.equal(result.passed, false); assert.equal(result.abandonRecommended, true);
  assert.match(result.abandonReason, /no sustainable turn/);
});

test("reports a missing dimension distinctly and malformed payload fails closed", () => {
  const scores = passingScores(); delete scores["payoff"];
  assert.ok(assessWatchability({ scores }).failures.some((f) => f === "payoff=missing (requires 0.75)"));
  const malformed = assessWatchability(null);
  assert.equal(malformed.passed, false); assert.equal(malformed.average, 0); assert.equal(malformed.rawAverage, 0); assert.ok(malformed.failures.length > 0);
});

test("growth gate adds first30/package fidelity but does not restore retired explainer dimensions", () => {
  const dims = Object.keys(WATCHABILITY_THRESHOLDS);
  assert.ok(dims.includes("first_30_fidelity")); assert.ok(dims.includes("package_fidelity"));
  for (const forbidden of ["factual_fidelity", "comprehension", "dialogue_naturalness", "character_chemistry"]) assert.ok(!dims.includes(forbidden));
});
