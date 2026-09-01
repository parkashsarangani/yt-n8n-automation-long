import assert from "node:assert/strict";
import test from "node:test";
import { applyExplanationFormat } from "../src/workers/cartoon-scenes-v16.ts";
import { shouldEnforceLegacyStagingGates } from "../src/workers/cartoon-scenes.ts";
import { shouldApplyLegacyRuntimeDensity } from "../src/workers/cartoon-scenes-v9.ts";

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
  const plans = [{ scene_index: 0, scene_role: "character-hook" as const, visual_operation: "timeline" as const }, {
    scene_index: 2,
    scene_role: "object-state-change" as const,
    visual_operation: "compress" as const,
    visual_primitive: "shells" as const,
    explanation_title: "Why years feel shorter",
    model_elements: ["one year", "lived years"],
    state_before: "1 of 10",
    state_after: "1 of 50",
    key_text: "A smaller fraction",
    character_cut_in: "none" as const,
    sound_cue: "soft-hit" as const,
  }, { scene_index: 4, scene_role: "recap" as const, visual_operation: "payoff" as const }];

  const [scene] = applyExplanationFormat(entries, plans);
  assert.equal(scene?.template_category, "explanation");
  const data = JSON.parse(scene!.template_data);
  assert.equal(data.role, "object-state-change");
  assert.equal(data.visualOperation, "compress");
  assert.equal(data.visualPrimitive, "shells");
  assert.equal(data.visualState, "mechanism");
  assert.equal(data.compositionMode, "full-model");
  assert.equal(data.numericValue, null);
  assert.equal(data.formatVersion, 4);
  assert.equal(data.title, "", "middle scenes must not render slide headings");
  assert.deepEqual(data.characters.map((c: { characterId: string }) => c.characterId), ["host", "buddy"]);
  assert.equal(data.rendererPerformance.explanatoryModelVisible, true);
  assert.equal(data.rendererPerformance.meaningfulStateChange, true);
  assert.equal(data.rendererPerformance.characterCutIn, "none");
  assert.equal(data.rendererPerformance.visualOperation, "compress");
});

test("opening and closing scenes always render both-character bookends", () => {
  const entries = [0, 1, 2].map((scene_index) => ({
    scene_index,
    source: "template" as const,
    template_category: "cartoon",
    template_data: JSON.stringify({ characters: [
      { characterId: "buddy", isSpeaking: scene_index === 0 },
      { characterId: "host", isSpeaking: scene_index !== 0 },
    ] }),
  }));
  const plans = [
    { scene_index: 0, scene_role: "diagram-build", visual_operation: "counter", visual_primitive: "particles", character_cut_in: "none" },
    { scene_index: 1, scene_role: "process-flow", visual_operation: "timeline", visual_primitive: "path", character_cut_in: "none" },
    { scene_index: 2, scene_role: "kinetic-emphasis", visual_operation: "sort", visual_primitive: "objects", character_cut_in: "speaker" },
  ];
  const scenes = applyExplanationFormat(entries, plans);
  const opening = JSON.parse(scenes[0]!.template_data);
  const middle = JSON.parse(scenes[1]!.template_data);
  const closing = JSON.parse(scenes[2]!.template_data);
  assert.equal(opening.role, "character-hook");
  assert.equal(opening.characterCutIn, "both");
  assert.equal(opening.compositionMode, "bookend");
  assert.equal(middle.characterCutIn, "none");
  assert.equal(closing.role, "recap");
  assert.equal(closing.visualOperation, "payoff");
  assert.equal(closing.visualPrimitive, "particles");
  assert.equal(closing.characterCutIn, "both");
  assert.equal(closing.compositionMode, "bookend");
  assert.equal(closing.visualState, "payoff");
  assert.equal(opening.rendererPerformance.roleWasNormalized, true);
  assert.equal(closing.rendererPerformance.cutInWasNormalized, true);
});

test("older plans infer subject-shaped primitives without blocking resume", () => {
  const entries = [{
    scene_index: 6,
    source: "template" as const,
    template_category: "cartoon",
    template_data: "{}",
  }];
  const [scene] = applyExplanationFormat(entries, [{
    scene_index: 6,
    scene_role: "process-flow",
    visual_operation: "timeline",
    explanation_title: "Trace every sightline",
    model_elements: ["Earth", "sightline", "distant star"],
  }]);
  const data = JSON.parse(scene!.template_data);
  assert.equal(data.visualPrimitive, "rays");
  assert.equal(data.rendererPerformance.visualPrimitive, "rays");
});

test("recap reuses the opening primitive for a visual callback", () => {
  const entries = [0, 2].map((scene_index) => ({
    scene_index,
    source: "template" as const,
    template_category: "cartoon",
    template_data: "{}",
  }));
  const scenes = applyExplanationFormat(entries, [
    {
      scene_index: 0,
      scene_role: "character-hook",
      visual_operation: "timeline",
      visual_primitive: "particles",
      model_elements: ["dark sky", "stars"],
    },
    {
      scene_index: 2,
      scene_role: "recap",
      visual_operation: "payoff",
      visual_primitive: "objects",
      key_text: "The darkness is evidence",
    },
  ]);
  const recap = JSON.parse(scenes[1]!.template_data);
  assert.equal(recap.visualPrimitive, "particles");
  assert.deepEqual(recap.elements, ["dark sky", "stars"], "recap must reconstruct the opening entities");
  assert.deepEqual(recap.entityIdentityKeys, ["dark sky", "stars"]);
  assert.equal(recap.before, "", "payoff must not retain secondary hypothesis copy");
  assert.equal(recap.rendererPerformance.primitiveWasNormalized, true);
});

test("explanation scenes cannot pass with semantic roles alone", () => {
  const entries = [{
    scene_index: 4,
    source: "template" as const,
    template_category: "cartoon",
    template_data: "{}",
  }];
  assert.throws(
    () => applyExplanationFormat(entries, [{ scene_index: 4, scene_role: "diagram-build" }]),
    /requires a valid visual_operation/,
  );
});

test("a preserved recap plan is normalized to the decisive payoff on resume", () => {
  const entries = [{
    scene_index: 31,
    source: "template" as const,
    template_category: "cartoon",
    template_data: "{}",
  }];
  const [scene] = applyExplanationFormat(entries, [{
    scene_index: 31,
    scene_role: "recap",
    visual_operation: "timeline",
    key_text: "Days worth remembering",
  }]);
  const data = JSON.parse(scene!.template_data);
  assert.equal(data.visualOperation, "payoff");
  assert.equal(data.rendererPerformance.visualOperation, "payoff");
  assert.equal(data.rendererPerformance.operationWasNormalized, true);
});

test("missing or unknown operations still block instead of being invented", () => {
  const entries = [{
    scene_index: 31,
    source: "template" as const,
    template_category: "cartoon",
    template_data: "{}",
  }];
  assert.throws(
    () => applyExplanationFormat(entries, [{
      scene_index: 31,
      scene_role: "recap",
      visual_operation: "unknown",
    }]),
    /requires a valid visual_operation/,
  );
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

test("character-room scenes pass through the full cartoon payload untouched", () => {
  // A character-room scene has no diagram at all: the v1-v15 cinematic-puppet
  // compiler already built a complete CartoonScene payload (background,
  // camera, both characters gestured/gazed per the plan) for this scene --
  // applyExplanationFormat must not overwrite it with a diagram-shaped
  // explanation payload the way it does for every other composition_mode.
  const entries = [{
    scene_index: 1,
    source: "template" as const,
    template_category: "cartoon",
    template_data: JSON.stringify({
      background: { location: "kitchen", variant: "day" },
      camera: { type: "static" },
      characters: [
        { characterId: "host", isSpeaking: true },
        { characterId: "buddy", isSpeaking: false },
      ],
    }),
  }];
  const plans = [
    { scene_index: 0, scene_role: "character-hook" as const, visual_operation: "timeline" as const },
    {
      scene_index: 1,
      scene_role: "character-reaction" as const,
      visual_operation: "payoff" as const,
      visual_primitive: "objects" as const,
      composition_mode: "character-room" as const,
      character_cut_in: "both" as const,
    },
    { scene_index: 2, scene_role: "recap" as const, visual_operation: "payoff" as const },
  ];
  const [scene] = applyExplanationFormat(entries, plans);
  assert.equal(scene, entries[0], "character-room scene must be returned byte-identical, not reformatted");
  assert.equal(scene?.template_category, "cartoon");
  const data = JSON.parse(scene!.template_data);
  assert.equal(data.background.location, "kitchen");
  assert.deepEqual(data.characters.map((c: { characterId: string }) => c.characterId), ["host", "buddy"]);
});

test("a trailing character-room outro scene does not steal the closing bookend from the real recap", () => {
  // Real bug this guards: the outro scene (the spoken CTA, always the
  // literal last scene when the script authors one) used to be
  // orderedPlans[orderedPlans.length - 1] for computing which scene "is
  // closing" -- which forced the recap scene right before it to be treated
  // as an ordinary middle scene (no bookend, no reused opening entities),
  // silently dropping the show's own closing-bookend guarantee the moment
  // an outro scene existed.
  const entries = [0, 1, 2].map((scene_index) => ({
    scene_index,
    source: "template" as const,
    template_category: "cartoon" as const,
    template_data: JSON.stringify({
      characters: [
        { characterId: "buddy", isSpeaking: scene_index !== 1 },
        { characterId: "host", isSpeaking: scene_index === 1 },
      ],
    }),
  }));
  const plans = [
    {
      scene_index: 0, scene_role: "character-hook" as const, visual_operation: "timeline" as const,
      visual_primitive: "cause-chain" as const, model_elements: ["Widget"],
      state_before: "unknown", state_after: "understood", key_text: "hook", character_cut_in: "both" as const,
    },
    {
      scene_index: 1, scene_role: "recap" as const, visual_operation: "payoff" as const,
      visual_primitive: "cause-chain" as const, model_elements: ["Different Widget"],
      state_before: "before", state_after: "after", key_text: "recap", character_cut_in: "both" as const,
    },
    {
      scene_index: 2, scene_role: "character-reaction" as const, visual_operation: "payoff" as const,
      composition_mode: "character-room" as const, character_cut_in: "both" as const,
    },
  ];
  const scenes = applyExplanationFormat(entries, plans);
  const recap = JSON.parse(scenes[1]!.template_data);
  const outro = scenes[2]!;

  assert.equal(recap.compositionMode, "bookend", "the real recap scene must still get the closing bookend treatment");
  assert.deepEqual(recap.elements, ["Widget"], "the recap must reuse the opening's entities, not its own authored ones");
  assert.equal(outro.template_category, "cartoon", "the outro scene passes through untouched via the character-room bypass");
});

test("only explanation plans bypass legacy puppet staging gates", () => {
  assert.equal(shouldEnforceLegacyStagingGates("explanation_plan"), false);
  assert.equal(shouldEnforceLegacyStagingGates("visual_plan"), true);
  assert.equal(shouldEnforceLegacyStagingGates(undefined), true);
});

test("long explanation episodes bypass puppet-era prop and cutaway density", () => {
  assert.equal(shouldApplyLegacyRuntimeDensity({ schema_id: "explanation_plan" }), false);
  assert.equal(shouldApplyLegacyRuntimeDensity({ schema_id: "visual_plan" }), true);
  assert.equal(shouldApplyLegacyRuntimeDensity(undefined), true);
});


test("relational claims infer reusable relationship primitives", () => {
  const entries = [0, 1, 2].map((scene_index) => ({
    scene_index,
    source: "template" as const,
    template_category: "cartoon",
    template_data: "{}",
  }));
  const scenes = applyExplanationFormat(entries, [
    { scene_index: 0, scene_role: "character-hook", visual_operation: "group", explanation_title: "One reality appears as many forms", model_elements: ["one source", "many forms"] },
    { scene_index: 1, scene_role: "diagram-build", visual_operation: "group", explanation_title: "Facets around one center", model_elements: ["center", "facets"] },
    { scene_index: 2, scene_role: "recap", visual_operation: "payoff", explanation_title: "Distinct forms remain connected", model_elements: ["forms", "source"] },
  ]);
  const opening = JSON.parse(scenes[0]!.template_data);
  const middle = JSON.parse(scenes[1]!.template_data);
  assert.equal(opening.visualPrimitive, "facets-around-center");
  assert.equal(middle.visualPrimitive, "facets-around-center");
  assert.equal(opening.compositionMode, "bookend");
  assert.equal(middle.compositionMode, "full-model");
});


test("compiler rejects semantic primitives paired with meaningless operations", () => {
  const entries = [4, 5].map((scene_index) => ({ scene_index, source: "template" as const, template_category: "cartoon", template_data: "{}" }));
  assert.throws(() => applyExplanationFormat(entries, [
    {
      scene_index: 4,
      scene_role: "diagram-build",
      visual_operation: "sort",
      visual_primitive: "network",
    },
    {
      scene_index: 5,
      scene_role: "recap",
      visual_operation: "payoff",
      visual_primitive: "network",
    },
  ]), /incompatible with visual_primitive/);
});
