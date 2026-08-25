import test from "node:test";
import assert from "node:assert/strict";

import { applyPlannerShotAuthority } from "../src/workers/cartoon-scenes-v15.ts";

function entry(sceneIndex: number, heuristicRecipe = "two-shot") {
  return {
    scene_index: sceneIndex,
    source: "template" as const,
    template_category: "cartoon" as const,
    template_data: JSON.stringify({
      shotType: "medium",
      shot: { framing: "two-shot" },
      cinematic: {
        shotRecipe: heuristicRecipe,
        cameraIntent: "static",
        transition: "cut",
        propPlacement: "hand-held",
        propMode: "physical",
        sceneRole: "mechanism",
        continuityGroup: "space:test",
        sfxCue: "none",
        qualityTags: ["cinematic-shot", `recipe:${heuristicRecipe}`],
      },
      rendererPerformance: {
        shotRecipe: heuristicRecipe,
        shotType: "medium",
      },
    }),
  };
}

function parsed(value: ReturnType<typeof entry>) {
  return JSON.parse(value.template_data) as Record<string, any>;
}

test("validated visual-plan framing is authoritative over legacy cinematic heuristics", () => {
  const entries = [
    entry(0, "prop-insert"),
    entry(1, "two-shot"),
    entry(2, "two-shot"),
    entry(3, "callback-reveal"),
    entry(4, "two-shot"),
    entry(5, "reaction-closeup"),
  ];
  const plan = [
    { scene_index: 0, framing: "establishing", camera_motion: "push-in" },
    { scene_index: 1, framing: "reaction-closeup", camera_motion: "reaction-push" },
    { scene_index: 2, framing: "prop-insert", camera_motion: "prop-focus" },
    { scene_index: 3, framing: "over-shoulder", camera_motion: "pan-right" },
    { scene_index: 4, framing: "doorway-transition", camera_motion: "doorway-track" },
    { scene_index: 5, framing: "payoff-hold", camera_motion: "payoff-hold" },
  ];

  const output = applyPlannerShotAuthority(entries, plan);
  const scenes = output.map(parsed);

  assert.deepEqual(
    scenes.map((scene) => scene.cinematic.shotRecipe),
    ["establishing", "reaction-closeup", "prop-insert", "over-shoulder", "crossing-transition", "payoff-hold"],
  );
  assert.deepEqual(
    scenes.map((scene) => scene.shotType),
    ["wide", "close-up", "prop-close-up", "medium", "doorway-transition", "medium"],
  );
  assert.deepEqual(
    scenes.map((scene) => scene.cinematic.cameraIntent),
    ["slow-push", "reaction-push", "prop-focus", "static", "doorway-track", "payoff-hold"],
  );

  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index]!;
    assert.equal(scene.shot.framing, plan[index]!.framing);
    assert.equal(scene.rendererPerformance.plannedFraming, plan[index]!.framing);
    assert.equal(scene.rendererPerformance.plannerShotAuthority, true);
    assert.ok(scene.cinematic.qualityTags.includes("planner-shot-authority"));
    assert.ok(scene.cinematic.qualityTags.includes(`planner-framing:${plan[index]!.framing}`));
  }
});

test("legacy/missing planner framing keeps v14 renderer recipe as fallback", () => {
  const [output] = applyPlannerShotAuthority(
    [entry(9, "callback-reveal")],
    [{ scene_index: 9, camera_motion: "static" }],
  );
  const scene = parsed(output!);
  assert.equal(scene.cinematic.shotRecipe, "callback-reveal");
  assert.equal(scene.shotType, "close-up");
  assert.equal(scene.cinematic.cameraIntent, "static");
});

test("legacy pan/pull camera remains in base camera layer instead of double-moving cinematic layer", () => {
  for (const camera_motion of ["pan-left", "pan-right", "pull-out"] as const) {
    const [output] = applyPlannerShotAuthority(
      [entry(10, "two-shot")],
      [{ scene_index: 10, framing: "two-shot", camera_motion }],
    );
    const scene = parsed(output!);
    assert.equal(scene.cinematic.cameraIntent, "static");
  }
});
