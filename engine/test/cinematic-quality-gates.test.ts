import test from "node:test";
import assert from "node:assert/strict";

import { agentSemanticValidationErrors } from "../src/agent-validators.ts";
import type { AgentDef } from "../src/runner.ts";
import type { Artifact } from "../src/artifact.ts";

const DIALOGUE_DEF = {
  name: "dialogue_script_writer",
  kind: "agent",
  version: "9",
  consumes: [],
  produces: "script",
  prompt: "dialogue_script_writer@9",
  model: { capability: "reasoning_high" },
} as unknown as AgentDef;

const VISUAL_DEF = {
  name: "cartoon_visual_planner",
  kind: "agent",
  version: "12",
  consumes: [],
  produces: "visual_plan",
  prompt: "cartoon_visual_planner@12",
  model: { capability: "reasoning_high" },
} as unknown as AgentDef;

function scriptScene(scene_index: number, narration: string, point = "action=Host grabs the charger; prop=charger; function=beat; value=viewer sees the concrete object") {
  return { scene_index, act_index: 0, speaker: "host", emotion: "neutral", narration, point };
}

test("dialogue gate rejects exact duplicate caption lines", () => {
  const errors = agentSemanticValidationErrors(
    DIALOGUE_DEF,
    { scenes: [
      scriptScene(0, "Wait. Why am I in here?"),
      scriptScene(1, "You had a whole mission thirty seconds ago."),
      scriptScene(2, "So walking through actually erases stuff?"),
      scriptScene(3, "So walking through actually erases stuff?"),
      scriptScene(4, "Say the cue while you cross."),
    ] },
    {},
  );

  assert.match(errors.join("\n"), /exactly repeats/);
});

test("dialogue gate rejects adjacent object chants", () => {
  const errors = agentSemanticValidationErrors(
    DIALOGUE_DEF,
    { scenes: [
      scriptScene(0, "Wait. Why am I in here?"),
      scriptScene(1, "The charger stayed behind."),
      scriptScene(2, "Charger. Charger. Say it till you're through."),
      scriptScene(3, "There it is. First try."),
    ] },
    {},
  );

  assert.match(errors.join("\n"), /repeats "charger" consecutively/);
});

function visualScene(scene_index: number, overrides: Record<string, unknown> = {}) {
  return {
    scene_index,
    template_category: "cartoon",
    background_location: "living-room",
    background_variant: "day",
    framing: "two-shot",
    camera_motion: "static",
    visual_event: "none",
    ambient_motion: "none",
    primary_prop: "charger",
    foreground_action: "visible",
    ...overrides,
  };
}

function scriptInput(count: number, doorway = false): Record<string, Artifact> {
  return {
    script: {
      schema_id: "script",
      schema_version: "1.0.0",
      payload: {
        scenes: Array.from({ length: count }, (_, index) => scriptScene(
          index,
          index === 0 ? "Wait. Why am I in here?" : `Line ${index} moves the scene.`,
          doorway
            ? "action=Host crosses the doorway looking for the charger; prop=door; function=spatial beat; value=viewer sees room change"
            : "action=Host handles the charger; prop=charger; function=beat; value=viewer sees action",
        )),
      },
    },
  } as unknown as Record<string, Artifact>;
}

test("visual planner gate rejects long static beginner layouts", () => {
  const errors = agentSemanticValidationErrors(
    VISUAL_DEF,
    { scenes: Array.from({ length: 13 }, (_, index) => visualScene(index)) },
    scriptInput(13),
  );

  const message = errors.join("\n");
  assert.match(message, /too static/);
  assert.match(message, /shot rhythm is too flat/);
  assert.match(message, /camera direction is too flat/);
});

test("visual planner gate enforces doorway spatial continuity", () => {
  const errors = agentSemanticValidationErrors(
    VISUAL_DEF,
    { scenes: Array.from({ length: 13 }, (_, index) => visualScene(index, {
      background_location: index < 8 ? "hallway" : "living-room",
      primary_prop: index < 8 ? "door" : "charger",
      foreground_action: index < 8 ? "Host stands by the door" : "Host grabs the charger",
      framing: index % 3 === 0 ? "doorway-transition" : "two-shot",
      camera_motion: index % 3 === 0 ? "doorway-track" : "static",
      ambient_motion: "subtle-parallax",
    })) },
    scriptInput(13, true),
  );

  assert.match(errors.join("\n"), /doorway\/set-piece appears/);
});

test("visual planner gate accepts crossing expressed through shot direction", () => {
  const scenes = Array.from({ length: 13 }, (_, index) => {
    const location = index < 3 ? "living-room" : index === 3 ? "living-room" : index < 9 ? "kitchen" : "office";
    const framing = index === 0 ? "establishing" : index === 3 ? "doorway-transition" : ["two-shot", "prop-insert", "reaction-closeup", "over-shoulder", "payoff-hold"][index % 5];
    const camera = index === 3 ? "doorway-track" : ["static", "push-in", "prop-focus", "reaction-push"][index % 4];
    return visualScene(index, {
      background_location: location,
      framing,
      camera_motion: camera,
      primary_prop: index === 3 ? "door" : "charger",
      foreground_action: index === 3 ? "Host crosses through the doorway into the kitchen" : "Host handles the charger",
      ambient_motion: index === 3 ? "doorway-cross" : index % 2 === 0 ? "subtle-parallax" : "window-light",
    });
  });

  const errors = agentSemanticValidationErrors(VISUAL_DEF, { scenes }, scriptInput(13, true));
  assert.deepEqual(errors, []);
});

test("visual planner gate accepts a directed multi-location plan", () => {
  const scenes = Array.from({ length: 13 }, (_, index) => {
    const location = index < 3 ? "living-room" : index < 5 ? "hallway" : index < 10 ? "kitchen" : "office";
    const framing = ["establishing", "two-shot", "prop-insert", "listener-closeup", "over-shoulder"][index % 5];
    const camera = ["static", "push-in", "prop-focus", "reaction-push"][index % 4];
    return visualScene(index, {
      background_location: location,
      framing,
      camera_motion: camera,
      primary_prop: index === 3 ? "door" : "charger",
      foreground_action: index === 3 ? "Host crosses the doorway" : "Host handles the charger",
      ambient_motion: index % 2 === 0 ? "subtle-parallax" : "window-light",
    });
  });

  const errors = agentSemanticValidationErrors(VISUAL_DEF, { scenes }, scriptInput(13, true));
  assert.deepEqual(errors, []);
});
