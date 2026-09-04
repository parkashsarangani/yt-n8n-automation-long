import test from "node:test";
import assert from "node:assert/strict";
import { assessWatchability, WATCHABILITY_THRESHOLDS, WATCHABILITY_AVERAGE_THRESHOLD } from "../src/workers/watchability-release.ts";

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

test("a rejected high-average draft can never outrank a genuinely passing draft", () => {
  const rejectedScores = passingScores();
  for (const key of Object.keys(rejectedScores)) rejectedScores[key] = 0.99;
  rejectedScores["payoff"] = 0.74; // fails its 0.75 dimension despite a huge raw mean
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
