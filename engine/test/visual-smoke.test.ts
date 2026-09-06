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

const resolved = (id: string, mode: VisualSmokeResolvedBeat["resolved_mode"]): VisualSmokeResolvedBeat => ({
  id,
  resolved_mode: mode,
  status: "resolved",
  semantic_verified: true,
  candidate_count: 3,
});

test("visual smoke passes only with QA, quality, sourcing and route coverage", () => {
  const report = evaluateVisualSmoke(
    [rendered({ id: "beat_001" }), rendered({ id: "beat_002" }), rendered({ id: "beat_003" })],
    [resolved("beat_001", "stock_video"), resolved("beat_002", "generated_image"), resolved("beat_003", "motion_graphic")],
  );
  assert.equal(report.pass, true);
  assert.equal(report.summary.mean_candidate_count, 3);
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
