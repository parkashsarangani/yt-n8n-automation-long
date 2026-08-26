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

test("dialogue gate catches a non-payoff ending at the writer stage, not just the compiler", () => {
  // Real production failure: a 13-scene script's final scene read
  // "function=transition; value=the next explanation begins from the
  // immediate problem" -- a mid-story transition beat, not an ending. This
  // used to only be caught by the compiler worker (cartoon-scenes.ts's
  // assertV3ScriptContract), which has no retry, so the script got stored
  // and then blocked the run permanently. Catching it here means the writer
  // gets a real retry-with-feedback chance to actually finish the story.
  const errors = agentSemanticValidationErrors(
    DIALOGUE_DEF,
    { scenes: [
      scriptScene(0, "Wait, why am I so tired?", "action=Host yawns over cold coffee; prop=coffee; function=opening_problem; value=the tiredness is visible immediately"),
      scriptScene(1, "You slept eight hours.", "action=Buddy circles the eight-hour total on the calendar; prop=calendar; function=compact_fact; value=the assumption gets challenged"),
      scriptScene(2, "So the number was lying.", "action=Host drops the schedule card beside the coffee; prop=coffee; function=act_turn; value=the opening assumption breaks"),
      scriptScene(3, "There is more to it.", "action=Buddy pulls open a curtain showing the dark morning outside; prop=window; function=transition; value=the next explanation begins from the immediate problem"),
    ] },
    {},
  );

  assert.match(errors.join("\n"), /final scene point must mark a payoff\/resolution/);
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

test("visual planner gate no longer rejects a static single-environment/single-shot layout", () => {
  // Product direction: storytelling and concept explanation over cinematic
  // environment/shot/camera variety. Dropped the environment-distinctness,
  // environment-repeat-run, framing-variety, and camera-motion-variety
  // checks -- a 13-scene demonstration that stays in one room with the same
  // framing throughout is legitimate as long as the prop is actually used
  // (foreground_action is real, not the placeholder "visible" this fixture
  // used to rely on to trip the checks this test used to assert on).
  const errors = agentSemanticValidationErrors(
    VISUAL_DEF,
    { scenes: Array.from({ length: 13 }, (_, index) => visualScene(index, { foreground_action: `Host holds the charger and does step ${index} of the demonstration` })) },
    scriptInput(13),
  );

  assert.deepEqual(errors, []);
});

test("visual planner gate still rejects central props with no real physical action", () => {
  const errors = agentSemanticValidationErrors(
    VISUAL_DEF,
    { scenes: Array.from({ length: 13 }, (_, index) => visualScene(index)) },
    scriptInput(13),
  );

  assert.match(errors.join("\n"), /central props lack physical foreground_action/);
});

test("visual planner gate still enforces doorway spatial continuity ordering", () => {
  // The door/set-piece screen-time proportion check was dropped (cinematic
  // concern), but the ordering check stayed: a doorway/spatial story still
  // needs a real room A before the crossing beat and a different room B
  // after it for the "room changed" story point to actually track.
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

  assert.match(errors.join("\n"), /doorway\/spatial episode lacks ordered continuity/);
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

test("visual planner gate rejects a room A that only appears after the crossing beat", () => {
  // The crossing beat is the very first scene, so there is no room A before it.
  // An "office" scene appearing later (after the crossing) must not count as
  // satisfying room A -- continuity requires ordering, not just presence anywhere.
  const scenes = Array.from({ length: 13 }, (_, index) => {
    const location = index === 0 ? "living-room" : index < 9 ? "kitchen" : "office";
    const framing = index === 0 ? "doorway-transition" : ["two-shot", "prop-insert", "reaction-closeup", "over-shoulder", "payoff-hold"][index % 5];
    const camera = index === 0 ? "doorway-track" : ["static", "push-in", "prop-focus", "reaction-push"][index % 4];
    return visualScene(index, {
      background_location: location,
      framing,
      camera_motion: camera,
      primary_prop: index === 0 ? "door" : "charger",
      foreground_action: index === 0 ? "Host crosses through the doorway into the kitchen" : "Host handles the charger",
      ambient_motion: index === 0 ? "doorway-cross" : index % 2 === 0 ? "subtle-parallax" : "window-light",
    });
  });

  const errors = agentSemanticValidationErrors(VISUAL_DEF, { scenes }, scriptInput(13, true));
  assert.match(errors.join("\n"), /lacks ordered continuity/);
});

test("visual planner gate does not mistake an unrelated object door for the crossing beat", () => {
  // Real production failure: scene 0's foreground_action described "the open
  // fridge door" (a kitchen prop, not a room crossing). The old crossing-beat
  // regex matched "open ... door" generically and misidentified scene 0 as
  // the crossing beat, leaving no room before it and failing continuity even
  // though the real hallway/doorway-transition/doorway-track crossing at
  // scene 7 -- with a proper room A before it and room B after -- was fine.
  const scenes = Array.from({ length: 13 }, (_, index) => {
    if (index === 0) {
      return visualScene(index, {
        background_location: "kitchen",
        framing: "establishing",
        camera_motion: "push-in",
        primary_prop: "appliance",
        foreground_action: "Host grips the open fridge door, looks down at both empty hands",
        ambient_motion: "subtle-parallax",
      });
    }
    if (index === 6) {
      return visualScene(index, {
        background_location: "hallway",
        framing: "doorway-transition",
        camera_motion: "doorway-track",
        primary_prop: "door",
        foreground_action: "Host crosses through the doorway into the living-room",
        ambient_motion: "doorway-cross",
      });
    }
    return visualScene(index, {
      background_location: index < 6 ? "kitchen" : "living-room",
      framing: ["two-shot", "prop-insert", "reaction-closeup", "over-shoulder", "payoff-hold"][index % 5],
      camera_motion: ["static", "push-in", "prop-focus", "reaction-push"][index % 4],
      primary_prop: "charger",
      foreground_action: "Host handles the charger",
      ambient_motion: index % 2 === 0 ? "subtle-parallax" : "window-light",
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
