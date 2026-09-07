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

test("an unanchorable opening beat fails closed instead of receiving guessed timing", () => {
  assert.throws(() => alignSceneBeats([
    beat("beat_001", 0, "This is a paraphrase"),
  ], alignment("These are the actual spoken words."), 3.3), /opening beat narration is not in the ElevenLabs transcript/);
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

test("a mid-scene beat whose narration is not in the transcript is dropped, not fatal", () => {
  // beat_002's quoted line was hallucinated; beats 1 and 3 are verbatim.
  const spoken = "First we set the scene. Then the surprise lands. Finally it all resolves.";
  const warnings: string[] = [];
  const result = alignSceneBeats([
    beat("beat_001", 0, "First we set the scene."),
    beat("beat_002", 1, "a line the narrator never actually said out loud"),
    beat("beat_003", 2, "Finally it all resolves."),
  ], alignment(spoken), spoken.length * 0.1, { warn: (m) => warnings.push(m) });
  assert.deepEqual(result.map((b) => b.id), ["beat_001", "beat_003"]);
  assert.equal(result[0]!.start_sec, 0);
  // beat_001's window now stretches to beat_003's real start
  assert.ok(result[0]!.end_sec === result[1]!.start_sec);
  assert.match(warnings.join("\n"), /beat_002: narration not found in transcript; dropping/);
});

test("a scene fails closed when more than half its beats are not in the transcript", () => {
  const spoken = "Only this sentence was actually spoken aloud.";
  assert.throws(() => alignSceneBeats([
    beat("beat_001", 0, "Only this sentence was actually spoken aloud."),
    beat("beat_002", 1, "invented clause one that was never uttered"),
    beat("beat_003", 2, "invented clause two also never uttered"),
  ], alignment(spoken), spoken.length * 0.1), /does not match the voice-over/);
});
