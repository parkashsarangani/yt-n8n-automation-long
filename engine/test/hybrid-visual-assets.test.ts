import test from "node:test";
import assert from "node:assert/strict";

import { selectAiScenes } from "../src/workers/hybrid-visual-assets.ts";

test("hybrid selector protects deterministic explanation scenes and never replaces the payoff", () => {
  const plans = [
    { scene_index: 0, scene_role: "character-hook", visual_operation: "timeline", visual_primitive: "cause-chain", composition_mode: "bookend" },
    { scene_index: 1, scene_role: "diagram-build", visual_operation: "timeline", visual_primitive: "timeline", composition_mode: "full-model" },
    { scene_index: 2, scene_role: "character-reaction", visual_operation: "compress", visual_primitive: "objects", composition_mode: "reaction", character_cut_in: "listener" },
    { scene_index: 3, scene_role: "process-flow", visual_operation: "timeline", visual_primitive: "cause-chain", composition_mode: "full-model" },
    { scene_index: 4, scene_role: "object-state-change", visual_operation: "compress", visual_primitive: "physical-transformation", composition_mode: "full-model" },
    { scene_index: 5, scene_role: "recap", visual_operation: "payoff", visual_primitive: "cause-chain", composition_mode: "bookend" },
  ];
  const scripts = plans.map((scene) => ({ scene_index: scene.scene_index, narration: "A short spoken visual beat for deterministic timing." }));
  const selected = selectAiScenes(plans, scripts, new Map(plans.map((scene) => [scene.scene_index, 4])));

  assert.equal(selected.has(5), false, "final payoff must remain deterministic motion");
  assert.equal(selected.has(1), false, "timeline-heavy explanation scenes should stay motion-first");
  assert.equal(selected.has(3), false, "causal process diagrams should stay motion-first");
  assert.ok(selected.has(0) || selected.has(2) || selected.has(4), "at least one AI-friendly reset should be selected");
});

test("a character-room scene is never swapped for an AI still, even when it would otherwise score high", () => {
  // character-room is a full-screen cinematic-puppet performance (see
  // cartoon-scenes-v16.ts), not a diagram -- an AI still image would either
  // duplicate or contradict what the characters are already doing on
  // screen. character-hook/object-state-change/character_cut_in "both" are
  // exactly the scoring signals that otherwise make a scene a strong AI
  // candidate, so this scene would be selected if the exclusion were missing.
  const plans = [
    { scene_index: 0, scene_role: "character-hook", visual_operation: "timeline", visual_primitive: "cause-chain", composition_mode: "bookend" },
    { scene_index: 1, scene_role: "object-state-change", visual_operation: "compress", visual_primitive: "objects", composition_mode: "character-room", character_cut_in: "both" },
    { scene_index: 2, scene_role: "recap", visual_operation: "payoff", visual_primitive: "cause-chain", composition_mode: "bookend" },
  ];
  const scripts = plans.map((scene) => ({ scene_index: scene.scene_index, narration: "A short spoken visual beat for deterministic timing." }));
  const selected = selectAiScenes(plans, scripts, new Map(plans.map((scene) => [scene.scene_index, 4])));
  assert.equal(selected.has(1), false, "character-room scenes must never be selected for an AI still");
});

test("hybrid selector uses elapsed time rather than a fixed percentage of scene count", () => {
  const plans = Array.from({ length: 9 }, (_, scene_index) => ({
    scene_index,
    scene_role: scene_index === 8 ? "recap" : scene_index % 2 === 0 ? "object-state-change" : "diagram-build",
    visual_operation: scene_index === 8 ? "payoff" : scene_index % 2 === 0 ? "compress" : "timeline",
    visual_primitive: scene_index === 8 ? "objects" : scene_index % 2 === 0 ? "physical-transformation" : "timeline",
    composition_mode: scene_index === 8 ? "bookend" : "full-model",
  }));
  const scripts = plans.map(({ scene_index }) => ({ scene_index, narration: "spoken beat" }));
  const shortDurations = new Map(plans.map(({ scene_index }) => [scene_index, 2]));
  const longDurations = new Map(plans.map(({ scene_index }) => [scene_index, scene_index % 2 === 0 ? 8 : 2]));

  const shortSelection = selectAiScenes(plans, scripts, shortDurations);
  const longSelection = selectAiScenes(plans, scripts, longDurations);

  assert.notDeepEqual([...shortSelection], [...longSelection], "changing spoken-time distribution must be allowed to change visual-reset placement");
  assert.equal(longSelection.has(8), false, "payoff remains deterministic regardless of duration pressure");
});

test("short all-diagram episode still has a valid deterministic path", () => {
  const plans = [0, 1, 2, 3].map((scene_index) => ({
    scene_index,
    scene_role: scene_index === 0 ? "character-hook" : scene_index === 3 ? "recap" : "diagram-build",
    visual_operation: scene_index === 3 ? "payoff" : "timeline",
    visual_primitive: "timeline",
    composition_mode: scene_index === 0 || scene_index === 3 ? "bookend" : "full-model",
  }));
  const selected = selectAiScenes(plans, plans.map(({ scene_index }) => ({ scene_index, narration: "brief line" })));

  assert.equal(selected.has(3), false);
  assert.ok(selected.size <= 1, "diagram-heavy episodes must not be forced into an arbitrary AI quota");
});

test("a long low-scoring stretch still gets a forced reset once the gap exceeds the hard ceiling", () => {
  // scene 0: AI-friendly hook. scenes 1-8: long run of motion-first diagram
  // scenes (score <= 0, excluded from the normal candidate pool). scene 9:
  // deterministic payoff. Each of 1-8 runs 6s, so the gap between the hook's
  // end and the payoff is 48s — well past HARD_CEILING_SEC (20s) and past
  // what the production runs this session showed reads as visually inert.
  const plans = [
    { scene_index: 0, scene_role: "character-hook", visual_operation: "timeline", visual_primitive: "cause-chain", composition_mode: "bookend" },
    ...Array.from({ length: 8 }, (_, i) => ({
      scene_index: i + 1,
      scene_role: "diagram-build",
      visual_operation: "timeline",
      visual_primitive: "timeline",
      composition_mode: "full-model",
    })),
    { scene_index: 9, scene_role: "recap", visual_operation: "payoff", visual_primitive: "cause-chain", composition_mode: "bookend" },
  ];
  const scripts = plans.map(({ scene_index }) => ({ scene_index, narration: "spoken beat" }));
  const durations = new Map(plans.map(({ scene_index }) => [scene_index, scene_index === 0 ? 4 : scene_index === 9 ? 4 : 6]));

  const selected = selectAiScenes(plans, scripts, durations);

  assert.equal(selected.has(9), false, "payoff stays deterministic");
  assert.ok([...selected].some((i) => i >= 1 && i <= 8), "an otherwise-empty 48s stretch must get at least one forced reset");
});

test("the forced reset prefers a non-character scene over a higher-scoring character one", () => {
  // Same 48s dead stretch as above, except scene 3 is identical to its
  // neighbors except for character_cut_in, which raises its raw scoreScene()
  // by +1 -- the highest in the gap. Production evidence (run_3c266ce5:
  // character_cut_in_restraint 35%->44%; run_a53a0170: 35%->38%) showed the
  // valve's plain highest-score pick was inflating character screen time,
  // since any scene converted to ai_broll counts as character-visible by
  // default. The valve must still fill the gap, but not with scene 3.
  const plans = [
    { scene_index: 0, scene_role: "character-hook", visual_operation: "timeline", visual_primitive: "cause-chain", composition_mode: "bookend" },
    ...Array.from({ length: 8 }, (_, i) => ({
      scene_index: i + 1,
      scene_role: "diagram-build",
      visual_operation: "timeline",
      visual_primitive: "timeline",
      composition_mode: "full-model",
      ...(i + 1 === 3 ? { character_cut_in: "listener" } : {}),
    })),
    { scene_index: 9, scene_role: "recap", visual_operation: "payoff", visual_primitive: "cause-chain", composition_mode: "bookend" },
  ];
  const scripts = plans.map(({ scene_index }) => ({ scene_index, narration: "spoken beat" }));
  const durations = new Map(plans.map(({ scene_index }) => [scene_index, scene_index === 0 ? 4 : scene_index === 9 ? 4 : 6]));

  const selected = selectAiScenes(plans, scripts, durations);

  assert.equal(selected.has(9), false, "payoff stays deterministic");
  assert.ok([...selected].some((i) => i >= 1 && i <= 8), "the dead stretch still gets a forced reset");
  assert.equal(selected.has(3), false, "the character-tagged scene must not be the forced pick when a plain alternative exists");
});
