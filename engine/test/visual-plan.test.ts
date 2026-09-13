import test from "node:test";
import assert from "node:assert/strict";
import { buildVisualPlan, visualPrompt } from "../src/visual-plan.ts";

test("cards use approved narration and narration edits invalidate artwork reuse", () => {
  const scene = { scene_index: 0, point: "[response_a] compare choices", narration: "Save the notice. Request the complete recording." };
  const plan = buildVisualPlan([scene]);
  const overlay = plan.beats[0]!.overlay!;
  assert.equal(overlay.body, "Save the notice.");
  assert.doesNotMatch(JSON.stringify(overlay), /Pause, choose|Carry it forward/);
  assert.notEqual(plan.reference.id, buildVisualPlan([{ ...scene, narration: "A different account." }]).reference.id);
});

test("visual planning maps approved story beats to purposeful visual states", () => {
  const plan = buildVisualPlan([
    { scene_index: 0, point: "[scenario] establish the situation", narration: "A colleague cuts across the point you were making." },
    { scene_index: 1, point: "[response_a] the automatic response", narration: "You rush to explain yourself and the room gets quieter." },
    { scene_index: 2, point: "[explanation] keep the detail", narration: "The message shows exactly where the misunderstanding began." },
    { scene_index: 3, point: "[exercise] practise the sequence", narration: "First notice the pressure, then choose one clear sentence." },
    { scene_index: 4, point: "[payoff] return to the choice", narration: "The result is a calmer conversation, not a guaranteed agreement." },
  ], { lessonTitle: "A better response" });

  assert.equal(plan.version, "1");
  assert.match(plan.reference.id, /^quiet-signal-[0-9a-f]{16}$/);
  assert.deepEqual(plan.beats.map((beat) => beat.kind), ["artwork", "comparison", "document", "timeline", "payoff"]);
  assert.equal(plan.beats.filter((beat) => beat.requires_artwork).length, 1);
  assert.ok(plan.beats.every((beat) => beat.viewer_understands.length > 8));
  assert.ok(plan.beats.every((beat) => beat.overlay));
});

test("visual artwork requests are bounded and carry one continuity reference", () => {
  const scenes = Array.from({ length: 12 }, (_, scene_index) => ({
    scene_index,
    point: "[scenario] a new related situation",
    narration: "The same subject faces another small social decision.",
  }));
  const plan = buildVisualPlan(scenes, { maxArtwork: 3 });
  assert.equal(plan.beats.filter((beat) => beat.requires_artwork).length, 3);
  const prompts = plan.beats.filter((beat) => beat.requires_artwork).map((beat) => visualPrompt(plan, beat));
  assert.equal(new Set(prompts.map((prompt) => prompt.match(/Episode continuity reference ([^:]+):/)?.[1])).size, 1);
  assert.ok(prompts.every((prompt) => /text-free|never render this text/i.test(prompt)));
});
