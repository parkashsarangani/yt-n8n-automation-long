import test from "node:test";
import assert from "node:assert/strict";

import {
  beatRequiresStructuredVisual,
  fallbackContractErrors,
  hasStructuredSemanticScene,
  pacingFailures,
  requiredMinBeats,
  beatDurationStats,
  maxConsecutive,
} from "../src/visual-beat-quality.ts";
import { visualDirectorFallbackErrors } from "../src/agent-validators.ts";
import { assessVisualBeatRelease } from "../src/workers/visual-beat-release.ts";

// A structurally sound explanatory beat: generated_image preferred, a real
// structured motion_graphic alternate.
function goodExplanatoryBeat(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "beat_001",
    intent: { purpose: "SHOW_EFFECT", importance: 0.9 },
    visual_contract: { required_action: "one branch repeats a dose and another patient is missed", required: ["x"] },
    retention: { explanatory_pattern: "cause_effect" },
    routing: { preferred: "generated_image", fallback: "motion_graphic" },
    asset_brief: {
      generation_variants: ["a clear illustrated depiction of the double-dose consequence", "b", "c"],
      motion_graphic_brief: "two branches from one override event",
      semantic_scene: {
        kind: "before_after",
        caption: "override -> record shows unmedicated -> next shift redoses",
        before: { label: "hand override, no record" },
        after: { label: "next shift gives the dose again" },
      },
    },
    ...over,
  };
}

// --- defect 1: identical preferred/fallback + empty briefs --------------------

test("1: identical preferred and fallback is rejected", () => {
  const errors = fallbackContractErrors({
    id: "beat_001",
    routing: { preferred: "generated_image", fallback: "generated_image" },
    asset_brief: { generation_variants: ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"] },
    intent: { purpose: "ESTABLISH" },
  });
  assert.ok(errors.some((e) => /preferred and routing\.fallback are both/.test(e)));
});

test("2: a generated_image -> motion_graphic fallback needs a non-empty motion_graphic_brief", () => {
  const errors = fallbackContractErrors({
    id: "beat_001",
    routing: { preferred: "generated_image", fallback: "motion_graphic" },
    asset_brief: { generation_variants: ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], motion_graphic_brief: "  " },
    intent: { purpose: "ESTABLISH" },
  });
  assert.ok(errors.some((e) => /routing\.fallback is 'motion_graphic' but asset_brief has no usable brief/.test(e)));
});

test("3: the director validator flags a whole plan of duplicate preferred/fallback beats", () => {
  const errors = visualDirectorFallbackErrors({ beats: [
    { id: "beat_001", routing: { preferred: "generated_image", fallback: "generated_image" }, asset_brief: { generation_variants: ["aaaaaaaaaa", "b2", "c3"] }, intent: { purpose: "ESTABLISH" } },
    { id: "beat_002", routing: { preferred: "generated_image", fallback: "generated_image" }, asset_brief: { generation_variants: ["dddddddddd", "e2", "f3"] }, intent: { purpose: "ESTABLISH" } },
  ] });
  assert.equal(errors.filter((e) => /both 'generated_image'/.test(e)).length, 2);
});

// --- defect 3: kinetic text may not satisfy an explanatory beat --------------

test("4: a cause/effect beat cannot resolve to headline-only kinetic text", () => {
  assert.equal(beatRequiresStructuredVisual(goodExplanatoryBeat() as never), true);
  const errors = fallbackContractErrors({
    ...goodExplanatoryBeat(),
    routing: { preferred: "motion_graphic", fallback: "generated_image" },
    asset_brief: {
      generation_variants: ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"],
      motion_graphic_brief: "a branch diagram",
      semantic_scene: { kind: "kinetic_phrase", caption: "SAME BROKEN RECORD" },
    },
  });
  assert.ok(errors.some((e) => /not a structured diagram/.test(e)));
});

test("5: a payoff/low-point beat requires a structured visual", () => {
  assert.equal(beatRequiresStructuredVisual({ id: "b", hero_role: "payoff", intent: { purpose: "TRANSITION" } } as never), true);
  assert.equal(beatRequiresStructuredVisual({ id: "b", hero_role: "low-point", intent: { purpose: "TRANSITION" } } as never), true);
  // a plain hook is fine as a still image
  assert.equal(beatRequiresStructuredVisual({ id: "b", hero_role: "hook", intent: { purpose: "ESTABLISH" }, retention: {} } as never), false);
});

test("6: a purely establishing beat may be a plain image with no structured scene", () => {
  const errors = fallbackContractErrors({
    id: "beat_001",
    intent: { purpose: "ESTABLISH", importance: 0.5 },
    visual_contract: { required_action: "", required: ["x"] },
    retention: { explanatory_pattern: "environment" },
    routing: { preferred: "generated_image", fallback: "stock_video" },
    asset_brief: { generation_variants: ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], query_variants: ["q1", "q2", "q3"] },
  });
  assert.deepEqual(errors, []);
});

test("7: hasStructuredSemanticScene rejects kinetic_phrase / none / absent", () => {
  assert.equal(hasStructuredSemanticScene({ semantic_scene: { kind: "process" } }), true);
  assert.equal(hasStructuredSemanticScene({ semantic_scene: { kind: "kinetic_phrase" } }), false);
  assert.equal(hasStructuredSemanticScene({ semantic_scene: { kind: "none" } }), false);
  assert.equal(hasStructuredSemanticScene({}), false);
});

// --- defect 5: pacing --------------------------------------------------------

test("8: an 18-20s scene needs at least two visual beats", () => {
  assert.equal(requiredMinBeats(18), 2);
  assert.equal(requiredMinBeats(19.7), 2);
  assert.equal(requiredMinBeats(6), 1);
  assert.equal(requiredMinBeats(31), 4);
  const fails = pacingFailures([
    { scene_index: 9, voice_duration_sec: 17.8, aligned_beat_count: 1 },
    { scene_index: 10, voice_duration_sec: 6, aligned_beat_count: 1 },
  ]);
  assert.equal(fails.length, 1);
  assert.match(fails[0]!, /scene 9/);
});

test("9: beat duration stats and consecutive-kinetic run are computed", () => {
  const stats = beatDurationStats([7.6, 12.6, 13.0, 11.1, 7.7, 12.6, 10.4, 9.8, 12.7, 17.8, 19.7, 14.1, 9.4, 17.4]);
  assert.equal(stats.count, 14);
  assert.equal(stats.min_sec, 7.6);
  assert.equal(stats.max_sec, 19.7);
  assert.equal(stats.over_10s, 10);
  assert.equal(stats.over_15s, 3);
  assert.equal(maxConsecutive([false, true, true, true, false, true]), 3);
});

// --- defect 5 + 10: the release gate blocks, it does not warn ---------------

function releaseAssets(beats: Array<Record<string, unknown>>): { beats: never[] } {
  return { beats: beats as never[] };
}

test("10: an 18s single visual beat is a hard release failure", () => {
  const r = assessVisualBeatRelease(
    releaseAssets([{ id: "beat_001", scene_index: 0, status: "resolved", resolved_mode: "generated_image", semantic_verified: true }]),
    { beats: [{ id: "beat_001", scene_index: 0, duration_sec: 18, image_uri: "blob://x" }], total_duration_sec: 18 } as never,
  );
  assert.ok(r.failures.some((f) => /exceeds the .* hard ceiling/.test(f)));
});

test("11: a verification-infrastructure failure blocks the release (not just a warning)", () => {
  const r = assessVisualBeatRelease(
    releaseAssets([{ id: "beat_001", scene_index: 0, status: "resolved", resolved_mode: "generated_image", semantic_verified: false, verification_failed: true }]),
    { beats: [{ id: "beat_001", scene_index: 0, duration_sec: 6, image_uri: "blob://x" }], total_duration_sec: 6 } as never,
  );
  assert.ok(r.failures.some((f) => /verification infrastructure failed/.test(f)));
  assert.equal(r.counters.verification_failed, 1);
});

test("12: a hero/payoff kinetic-text card blocks the release", () => {
  const r = assessVisualBeatRelease(
    releaseAssets([{ id: "beat_001", scene_index: 0, status: "fallback", resolved_mode: "motion_graphic", representation: "kinetic_text", semantic_verified: true, hero_role: "payoff" }]),
    { beats: [{ id: "beat_001", scene_index: 0, duration_sec: 6, template_category: "explanation" }], total_duration_sec: 6 } as never,
  );
  assert.ok(r.failures.some((f) => /hero\/payoff beat is a plain kinetic-text card/.test(f)));
});

test("13: an explanatory beat that degraded to a headline blocks the release", () => {
  const r = assessVisualBeatRelease(
    releaseAssets([{ id: "beat_001", scene_index: 0, status: "fallback", resolved_mode: "motion_graphic", representation: "kinetic_text", semantic_verified: false, structured_visual_missing: true }]),
    { beats: [{ id: "beat_001", scene_index: 0, duration_sec: 6, template_category: "explanation" }], total_duration_sec: 6 } as never,
  );
  assert.ok(r.failures.some((f) => /degraded to a headline/.test(f)));
});

test("14: too many consecutive / too-dense kinetic-text beats block the release", () => {
  const beats = Array.from({ length: 6 }, (_, i) => ({
    id: `beat_00${i + 1}`, scene_index: i, status: "fallback", resolved_mode: "motion_graphic",
    representation: "kinetic_text", semantic_verified: true,
  }));
  const tl = { beats: beats.map((b) => ({ id: b.id, scene_index: b.scene_index, duration_sec: 5, template_category: "explanation" as const })), total_duration_sec: 30 };
  const r = assessVisualBeatRelease(releaseAssets(beats), tl as never);
  assert.ok(r.failures.some((f) => /consecutive kinetic-text/.test(f)));
  assert.ok(r.failures.some((f) => /kinetic-text is .* of beats/.test(f)));
});

test("15: the release gate scene-density check fails a 1-beat 18s scene when voice is supplied", () => {
  const r = assessVisualBeatRelease(
    releaseAssets([{ id: "beat_001", scene_index: 0, status: "resolved", resolved_mode: "generated_image", semantic_verified: true }]),
    { beats: [{ id: "beat_001", scene_index: 0, duration_sec: 9.9, image_uri: "blob://x" }], total_duration_sec: 18 } as never,
    { clips: [{ scene_index: 0, duration_sec: 18 }] },
  );
  assert.ok(r.failures.some((f) => /needs at least 2 visual beat/.test(f)));
});

test("16: the release gate exposes the verified / alternate / unverified counters", () => {
  const r = assessVisualBeatRelease(
    releaseAssets([
      { id: "beat_001", scene_index: 0, status: "resolved", resolved_mode: "generated_image", semantic_verified: true },
      { id: "beat_002", scene_index: 1, status: "fallback", resolved_mode: "generated_image", semantic_verified: true },
      { id: "beat_003", scene_index: 2, status: "resolved", resolved_mode: "generated_image", semantic_verified: false },
    ]),
    { beats: [
      { id: "beat_001", scene_index: 0, duration_sec: 6, image_uri: "blob://a" },
      { id: "beat_002", scene_index: 1, duration_sec: 6, image_uri: "blob://b" },
      { id: "beat_003", scene_index: 2, duration_sec: 6, image_uri: "blob://c" },
    ], total_duration_sec: 18 } as never,
  );
  assert.equal(r.counters.verified, 2);
  assert.equal(r.counters.semantic_alternate, 1);
  assert.equal(r.counters.unverified, 1);
});

test("17: a fully clean run (verified, dense, structured) passes the release gate", () => {
  const beats = [
    { id: "beat_001", scene_index: 0, status: "resolved", resolved_mode: "generated_image", representation: "generated_image", semantic_verified: true },
    { id: "beat_002", scene_index: 0, status: "resolved", resolved_mode: "motion_graphic", representation: "semantic_graphic", semantic_verified: true },
  ];
  const r = assessVisualBeatRelease(
    releaseAssets(beats),
    { beats: [
      { id: "beat_001", scene_index: 0, duration_sec: 7, image_uri: "blob://a" },
      { id: "beat_002", scene_index: 0, duration_sec: 7, template_category: "explanation" as const },
    ], total_duration_sec: 14 } as never,
    { clips: [{ scene_index: 0, duration_sec: 14 }] },
  );
  assert.deepEqual(r.failures, []);
});
