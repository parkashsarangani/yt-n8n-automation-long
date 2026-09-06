import test from "node:test";
import assert from "node:assert/strict";
import { evaluateVisualSmoke, type VisualSmokeRenderedBeat, type VisualSmokeResolvedBeat } from "../src/visual-smoke.ts";

const rendered = (overrides: Partial<VisualSmokeRenderedBeat> = {}): VisualSmokeRenderedBeat => ({
  id: "beat_001",
  qa_available: true,
  semantic_match: 0.95,
  action_match: 0.90,
  visual_interest: 0.85,
  continuity: 0.90,
  generic_filler: false,
  why_failure: false,
  repetitive: false,
  continuity_required: false,
  reason: "good",
  ...overrides,
});

const resolved = (
  id: string,
  mode: VisualSmokeResolvedBeat["resolved_mode"],
  overrides: Partial<VisualSmokeResolvedBeat> = {},
): VisualSmokeResolvedBeat => ({
  id,
  ...(mode ? { requested_mode: mode } : {}),
  resolved_mode: mode,
  status: "resolved",
  semantic_verified: mode !== "motion_graphic",
  candidate_count: mode === "motion_graphic" ? 1 : 3,
  first_acceptable_candidate_index: 1,
  mode_attempt_count: 1,
  ...(mode === "stock_video" ? { search_query_count: 1 } : {}),
  generic_filler: false,
  why_failure: false,
  ...overrides,
});

test("visual smoke passes only with QA, quality, sourcing, efficiency and route coverage", () => {
  const report = evaluateVisualSmoke(
    [rendered({ id: "beat_001" }), rendered({ id: "beat_002" }), rendered({ id: "beat_003" })],
    [resolved("beat_001", "stock_video"), resolved("beat_002", "generated_image"), resolved("beat_003", "motion_graphic")],
  );
  assert.equal(report.pass, true);
  assert.equal(report.summary.operational_budget_failures, 0);
  assert.equal(report.summary.operational_budget_ratio, 1);
  assert.equal(report.summary.first_three_acceptable_ratio, 1);
  assert.equal(report.summary.max_mode_attempt_count, 1);
  assert.equal(report.summary.max_stock_query_count, 1);
  assert.equal(report.resolved_beats.length, 3);
});

test("motion graphics defer semantic verification to rendered-frame QA", () => {
  const report = evaluateVisualSmoke(
    [rendered()],
    [resolved("beat_001", "motion_graphic", { semantic_verified: false })],
    ["motion_graphic"],
  );
  assert.equal(report.pass, true);
  assert.equal(report.sourcing_failures.length, 0);
});

test("visual smoke classifies missing VLM QA as technical rather than visual quality failure", () => {
  const report = evaluateVisualSmoke(
    [rendered({ qa_available: false, semantic_match: 0, visual_interest: 0, reason: "QA unavailable" })],
    [resolved("beat_001", "stock_video")],
    ["stock_video"],
  );
  assert.equal(report.pass, false);
  assert.equal(report.technical_failures.length, 1);
  assert.equal(report.quality_failures.length, 0);
});

test("visual smoke fails when live candidate sourcing cannot resolve a beat", () => {
  const unresolved: VisualSmokeResolvedBeat = {
    id: "beat_001",
    resolved_mode: null,
    status: "unavailable",
    semantic_verified: false,
    candidate_count: 5,
    mode_attempt_count: 2,
  };
  const report = evaluateVisualSmoke([rendered()], [unresolved], []);
  assert.equal(report.pass, false);
  assert.match(report.sourcing_failures.join(" "), /acceptable live visual candidate/);
});

test("visual smoke enforces route-diverse fixture coverage", () => {
  const report = evaluateVisualSmoke(
    [rendered()],
    [resolved("beat_001", "motion_graphic")],
  );
  assert.equal(report.pass, false);
  assert.deepEqual(report.coverage_failures.sort(), [
    "fixture did not exercise resolved mode generated_image",
    "fixture did not exercise resolved mode stock_video",
  ]);
});

test("visual smoke applies the RFC absolute quality floors", () => {
  const report = evaluateVisualSmoke(
    [rendered({ semantic_match: 0.89, visual_interest: 0.79, generic_filler: true, why_failure: true })],
    [resolved("beat_001", "stock_video")],
    ["stock_video"],
  );
  assert.equal(report.pass, false);
  assert.equal(report.technical_failures.length, 0);
  assert.equal(report.quality_failures.length, 4);
});

test("visual smoke fails operationally when stock search exceeds its bounded window budget", () => {
  const report = evaluateVisualSmoke(
    [rendered()],
    [resolved("beat_001", "stock_video", { candidate_count: 76 })],
    ["stock_video"],
  );
  assert.equal(report.pass, false);
  assert.match(report.efficiency_failures.join(" "), /stock_video evaluated 76 candidates\/windows > budget 75/);
});

test("visual smoke fails when stock needs more than three query strategies", () => {
  const report = evaluateVisualSmoke(
    [rendered()],
    [resolved("beat_001", "stock_video", { search_query_count: 4 })],
    ["stock_video"],
  );
  assert.equal(report.pass, false);
  assert.match(report.efficiency_failures.join(" "), /stock search consumed 4 queries > 3/);
});

test("visual smoke requires at least 80 percent of resolved beats to clear within the first three provider candidates", () => {
  const report = evaluateVisualSmoke(
    [
      rendered({ id: "beat_001" }),
      rendered({ id: "beat_002" }),
      rendered({ id: "beat_003" }),
      rendered({ id: "beat_004" }),
      rendered({ id: "beat_005" }),
    ],
    [
      resolved("beat_001", "stock_video", { first_acceptable_candidate_index: 1 }),
      resolved("beat_002", "generated_image", { first_acceptable_candidate_index: 2 }),
      resolved("beat_003", "motion_graphic", { first_acceptable_candidate_index: 1 }),
      resolved("beat_004", "generated_image", { first_acceptable_candidate_index: 4 }),
      resolved("beat_005", "generated_video", { first_acceptable_candidate_index: 4 }),
    ],
    [],
  );
  assert.equal(report.pass, false);
  assert.equal(report.summary.first_three_acceptable_ratio, 0.6);
  assert.match(report.efficiency_failures.join(" "), /first-three acceptable candidate ratio 0\.600 < 0\.80/);
});

test("visual smoke treats excessive fallback dependence as an efficiency failure", () => {
  const report = evaluateVisualSmoke(
    [rendered({ id: "beat_001" }), rendered({ id: "beat_002" }), rendered({ id: "beat_003" })],
    [
      resolved("beat_001", "stock_video", { status: "fallback", requested_mode: "generated_image", mode_attempt_count: 2 }),
      resolved("beat_002", "generated_image"),
      resolved("beat_003", "motion_graphic"),
    ],
  );
  assert.equal(report.pass, false);
  assert.match(report.efficiency_failures.join(" "), /fallback ratio 0\.333 > 0\.25/);
});

test("visual smoke refuses more than preferred plus one alternate mode attempt", () => {
  const report = evaluateVisualSmoke(
    [rendered()],
    [resolved("beat_001", "generated_image", { mode_attempt_count: 3 })],
    ["generated_image"],
  );
  assert.equal(report.pass, false);
  assert.match(report.efficiency_failures.join(" "), /attempted 3 visual modes > 2/);
});

test("visual smoke rejects generic stock even if a resolver regression marks it resolved", () => {
  const report = evaluateVisualSmoke(
    [rendered()],
    [resolved("beat_001", "stock_video", { generic_filler: true })],
    ["stock_video"],
  );
  assert.equal(report.pass, false);
  assert.match(report.sourcing_failures.join(" "), /generic stock beat/);
});
