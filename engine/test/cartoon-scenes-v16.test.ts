import assert from "node:assert/strict";
import test from "node:test";
import { applyExplanationFormat } from "../src/workers/cartoon-scenes-v16.ts";
import { shouldEnforceLegacyStagingGates } from "../src/workers/cartoon-scenes.ts";

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

test("only explanation plans bypass legacy puppet staging gates", () => {
  assert.equal(shouldEnforceLegacyStagingGates("explanation_plan"), false);
  assert.equal(shouldEnforceLegacyStagingGates("visual_plan"), true);
  assert.equal(shouldEnforceLegacyStagingGates(undefined), true);
});
