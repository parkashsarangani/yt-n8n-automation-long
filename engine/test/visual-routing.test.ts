import test from "node:test";
import assert from "node:assert/strict";
import {
  VISUAL_ACCEPTANCE,
  candidateAccepted,
  chooseVisualCandidate,
  noveltyConflict,
  repeatedVisualPatterns,
  selectVisualMode,
  validateVisualBeatPlan,
  type VisualBeat,
  type VisualCapabilities,
  type VisualHistoryEntry,
} from "../src/visual-routing.ts";

function beat(overrides: Partial<VisualBeat> = {}): VisualBeat {
  return {
    id: "beat_001",
    scene_index: 0,
    beat_index: 0,
    start_sec: 0,
    end_sec: 4,
    narration: "A billion seconds is almost thirty-two years.",
    context: { previous: "", next: "That is the scale most people miss." },
    intent: { purpose: "MAKE_SCALE_INTUITIVE", information: "one billion seconds lasts about 31.7 years", emotion: "awe", importance: 0.9 },
    visual_contract: {
      required: ["years visibly accumulating"],
      forbidden: ["generic person looking at a clock"],
      required_action: "calendar years accumulate rapidly",
      viewer_takeaway: "a billion seconds spans decades",
    },
    routing: { preferred: "motion_graphic", fallback: "generated_image", image_style: "not_applicable" },
    continuity: { group: "scale-comparison", entities: ["billion-seconds"] },
    retention: {
      novelty_required: true,
      visual_change_strength: 0.8,
      composition: "timeline",
      camera_treatment: "diagram_motion",
      subject_placement: "full_frame",
      explanatory_pattern: "timeline",
    },
    asset_brief: {
      query: "calendar years passing physical wall calendar",
      query_variants: ["calendar years passing", "decades calendar time lapse", "wall calendar pages years"],
      generation_prompt: "A calendar wall representing decades, no readable typography",
      generation_variants: [
        "Wide physical calendar wall showing decades through visual aging, no text",
        "Close-up calendar pages accelerating through seasons and years, no text",
        "Overhead visual of calendar stacks accumulating into decades, no text",
      ],
      generated_video_prompt: "Calendar pages accelerate as seasons visibly change",
      motion_graphic_brief: "Animate years accumulating while a seconds counter accelerates.",
    },
    ...overrides,
  };
}

const capabilities: VisualCapabilities = { stock_video: true, generated_image: true, motion_graphic: true, generated_video: true };

test("valid visual beat plan passes deterministic validation", () => {
  assert.deepEqual(validateVisualBeatPlan({ beats: [beat()] }), []);
});

test("abstract explanation may not prefer generic stock", () => {
  const base = beat();
  const errors = validateVisualBeatPlan({ beats: [beat({
    routing: { preferred: "stock_video", fallback: "generated_image", image_style: "realistic" },
    asset_brief: { ...base.asset_brief, query: "person checking clock" },
  })] });
  assert.ok(errors.some((error) => error.includes("may not prefer generic stock_video")));
});

test("unsupported preferred mode fails closed to declared fallback", () => {
  const routed = selectVisualMode(
    beat({ routing: { preferred: "stock_video", fallback: "generated_image", image_style: "realistic" } }),
    [],
    { ...capabilities, stock_video: false },
  );
  assert.equal(routed, "generated_image");
});

test("novelty controller evaluates the preceding 20-30 seconds across mode, composition and visual grammar", () => {
  const recent: VisualHistoryEntry[] = Array.from({ length: 5 }, () => ({
    mode: "motion_graphic",
    duration_sec: 5,
    composition: "timeline",
    camera_treatment: "diagram_motion",
    subject_placement: "full_frame",
    explanatory_pattern: "timeline",
  }));
  assert.equal(noveltyConflict(beat(), "motion_graphic", recent), true);
  const routed = selectVisualMode(beat(), recent, capabilities);
  assert.equal(routed, "generated_image");
});

test("candidate gate rejects attractive but semantically weak visual", () => {
  assert.equal(candidateAccepted({ semantic_match: VISUAL_ACCEPTANCE.semantic_match - 0.01, action_match: 1, visual_interest: 1, continuity: 1 }), false);
});

test("candidate ranking considers only candidates above every floor", () => {
  const chosen = chooseVisualCandidate([
    { value: "pretty-but-wrong", scores: { semantic_match: 0.7, action_match: 1, visual_interest: 1, continuity: 1 } },
    { value: "relevant", scores: { semantic_match: 0.95, action_match: 0.85, visual_interest: 0.82, continuity: 0.9 } },
  ]);
  assert.equal(chosen?.value, "relevant");
});

test("repeated pattern detector catches same mode plus composition three times", () => {
  const beats = [0, 1, 2].map((index) => beat({ id: `beat_00${index + 1}`, beat_index: index, start_sec: index * 3, end_sec: index * 3 + 3 }));
  assert.equal(repeatedVisualPatterns(beats), 1);
});
