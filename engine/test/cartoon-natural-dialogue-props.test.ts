import test from "node:test";
import assert from "node:assert/strict";

import { makeCartoonSceneCompilerWorker } from "../src/workers/index.ts";

const cast = {
  payload: {
    characters: [
      { character_id: "host", name: "Host", rig: "pilot" },
      { character_id: "buddy", name: "Buddy", rig: "pilot-2" },
    ],
  },
};

const ctx = {
  logger: { log() {}, warn() {}, error() {} },
};

function directedScene(scene_index: number, overrides: Record<string, unknown> = {}) {
  return {
    scene_index,
    template_category: "cartoon",
    background_location: "living-room",
    background_variant: "day",
    background_tone: "neutral",
    framing: "two-shot",
    camera_motion: "static",
    listener_actor_id: "buddy",
    speaker_emotion: "neutral",
    speaker_gesture: "idle",
    speaker_gaze_target: "auto",
    listener_emotion: "neutral",
    listener_gesture: "idle",
    listener_gaze_target: "auto",
    visual_event: "reaction-pop",
    ambient_motion: "subtle-parallax",
    speaker_emphasis: "scale-pop",
    cutaway_label: "",
    primary_prop: "phone",
    prop_state: "phone-visible",
    prop_motion: "none",
    foreground_action: "none",
    ...overrides,
  };
}

function planningScenesWithNaturalDialogue(prop = "clock") {
  return [
    {
      scene_index: 0,
      point: `action=Host checks the clock, confident; prop=${prop}; function=opening_problem engagement; value=the best-case plan starts visibly`,
      narration: "Wait. I'm late?",
      speaker: "host",
      emotion: "surprised",
    },
    {
      scene_index: 1,
      point: `action=Host searches both pockets for keys; prop=${prop}; function=failed_attempt joke; value=hidden delays become visible`,
      narration: "Where are my keys?",
      speaker: "host",
      emotion: "scared",
    },
    {
      scene_index: 2,
      point: `action=Buddy points at the perfect schedule; prop=${prop}; function=midpoint_turn engagement; value=the fantasy plan gets named`,
      narration: "You planned fantasy morning.",
      speaker: "buddy",
      emotion: "neutral",
    },
    {
      scene_index: 3,
      point: `action=The route map turns red; prop=${prop}; function=escalation visual_gag; value=reality adds traffic`,
      narration: "The map just betrayed me.",
      speaker: "host",
      emotion: "angry",
    },
    {
      scene_index: 4,
      point: `action=Buddy adds a buffer to the calendar; prop=${prop}; function=practical_action viewer_value; value=add time before the morning starts`,
      narration: "Add half again.",
      speaker: "buddy",
      emotion: "neutral",
    },
    {
      scene_index: 5,
      point: `action=Host reaches the door and still has eight minutes; prop=${prop}; function=payoff_resolution practical_action callback; value=the buffer changes the outcome`,
      narration: "Still weird. Also working.",
      speaker: "host",
      emotion: "happy",
    },
  ];
}

async function compile(scenes: unknown[], planOverrides: (sceneIndex: number) => Record<string, unknown> = () => ({})) {
  const worker = makeCartoonSceneCompilerWorker();
  return worker.execute(
    {
      plan: {
        payload: {
          scenes: (scenes as Array<{ scene_index: number }>).map((scene) => directedScene(scene.scene_index, planOverrides(scene.scene_index))),
        },
      },
      script: {
        payload: { scenes },
        produced_by: { transformation: "dialogue_script_writer", version: "6" },
      },
      cast,
    } as never,
    ctx as never,
  );
}

test("compiler no longer hard-blocks on textbook-style dialogue (agent stage owns this check)", async () => {
  // Real production failure: run_a1838b5d's writer stage retried this exact
  // heuristic 3 times, then explicitly accepted the script on the last attempt
  // per agent-validators.ts's retry-then-accept policy -- but this compiler-stage
  // copy re-threw the identical check unconditionally, permanently blocking a run
  // the writer had already been allowed to continue. Removed the compiler-stage
  // duplicate; agent-validators.ts's validateDialogueScript is now the sole
  // enforcement point, and it has real retry-with-feedback plus a policy for what
  // happens when a script still misses the bar after 3 tries.
  const scenes = planningScenesWithNaturalDialogue("clock").map((scene, index) => ({
    ...scene,
    narration: [
      "The planning fallacy is a cognitive bias that makes people underestimate time.",
      "Research shows the brain remembers best-case scenarios and ignores hidden delays.",
      "This means your schedule is based on an unrealistic internal model.",
      "In other words, your estimates are systematically optimistic.",
      "The key is to add a buffer before you begin.",
      "That is fascinating, and now the behavior has changed.",
    ][index]!,
  }));

  const out = await compile(scenes, () => ({ primary_prop: "clock", prop_state: "clock-visible" }));
  assert.ok(out.payload);
});

test("compiler no longer hard-blocks planning topics for using phone as the central prop (agent stage owns this check)", async () => {
  const out = await compile(planningScenesWithNaturalDialogue("phone"));
  assert.ok(out.payload);
});

test("planning topics override planner phone defaults with time and routine props", async () => {
  const out = await compile(planningScenesWithNaturalDialogue("clock"), () => ({
    primary_prop: "phone",
    prop_state: "phone-visible",
    visual_event: "screen-change",
  }));

  const payload = out.payload as { scenes: Array<{ template_data: string }> };
  const props = payload.scenes.map((scene) => JSON.parse(scene.template_data).visualEvent.foregroundProp);
  assert.equal(props.some((prop) => prop.type === "phone"), false);
  assert.equal(props[0].type, "clock");
  assert.equal(props[1].type, "keys");
  assert.equal(props[3].type, "route-map");
  assert.equal(props[4].type, "calendar");
  assert.equal(props[5].type, "door");
});
