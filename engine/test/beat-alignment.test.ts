import test from "node:test";
import assert from "node:assert/strict";
import { alignSceneBeats, type CharacterAlignment } from "../src/audio/beat-alignment.ts";
import type { VisualBeat } from "../src/visual-routing.ts";

function alignment(text: string): CharacterAlignment {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => i * 0.1),
    character_end_times_seconds: characters.map((_, i) => (i + 1) * 0.1),
  };
}

function beat(id: string, index: number, narration: string): VisualBeat {
  return {
    id, scene_index: 0, beat_index: index, start_sec: index * 3, end_sec: index * 3 + 3,
    narration, context: { previous: "", next: "" },
    intent: { purpose: "EXPLAIN", information: narration, emotion: "neutral", importance: 0.5 },
    visual_contract: { required: [narration], forbidden: [], required_action: "", viewer_takeaway: narration },
    routing: { preferred: "generated_image", fallback: "motion_graphic", image_style: "realistic" },
    continuity: { group: "", entities: [] },
    retention: { novelty_required: false, visual_change_strength: 0.5, composition: "wide_environment", camera_treatment: "static", subject_placement: "center", explanatory_pattern: "environment" },
    asset_brief: { query: "q", query_variants: ["q1","q2","q3"], generation_prompt: "p", generation_variants: ["prompt one long","prompt two long","prompt three long"], generated_video_prompt: "motion", motion_graphic_brief: "graphic" },
  };
}

test("semantic beat boundaries are mapped to measured ElevenLabs character timestamps", () => {
  const text = "Alpha beta. Gamma delta.";
  const result = alignSceneBeats([
    beat("beat_001", 0, "Alpha beta."),
    beat("beat_002", 1, "Gamma delta."),
  ], alignment(text), text.length * 0.1);
  assert.equal(result[0]!.start_sec, 0);
  assert.equal(result[0]!.end_sec, 1.2);
  assert.equal(result[1]!.start_sec, 1.2);
  assert.equal(result[1]!.end_sec, 2.4);
});

test("paraphrased narration is rejected instead of receiving guessed timing", () => {
  assert.throws(() => alignSceneBeats([
    beat("beat_001", 0, "This is a paraphrase"),
  ], alignment("These are the actual spoken words."), 3.3), /not an exact sequential phrase/);
});

test("a beat whose phrase drifts mid/end is anchored on its verbatim opening, not guessed", () => {
  // The Director appended a word the TTS transcript does not contain.
  const spoken = "Now keep the clock running toward one billion this year.";
  const warnings: string[] = [];
  const result = alignSceneBeats([
    beat("beat_001", 0, "Now keep the clock running"),
    beat("beat_002", 1, "toward one billion dollars this year"),
  ], alignment(spoken), spoken.length * 0.1, { warn: (m) => warnings.push(m) });
  assert.equal(result.length, 2);
  assert.equal(result[0]!.start_sec, 0);
  assert.ok(result[1]!.start_sec > result[0]!.start_sec, "beat_002 start is a real transcript position");
  assert.ok(result[1]!.end_sec > result[1]!.start_sec);
  assert.match(warnings.join("\n"), /beat_002.*anchored/);
});

test("anchoring still fails closed when even the beat opening is a paraphrase", () => {
  assert.throws(() => alignSceneBeats([
    beat("beat_001", 0, "an entirely different opening clause here"),
  ], alignment("These are the actual spoken words that were recorded."), 5.4), /not an exact sequential phrase/);
});

test("a too-short non-verbatim beat is not force-anchored on a fragment", () => {
  assert.throws(() => alignSceneBeats([
    beat("beat_001", 0, "the cat"),
  ], alignment("the dog barked loudly in the yard"), 3.0), /not an exact sequential phrase/);
});
