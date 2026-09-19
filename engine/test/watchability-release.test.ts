import test from "node:test";
import assert from "node:assert/strict";
import { assessWatchability, WATCHABILITY_THRESHOLDS, WATCHABILITY_AVERAGE_THRESHOLD } from "../src/workers/watchability-release.ts";
import {
  watchabilityProfile,
  MATERIAL_WEAKNESS_FLOOR,
  MAX_ATTEMPTS_BEFORE_ACCEPTING,
  COMPACT_WATCHABILITY_THRESHOLDS,
  COMPACT_WATCHABILITY_AVERAGE_THRESHOLD,
  PRE_FREEZE_EDITORIAL_THRESHOLDS,
  PRE_FREEZE_EDITORIAL_AVERAGE_THRESHOLD,
} from "../src/watchability-policy.ts";

test("the release surface is a crash guard, not an editorial bar", () => {
  // Operator decision 2026-09-19: the critic is an unvalidated proxy that may
  // be biased toward tidy prose viewers skip, so it gates only on output that
  // is broken. Changing any of these is a deliberate product decision.
  for (const [dimension, threshold] of Object.entries(WATCHABILITY_THRESHOLDS)) {
    assert.equal(threshold, MATERIAL_WEAKNESS_FLOOR, `${dimension} must sit at the crash-guard floor`);
  }
  assert.equal(WATCHABILITY_AVERAGE_THRESHOLD, MATERIAL_WEAKNESS_FLOOR);
  assert.equal(MATERIAL_WEAKNESS_FLOOR, 0.50);
  assert.equal(MAX_ATTEMPTS_BEFORE_ACCEPTING, 3);

  // Duration-independent: whether output is broken does not depend on length.
  assert.deepEqual(COMPACT_WATCHABILITY_THRESHOLDS, WATCHABILITY_THRESHOLDS);
  assert.equal(COMPACT_WATCHABILITY_AVERAGE_THRESHOLD, WATCHABILITY_AVERAGE_THRESHOLD);
});

test("the pre-freeze editorial surface is preserved for a future validated gate", () => {
  // Kept, not deleted: restoring an editorial bar starts from these values,
  // reweighted by whichever dimensions actually predicted retention.
  assert.deepEqual(PRE_FREEZE_EDITORIAL_THRESHOLDS, {
    hook: 0.80,
    first_30_fidelity: 0.80,
    package_fidelity: 0.75,
    suspense: 0.75,
    watchability: 0.75,
    entertainment: 0.70,
    payoff: 0.75,
    youtube_fit: 0.75,
  });
  assert.equal(PRE_FREEZE_EDITORIAL_AVERAGE_THRESHOLD, 0.75);
  for (const [dimension, editorial] of Object.entries(PRE_FREEZE_EDITORIAL_THRESHOLDS)) {
    assert.ok(
      editorial > WATCHABILITY_THRESHOLDS[dimension as keyof typeof WATCHABILITY_THRESHOLDS],
      `${dimension}: the live gate must be strictly looser than the retired editorial bar`,
    );
  }
});

function passingScores() {
  const out: Record<string, number> = {};
  for (const key of Object.keys(WATCHABILITY_THRESHOLDS)) out[key] = 0.9;
  return out;
}

test("a revise verdict no longer blocks release, but an abandonment still does", () => {
  // The whole point of the crash guard: revise fires on nearly every draft and
  // used to cost two extra paid reasoning calls per episode.
  const revised = assessWatchability({ verdict: "revise", scores: passingScores() });
  assert.equal(revised.passed, true, "a revise verdict with sound numbers must release");
  assert.deepEqual(revised.failures, []);

  for (const abandoning of [
    { verdict: "abandon", scores: passingScores() },
    { verdict: "pass", abandon_recommended: true, scores: passingScores() },
  ]) {
    const result = assessWatchability(abandoning);
    assert.equal(result.passed, false);
    assert.equal(result.abandonRecommended, true);
    assert.ok(result.average < WATCHABILITY_AVERAGE_THRESHOLD);
  }
});

test("a missing verdict is not by itself a release failure", () => {
  const result = assessWatchability({ scores: passingScores() });
  assert.equal(result.passed, true);
});

test("passes when every dimension and the average clear the crash guard", () => {
  const result = assessWatchability({ verdict: "pass", abandon_recommended: false, abandon_reason: "", scores: passingScores() });
  assert.equal(result.passed, true); assert.equal(result.abandonRecommended, false); assert.deepEqual(result.failures, []);
  assert.ok(result.average >= WATCHABILITY_AVERAGE_THRESHOLD);
  assert.equal(result.average, result.rawAverage);
  assert.equal(result.profile.mode, "long_form");
});

test("the duration profile still reports a mode but no longer varies the floors", () => {
  const compact = watchabilityProfile(60);
  const mid = watchabilityProfile(135);
  const long = watchabilityProfile(600);
  assert.equal(compact.mode, "compact");
  assert.equal(mid.mode, "transition");
  assert.equal(long.mode, "long_form");
  for (const profile of [compact, mid, long]) {
    assert.deepEqual(profile.thresholds, { ...WATCHABILITY_THRESHOLDS });
    assert.equal(profile.averageThreshold, WATCHABILITY_AVERAGE_THRESHOLD);
  }
});

test("scores that the editorial bar rejected now release at every duration", () => {
  // Exactly the fixture that used to pass compact and fail long-form.
  const scores = passingScores();
  scores["hook"] = 0.84;
  scores["first_30_fidelity"] = 0.72;
  scores["suspense"] = 0.68;
  scores["package_fidelity"] = 0.86;
  scores["watchability"] = 0.80;
  scores["entertainment"] = 0.76;
  scores["payoff"] = 0.80;
  scores["youtube_fit"] = 0.80;
  const report = { verdict: "pass", abandon_recommended: false, abandon_reason: "", scores };
  assert.equal(assessWatchability(report, 60).passed, true);
  assert.equal(assessWatchability(report, 600).passed, true);
  assert.equal(assessWatchability({ ...report, target_duration_sec: 60 }).profile.mode, "compact");
  assert.equal(assessWatchability(report).passed, true, "a legacy report without duration also releases");
});

test("a broken dimension still blocks for revision without abandoning the topic", () => {
  const scores = passingScores(); scores["suspense"] = 0.4;
  const result = assessWatchability({ verdict: "revise", abandon_recommended: false, abandon_reason: "", scores });
  assert.equal(result.passed, false); assert.equal(result.abandonRecommended, false);
  assert.ok(result.failures.some((f) => f.startsWith("suspense=0.40")));
});

test("a rejected high-average draft can never outrank a genuinely passing draft", () => {
  const rejectedScores = passingScores();
  for (const key of Object.keys(rejectedScores)) rejectedScores[key] = 0.99;
  rejectedScores["payoff"] = 0.44;
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
  assert.ok(assessWatchability({ scores }).failures.some((f) => f === "payoff=missing (requires 0.50)"));
  const malformed = assessWatchability(null);
  assert.equal(malformed.passed, false); assert.equal(malformed.average, 0); assert.equal(malformed.rawAverage, 0); assert.ok(malformed.failures.length > 0);
});

test("growth gate adds first30/package fidelity but does not restore retired explainer dimensions", () => {
  const dims = Object.keys(WATCHABILITY_THRESHOLDS);
  assert.ok(dims.includes("first_30_fidelity")); assert.ok(dims.includes("package_fidelity"));
  for (const forbidden of ["factual_fidelity", "comprehension", "dialogue_naturalness", "character_chemistry"]) assert.ok(!dims.includes(forbidden));
});
