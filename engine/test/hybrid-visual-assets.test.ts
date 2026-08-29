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
