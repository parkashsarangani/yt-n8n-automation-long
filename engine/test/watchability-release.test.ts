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
});

test("an execution-level weakness blocks for revision without abandoning the topic", () => {
  const scores = passingScores(); scores["suspense"] = 0.6;
  const result = assessWatchability({ verdict: "revise", abandon_recommended: false, abandon_reason: "", scores });
  assert.equal(result.passed, false); assert.equal(result.abandonRecommended, false);
  assert.ok(result.failures.some((f) => f.startsWith("suspense=0.60")));
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
  assert.equal(malformed.passed, false); assert.equal(malformed.average, 0); assert.ok(malformed.failures.length > 0);
});

test("growth gate adds first30/package fidelity but does not restore retired explainer dimensions", () => {
  const dims = Object.keys(WATCHABILITY_THRESHOLDS);
  assert.ok(dims.includes("first_30_fidelity")); assert.ok(dims.includes("package_fidelity"));
  for (const forbidden of ["factual_fidelity", "comprehension", "dialogue_naturalness", "character_chemistry"]) assert.ok(!dims.includes(forbidden));
});
