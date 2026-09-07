import test from "node:test";
import assert from "node:assert/strict";

import { evaluateVisualSmoke, type VisualSmokeRenderedBeat, type VisualSmokeResolvedBeat } from "../src/visual-smoke.ts";

function rendered(id: string): VisualSmokeRenderedBeat {
  return {
    id,
    qa_available: true,
    semantic_match: 0.95,
    action_match: 0.95,
    visual_interest: 0.90,
    continuity: 0.95,
    generic_filler: false,
    why_failure: false,
    repetitive: false,
    continuity_required: false,
    reason: "good",
  };
}

function motion(id: string, representation: "semantic_graphic" | "kinetic_text", fallback = false): VisualSmokeResolvedBeat {
  return {
    id,
    requested_mode: "motion_graphic",
    resolved_mode: "motion_graphic",
    representation,
    status: "resolved",
    semantic_verified: false,
    candidate_count: 1,
    first_acceptable_candidate_index: 1,
    mode_attempt_count: 1,
    ...(fallback ? { note: "SEMANTIC_FALLBACK: no drawable semantic scene; rendered as kinetic text" } : {}),
  };
}

test("smoke summary reports semantic graphics separately from kinetic-text fallbacks", () => {
  const report = evaluateVisualSmoke(
    [rendered("a"), rendered("b"), rendered("c")],
    [motion("a", "semantic_graphic"), motion("b", "semantic_graphic"), motion("c", "kinetic_text", true)],
    ["motion_graphic"],
  );

  assert.equal(report.summary.semantic_graphic_count, 2);
  assert.equal(report.summary.kinetic_text_count, 1);
  assert.equal(report.summary.semantic_fallback_count, 1);
  assert.equal(report.sourcing_failures.length, 0, "one fallback out of three stays below the excessive-degradation gate");
});

test("smoke fails sourcing when most motion-graphic beats degrade to kinetic text", () => {
  const report = evaluateVisualSmoke(
    [rendered("a"), rendered("b"), rendered("c")],
    [motion("a", "kinetic_text", true), motion("b", "kinetic_text", true), motion("c", "semantic_graphic")],
    ["motion_graphic"],
  );

  assert.equal(report.pass, false);
  assert.match(report.sourcing_failures.join(" "), /2\/3 motion-graphic beat\(s\).*degraded to kinetic text/);
});

test("a resolver beat stopped by the run-level QA latch is technical, not sourcing", () => {
  const unavailable: VisualSmokeResolvedBeat = {
    id: "a",
    requested_mode: "generated_video",
    resolved_mode: null,
    status: "unavailable",
    semantic_verified: false,
    candidate_count: 0,
    mode_attempt_count: 1,
    note: "QA_UNAVAILABLE: a: vision QA is unavailable for this resolver run",
  };

  const report = evaluateVisualSmoke([rendered("a")], [unavailable], []);
  assert.equal(report.pass, false);
  assert.equal(report.summary.unresolved_count, 1);
  assert.equal(report.sourcing_failures.length, 0);
  assert.ok(report.technical_failures.some((failure) => /vision QA route was unreachable/.test(failure)));
});
