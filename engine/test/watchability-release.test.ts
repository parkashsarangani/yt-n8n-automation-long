import test from "node:test";
import assert from "node:assert/strict";
import { assessWatchability, WATCHABILITY_THRESHOLDS, WATCHABILITY_AVERAGE_THRESHOLD } from "../src/workers/watchability-release.ts";
import {
  watchabilityProfile,
  MATERIAL_WEAKNESS_FLOOR,
  MAX_ATTEMPTS_BEFORE_ACCEPTING,
  COMPACT_WATCHABILITY_THRESHOLDS,
  COMPACT_WATCHABILITY_AVERAGE_THRESHOLD,
} from "../src/watchability-policy.ts";

test("the canonical production watchability floors are exactly the operator-set values", () => {
  // Operator-set 2026-09-08. Changing any of these is a deliberate product
  // decision, not a drive-by edit.
  assert.deepEqual(WATCHABILITY_THRESHOLDS, {
    hook: 0.80,
    first_30_fidelity: 0.80,
    package_fidelity: 0.75,
    suspense: 0.75,
    watchability: 0.75,
    entertainment: 0.70,
    payoff: 0.75,
    youtube_fit: 0.75,
  });
  assert.equal(WATCHABILITY_AVERAGE_THRESHOLD, 0.75);
  assert.equal(MATERIAL_WEAKNESS_FLOOR, 0.50);
  assert.equal(MAX_ATTEMPTS_BEFORE_ACCEPTING, 3);

  // Compact (<=90s) keeps only its two duration-specific relaxations plus a
  // 0.02 aggregate relaxation; every other floor inherits the long-form value.
  assert.equal(COMPACT_WATCHABILITY_THRESHOLDS.first_30_fidelity, 0.70);
  assert.equal(COMPACT_WATCHABILITY_THRESHOLDS.suspense, 0.65);
  assert.equal(COMPACT_WATCHABILITY_AVERAGE_THRESHOLD, 0.73);
  for (const dim of ["hook", "package_fidelity", "watchability", "entertainment", "payoff", "youtube_fit"] as const) {
    assert.equal(COMPACT_WATCHABILITY_THRESHOLDS[dim], WATCHABILITY_THRESHOLDS[dim]);
  }
  assert.ok(COMPACT_WATCHABILITY_AVERAGE_THRESHOLD < WATCHABILITY_AVERAGE_THRESHOLD, "a compact probe is never held to a stricter aggregate than long form");
});

function passingScores() {
  const out: Record<string, number> = {};
  for (const key of Object.keys(WATCHABILITY_THRESHOLDS)) out[key] = 0.9;
  return out;
}

test("high numeric scores cannot override revise, missing verdict or abandonment", () => {
  for (const verdict of ["revise", "abandon", undefined]) {
    const result = assessWatchability({verdict, scores: passingScores()});
    assert.equal(result.passed, false);
    assert.ok(result.average < WATCHABILITY_AVERAGE_THRESHOLD);
    assert.match(result.failures.join(" "), /critic verdict/);
  }
  assert.equal(assessWatchability({verdict:"pass", abandon_recommended:true, scores:passingScores()}).passed, false);
});

test("passes when every growth dimension and the average clear the bar", () => {
  const result = assessWatchability({ verdict: "pass", abandon_recommended: false, abandon_reason: "", scores: passingScores() });
  assert.equal(result.passed, true); assert.equal(result.abandonRecommended, false); assert.deepEqual(result.failures, []);
  assert.ok(result.average >= WATCHABILITY_AVERAGE_THRESHOLD);
  assert.equal(result.average, result.rawAverage);
  assert.equal(result.profile.mode, "long_form");
});

test("compact profile changes only first-30, suspense and aggregate floors", () => {
  const compact = watchabilityProfile(60);
  const long = watchabilityProfile(600);
  assert.equal(compact.mode, "compact");
  assert.equal(compact.thresholds.first_30_fidelity, 0.70);
  assert.equal(compact.thresholds.suspense, 0.65);
  assert.equal(compact.averageThreshold, 0.73);
  assert.equal(long.thresholds.first_30_fidelity, 0.80);
  assert.equal(long.thresholds.suspense, 0.75);
  assert.equal(long.averageThreshold, 0.75);
  for (const dimension of ["hook", "package_fidelity", "watchability", "entertainment", "payoff", "youtube_fit"] as const) {
    assert.equal(compact.thresholds[dimension], long.thresholds[dimension], `${dimension} must not be weakened for a 60s probe`);
  }
});

test("a 60s draft can pass compact semantics while the same scores still fail long-form", () => {
  const scores = passingScores();
  scores["hook"] = 0.84;
  scores["first_30_fidelity"] = 0.72;
  scores["suspense"] = 0.68;
  scores["package_fidelity"] = 0.86;
  scores["watchability"] = 0.80;
  scores["entertainment"] = 0.76;
  scores["payoff"] = 0.80;
  scores["youtube_fit"] = 0.80;
  const compact = assessWatchability({ verdict: "pass", abandon_recommended: false, abandon_reason: "", scores }, 60);
  const long = assessWatchability({ verdict: "pass", abandon_recommended: false, abandon_reason: "", scores }, 600);
  assert.equal(compact.passed, true);
  assert.equal(long.passed, false);
  assert.ok(long.failures.some((f) => f.startsWith("first_30_fidelity=0.72")));
  assert.ok(long.failures.some((f) => f.startsWith("suspense=0.68")));
});

test("report-carried duration keeps unattended best-of-N on the same compact release surface", () => {
  const scores = passingScores();
  scores["hook"] = 0.84;
  scores["first_30_fidelity"] = 0.72;
  scores["suspense"] = 0.68;
  scores["package_fidelity"] = 0.86;
  scores["watchability"] = 0.80;
  scores["entertainment"] = 0.76;
  scores["payoff"] = 0.80;
  scores["youtube_fit"] = 0.80;
  const fromReport = assessWatchability({
    target_duration_sec: 60,
    verdict: "pass",
    abandon_recommended: false,
    abandon_reason: "",
    scores,
  });
  assert.equal(fromReport.profile.mode, "compact");
  assert.equal(fromReport.profile.targetDurationSec, 60);
  assert.equal(fromReport.passed, true);
});

test("legacy reports without duration remain long-form compatible", () => {
  const scores = passingScores();
  scores["first_30_fidelity"] = 0.72;
  scores["suspense"] = 0.68;
  const legacy = assessWatchability({ verdict: "pass", abandon_recommended: false, abandon_reason: "", scores });
  assert.equal(legacy.profile.mode, "long_form");
  assert.equal(legacy.passed, false);
});

test("90-180s smoothly interpolates rather than switching to a second graph/profile", () => {
  const mid = watchabilityProfile(135);
  assert.equal(mid.mode, "transition");
  assert.equal(mid.thresholds.first_30_fidelity, 0.75);
  assert.equal(mid.thresholds.suspense, 0.70);
  assert.equal(mid.averageThreshold, 0.74);
});

test("an execution-level weakness blocks for revision without abandoning the topic", () => {
  const scores = passingScores(); scores["suspense"] = 0.6;
  const result = assessWatchability({ verdict: "revise", abandon_recommended: false, abandon_reason: "", scores });
  assert.equal(result.passed, false); assert.equal(result.abandonRecommended, false);
  assert.ok(result.failures.some((f) => f.startsWith("suspense=0.60")));
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
  assert.ok(rejected.rawAverage > accepted.rawAverage, "fixture must prove the rejected draft has the higher arithmetic mean");
  assert.ok(rejected.average < WATCHABILITY_AVERAGE_THRESHOLD, "selection score for any rejected draft is capped below release");
  assert.ok(accepted.average > rejected.average, "the service must never restore a rejected draft after a later pass");
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
