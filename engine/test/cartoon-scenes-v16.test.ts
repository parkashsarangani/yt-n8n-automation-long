import assert from "node:assert/strict";
import test from "node:test";
import { applyExplanationFormat, normalizeExplanationCompatibilityStaging } from "../src/workers/cartoon-scenes-v16.ts";

test("explanation format makes the model own the frame while preserving cast", () => {
  const entries = [{
    scene_index: 2,
    source: "template" as const,
    template_category: "cartoon",
    template_data: JSON.stringify({
      characters: [
        { characterId: "host", isSpeaking: true },
        { characterId: "buddy", isSpeaking: false },
      ],
      rendererPerformance: { plannerShotAuthority: true },
    }),
  }];
  const plans = [{
    scene_index: 2,
    scene_role: "object-state-change" as const,
    explanation_title: "Why years feel shorter",
    model_elements: ["one year", "lived years"],
    state_before: "1 of 10",
    state_after: "1 of 50",
    key_text: "A smaller fraction",
    character_cut_in: "none" as const,
    sound_cue: "soft-hit" as const,
  }];

  const [scene] = applyExplanationFormat(entries, plans);
  assert.equal(scene?.template_category, "explanation");
  const data = JSON.parse(scene!.template_data);
  assert.equal(data.role, "object-state-change");
  assert.deepEqual(data.characters.map((c: { characterId: string }) => c.characterId), ["host", "buddy"]);
  assert.equal(data.rendererPerformance.explanatoryModelVisible, true);
  assert.equal(data.rendererPerformance.meaningfulStateChange, true);
  assert.equal(data.rendererPerformance.characterCutIn, "none");
});

test("legacy plans remain backward compatible", () => {
  const entries = [{
    scene_index: 0,
    source: "template" as const,
    template_category: "cartoon",
    template_data: "{}",
  }];
  assert.deepEqual(applyExplanationFormat(entries, [{ scene_index: 0 }]), entries);
});


test("explanation plans bypass obsolete puppet staging repetition deterministically", () => {
  const repeated = Array.from({ length: 5 }, (_, offset) => ({
    scene_index: 15 + offset,
    scene_role: "character-hook" as const,
  }));

  const normalized = normalizeExplanationCompatibilityStaging(repeated);
  assert.deepEqual(normalized.map((scene) => scene.template_category), [
    "cartoon", "cartoon", "cartoon", "cartoon", "cartoon",
  ]);
  assert.deepEqual(normalized.map((scene) => scene.framing), [
    "speaker-closeup", "two-shot", "speaker-closeup", "two-shot", "speaker-closeup",
  ]);
  assert.ok(normalized.every((scene) => scene.camera_motion === "static"));
});

test("model scenes use legacy-only prop coverage without changing explanation roles", () => {
  const normalized = normalizeExplanationCompatibilityStaging([
    { scene_index: 2, scene_role: "diagram-build" },
    { scene_index: 3, scene_role: "process-flow" },
  ]);

  assert.deepEqual(normalized.map((scene) => scene.scene_role), ["diagram-build", "process-flow"]);
  assert.deepEqual(normalized.map((scene) => scene.framing), ["prop-insert", "over-shoulder"]);
  assert.ok(normalized.every((scene) => scene.camera_motion === "prop-focus"));
});
