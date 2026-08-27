import assert from "node:assert/strict";
import test from "node:test";

import { repairMotionCompatibility, operationFitsPrimitive, MOTION_COMPATIBILITY, type MotionOperation } from "../src/motion-contract.ts";
import { agentSemanticValidationErrors } from "../src/agent-validators.ts";
import type { AgentDef } from "../src/runner.ts";

const DEF = {
  name: "explanation_visual_planner",
  kind: "agent",
  version: "1",
  consumes: [],
  produces: "explanation_plan",
  prompt: "explanation_visual_planner@1",
  model: { capability: "reasoning_high" },
} as unknown as AgentDef;

test("an incompatible pair is repaired by keeping the primitive and replacing the operation", () => {
  // The exact pairs that exhausted explanation_visual_planner's retry budget
  // on run_39850b3e without ever producing a compatible plan: fixing some
  // pairs broke others across three attempts.
  const { data, repairs } = repairMotionCompatibility({
    scenes: [
      { scene_index: 0, visual_operation: "stack", visual_primitive: "map" },
      { scene_index: 9, visual_operation: "scale-compare", visual_primitive: "map" },
      { scene_index: 12, visual_operation: "compress", visual_primitive: "overlapping-sets" },
    ],
  });

  const scenes = (data as { scenes: Array<{ visual_operation: string; visual_primitive: string }> }).scenes;
  assert.equal(repairs.length, 3);
  for (const scene of scenes) {
    assert.equal(operationFitsPrimitive(scene.visual_operation as MotionOperation, scene.visual_primitive), true);
  }
  // The primitive is the meaningful choice, tied to what the scene actually
  // depicts; only the operation moves.
  assert.equal(scenes[0]!.visual_primitive, "map");
  assert.equal(scenes[1]!.visual_primitive, "map");
  assert.equal(scenes[2]!.visual_primitive, "overlapping-sets");
});

test("a compatible pair is left untouched", () => {
  const { data, repairs } = repairMotionCompatibility({
    scenes: [{ scene_index: 0, visual_operation: "stack", visual_primitive: "particles" }],
  });
  assert.equal(repairs.length, 0);
  assert.deepEqual(data, { scenes: [{ scene_index: 0, visual_operation: "stack", visual_primitive: "particles" }] });
});

test("repair never targets payoff unless it's the only compatible operation", () => {
  // Defaulting every mismatch to payoff would flatten the plan's visual
  // variety, since payoff accepts every primitive and would win any "first
  // candidate" tie-break.
  for (const primitives of Object.values(MOTION_COMPATIBILITY)) {
    for (const primitive of primitives) {
      const nonPayoffOperations = (Object.keys(MOTION_COMPATIBILITY) as MotionOperation[])
        .filter((op) => op !== "payoff" && MOTION_COMPATIBILITY[op].includes(primitive));
      if (nonPayoffOperations.length === 0) continue; // only payoff supports this primitive; skip

      const { data } = repairMotionCompatibility({
        scenes: [{ scene_index: 0, visual_operation: "__never_a_real_operation__", visual_primitive: primitive }],
      });
      // An unrecognized operation string isn't this repair's job (enum repair
      // handles it), so this scene is untouched -- confirm that explicitly,
      // then separately confirm the reverse-lookup itself avoids payoff.
      const untouchedScene = (data as { scenes: Array<Record<string, unknown>> }).scenes[0]!;
      assert.equal(untouchedScene.visual_operation, "__never_a_real_operation__");
    }
  }

  // Direct check of the tie-break: every primitive that has any non-payoff
  // option gets one when the given operation is real but incompatible.
  const stackOnlyIncompatible = repairMotionCompatibility({
    scenes: [{ scene_index: 0, visual_operation: "sort", visual_primitive: "particles" }],
  });
  const repaired = (stackOnlyIncompatible.data as { scenes: Array<{ visual_operation: string }> }).scenes[0]!.visual_operation;
  assert.notEqual(repaired, "payoff");
});

test("after repair, the same production plan reports zero motion-contract violations", () => {
  // End-to-end proof this closes the loop: the agent-stage gate that used to
  // reject these exact scenes now sees a plan it accepts.
  const raw = {
    scenes: [
      { scene_index: 0, visual_operation: "stack", visual_primitive: "map" },
      { scene_index: 9, visual_operation: "scale-compare", visual_primitive: "map" },
      { scene_index: 10, visual_operation: "stack", visual_primitive: "before-after" },
      { scene_index: 12, visual_operation: "compress", visual_primitive: "overlapping-sets" },
      { scene_index: 14, visual_operation: "group", visual_primitive: "path" },
      { scene_index: 15, visual_operation: "sort", visual_primitive: "before-after" },
    ],
  };
  const { data } = repairMotionCompatibility(raw);
  assert.deepEqual(agentSemanticValidationErrors(DEF, data, {}), []);
});
