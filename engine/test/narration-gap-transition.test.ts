import test from "node:test";
import assert from "node:assert/strict";

import { alignSceneBeats, type CharacterAlignment } from "../src/audio/beat-alignment.ts";
import type { VisualBeat } from "../src/visual-routing.ts";

function alignmentFor(text: string, timings: Array<[number, number]>): CharacterAlignment {
  return {
    characters: [...text],
    character_start_times_seconds: timings.map(([start]) => start),
    character_end_times_seconds: timings.map(([, end]) => end),
  };
}

function beat(id: string, beatIndex: number, narration: string): VisualBeat {
  return {
    id,
    scene_index: 0,
    beat_index: beatIndex,
    start_sec: 0,
    end_sec: 1,
    narration,
    context: { previous: "", next: "" },
    intent: { purpose: "EXPLAIN", information: narration, emotion: "neutral", importance: 0.5 },
    visual_contract: { required: [narration], forbidden: [], required_action: "", viewer_takeaway: narration },
    routing: { preferred: "motion_graphic", fallback: "generated_image", image_style: "not_applicable" },
    continuity: { group: "", entities: [] },
    retention: {
      novelty_required: false,
      visual_change_strength: 0.5,
      composition: "diagrammatic",
      camera_treatment: "diagram_motion",
      subject_placement: "full_frame",
      explanatory_pattern: "comparison",
    },
    asset_brief: {
      query: "q",
      query_variants: ["a", "b", "c"],
      generation_prompt: "p",
      generation_variants: ["a", "b", "c"],
      generated_video_prompt: "",
      motion_graphic_brief: "brief",
    },
  };
}

function twoBeatAlignment(secondStart: number, firstEnd = 0.4): CharacterAlignment {
  return alignmentFor("ABCD", [
    [0.0, 0.2],
    [0.2, firstEnd],
    [secondStart, secondStart + 0.2],
    [secondStart + 0.2, secondStart + 0.4],
  ]);
}

function alignedBoundary(secondStart: number, firstEnd = 0.4): { firstEnd: number; secondStart: number } {
  const duration = secondStart + 0.6;
  const aligned = alignSceneBeats(
    [beat("beat_001", 0, "AB"), beat("beat_002", 1, "CD")],
    twoBeatAlignment(secondStart, firstEnd),
    duration,
  );
  return { firstEnd: aligned[0]!.end_sec, secondStart: aligned[1]!.start_sec };
}

test("ordinary sub-threshold speech pauses keep the spoken visual boundary", () => {
  const boundary = alignedBoundary(0.64, 0.4); // 240 ms pause, below 250 ms threshold.
  assert.equal(boundary.secondStart, 0.64);
  assert.equal(boundary.firstEnd, 0.64);
});

test("a genuine narration pause establishes the next visual during silence", () => {
  const boundary = alignedBoundary(1.0, 0.4); // 600 ms pause.
  assert.equal(boundary.secondStart, 0.6); // 400 ms early-establish cap.
  assert.ok(boundary.secondStart > 0.4, "the next visual must not swallow preceding speech");
});

test("a long narration pause never gives away more than 400 ms", () => {
  const boundary = alignedBoundary(2.4, 0.4); // 2 second pause.
  assert.equal(boundary.secondStart, 2.0);
  assert.equal(2.4 - boundary.secondStart, 0.4);
});

test("early establishment never moves before the previous spoken character ends", () => {
  // 300 ms pause: nominal 400 ms lead would cross the previous speech end, so
  // max(previousEnd, ...) must clamp the visual boundary at 0.8.
  const boundary = alignedBoundary(1.1, 0.8);
  assert.equal(boundary.secondStart, 0.8);
});

test("the moved boundary is shared by adjacent beats so the timeline stays contiguous", () => {
  const boundary = alignedBoundary(1.0, 0.4);
  assert.equal(boundary.firstEnd, boundary.secondStart);
});

test("beats with no pause preserve the exact spoken boundary", () => {
  const boundary = alignedBoundary(0.4, 0.4);
  assert.equal(boundary.secondStart, 0.4);
  assert.equal(boundary.firstEnd, 0.4);
});
