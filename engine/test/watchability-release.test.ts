import test from "node:test";
import assert from "node:assert/strict";

import { assessWatchability, WATCHABILITY_THRESHOLDS } from "../src/workers/watchability-release.ts";

function passingScores() {
  const out: Record<string, number> = {};
  for (const key of Object.keys(WATCHABILITY_THRESHOLDS)) out[key] = 0.9;
  return out;
}

test("passes when every dimension clears its threshold and the average clears 0.78", () => {
  const { passed, failures } = assessWatchability({ scores: passingScores() });
  assert.equal(passed, true);
  assert.deepEqual(failures, []);
});

test("fails a single dimension below its own threshold even if the average is fine", () => {
  const scores = passingScores();
  scores["hook"] = 0.5;
  const { passed, failures } = assessWatchability({ scores });
  assert.equal(passed, false);
  assert.ok(failures.some((f) => f.startsWith("hook=0.50")));
});

test("reports a missing dimension distinctly from a low one", () => {
  const scores = passingScores();
  delete (scores as Record<string, unknown>)["payoff"];
  const { failures } = assessWatchability({ scores });
  assert.ok(failures.some((f) => f === "payoff=missing (requires 0.75)"));
});

test("malformed payload fails closed instead of throwing", () => {
  const { passed, average, failures } = assessWatchability(null);
  assert.equal(passed, false);
  assert.equal(average, 0);
  assert.ok(failures.length > 0);
});

test("does not measure factual_fidelity, comprehension, or any dialogue dimension", () => {
  // RFC 0008: this format has no cast and no claim to explain something
  // correctly — those checks belong to script_quality_release, not here.
  const dims = Object.keys(WATCHABILITY_THRESHOLDS);
  for (const forbidden of ["factual_fidelity", "comprehension", "dialogue_naturalness", "character_chemistry"]) {
    assert.ok(!dims.includes(forbidden), `watchability must not score ${forbidden}`);
  }
});
