import test from "node:test";
import assert from "node:assert/strict";

import { makeCartoonSceneCompilerWorker } from "../src/workers/cartoon-scenes.ts";

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
    visual_event: "none",
    ambient_motion: "subtle-parallax",
    speaker_emphasis: "scale-pop",
    cutaway_label: "",
    ...overrides,
  };
}

test("cartoon compiler rejects more than four identical static scenes without a visual event", async () => {
  const worker = makeCartoonSceneCompilerWorker();
  await assert.rejects(
    () => worker.execute(
      {
        plan: { payload: { scenes: Array.from({ length: 5 }, (_, scene_index) => directedScene(scene_index)) } },
        script: {
          payload: {
            scenes: Array.from({ length: 5 }, (_, scene_index) => ({
              scene_index,
              point: `beat-${scene_index}`,
              narration: `Static line ${scene_index}.`,
              speaker: scene_index % 2 === 0 ? "host" : "buddy",
              emotion: "neutral",
            })),
          },
          produced_by: { transformation: "dialogue_script_writer", version: "2" },
        },
        cast,
      } as never,
      ctx as never,
    ),
    /rejected repetitive staging: scenes 0-4 repeat living-room\/day\/two-shot without visual_event/,
  );
});

test("dialogue_script_writer v3 scripts must mark final payoff or resolution", async () => {
  const worker = makeCartoonSceneCompilerWorker();
  await assert.rejects(
    () => worker.execute(
      {
        plan: { payload: { scenes: [directedScene(0), directedScene(1, { visual_event: "reaction-pop" })] } },
        script: {
          payload: {
            scenes: [
              { scene_index: 0, point: "opening problem", narration: "They called my name.", speaker: "host", emotion: "scared" },
              { scene_index: 1, point: "summary", narration: "So public speaking is old fear.", speaker: "buddy", emotion: "neutral" },
            ],
          },
          produced_by: { transformation: "dialogue_script_writer", version: "3" },
        },
        cast,
      } as never,
      ctx as never,
    ),
    /final scene point must mark a payoff\/resolution/,
  );
});

test("long dialogue_script_writer v3 scripts must carry midpoint and engagement metadata", async () => {
  const worker = makeCartoonSceneCompilerWorker();
  const longScenes = Array.from({ length: 20 }, (_, scene_index) => ({
    scene_index,
    point: scene_index === 19 ? "payoff resolves opening" : `explanation beat ${scene_index}`,
    narration: "This line keeps explaining the idea without a joke, callback, or midpoint turn.",
    speaker: scene_index % 2 === 0 ? "host" : "buddy",
    emotion: "neutral",
  }));

  await assert.rejects(
    () => worker.execute(
      {
        plan: { payload: { scenes: longScenes.map((scene) => directedScene(scene.scene_index, { visual_event: scene.scene_index % 5 === 0 ? "reaction-pop" : "none" })) } },
        script: {
          payload: { scenes: longScenes },
          produced_by: { transformation: "dialogue_script_writer", version: "3" },
        },
        cast,
      } as never,
      ctx as never,
    ),
    /long scripts must include a midpoint turn\/reframe point/,
  );
});

test("dialogue_script_writer v5 scripts must include action metadata", async () => {
  const worker = makeCartoonSceneCompilerWorker();
  const scenes = Array.from({ length: 5 }, (_, scene_index) => ({
    scene_index,
    point: scene_index === 4 ? "payoff_resolution summary" : `explanation beat ${scene_index}`,
    narration: "This explains the phone habit but does not direct visible action.",
    speaker: scene_index % 2 === 0 ? "host" : "buddy",
    emotion: "neutral",
  }));

  await assert.rejects(
    () => worker.execute(
      {
        plan: { payload: { scenes: scenes.map((scene) => directedScene(scene.scene_index, { visual_event: "reaction-pop" })) } },
        script: {
          payload: { scenes },
          produced_by: { transformation: "dialogue_script_writer", version: "5" },
        },
        cast,
      } as never,
      ctx as never,
    ),
    /action quality gate failed: scenes 0, 1, 2, 3, 4 must include action=, function=, and value=/,
  );
});

test("dialogue_script_writer v5 scripts must score at least 8\/10 for visible action and payoff", async () => {
  const worker = makeCartoonSceneCompilerWorker();
  const scenes = [
    {
      scene_index: 0,
      point: "action=Host freezes with phone already unlocked; prop=phone; function=opening_problem; value=viewer recognizes automatic checking",
      narration: "Wait. I am holding my phone again.",
      speaker: "host",
      emotion: "surprised",
    },
    {
      scene_index: 1,
      point: "action=Buddy points at the phone in Host's hand; prop=phone; function=escalation engagement; value=the habit is visible, not abstract",
      narration: "You did not even blink first.",
      speaker: "buddy",
      emotion: "neutral",
    },
    {
      scene_index: 2,
      point: "action=Host places the phone face down; prop=phone; function=failed_attempt joke; value=a small attempt becomes testable",
      narration: "Fine. One minute. No checking.",
      speaker: "host",
      emotion: "neutral",
    },
    {
      scene_index: 3,
      point: "action=Phone lights up and Host's hand drifts back; prop=phone; function=midpoint_turn visual_gag; value=the cue pulls behavior before choice",
      narration: "My thumb has apparently formed a union.",
      speaker: "host",
      emotion: "scared",
    },
    {
      scene_index: 4,
      point: "action=Buddy slides the phone across the table; prop=phone; function=practical_action viewer_value; value=remove the cue before willpower is needed",
      narration: "Move the cue. Then decide.",
      speaker: "buddy",
      emotion: "neutral",
    },
    {
      scene_index: 5,
      point: "action=Host reaches, notices, and grabs the kettle instead; prop=phone; function=payoff_resolution practical_action callback; value=replaces the cue with changed behavior",
      narration: "Kettle wins one.",
      speaker: "host",
      emotion: "happy",
    },
  ];

  const out = await worker.execute(
    {
      plan: {
        payload: {
          scenes: scenes.map((scene) => directedScene(scene.scene_index, {
            visual_event: scene.scene_index === 0 || scene.scene_index === 3 ? "screen-change" : "reaction-pop",
            ambient_motion: scene.scene_index === 3 ? "monitor-glow" : "subtle-parallax",
          })),
        },
      },
      script: {
        payload: { scenes },
        produced_by: { transformation: "dialogue_script_writer", version: "5" },
      },
      cast,
    } as never,
    ctx as never,
  );

  const payload = out.payload as { scenes: unknown[] };
  assert.equal(payload.scenes.length, 6);
});

test("dialogue_script_writer v5 scripts must return the central object in the payoff", async () => {
  const worker = makeCartoonSceneCompilerWorker();
  const scenes = [
    { scene_index: 0, point: "action=Host freezes with phone unlocked; prop=phone; function=opening_problem; value=recognize automatic checking", narration: "I checked it again.", speaker: "host", emotion: "surprised" },
    { scene_index: 1, point: "action=Buddy points at the phone; prop=phone; function=escalation; value=the cue is visible", narration: "It keeps happening.", speaker: "buddy", emotion: "neutral" },
    { scene_index: 2, point: "action=Host tries a one minute challenge; prop=none; function=failed_attempt; value=make the habit testable", narration: "One minute. Easy.", speaker: "host", emotion: "neutral" },
    { scene_index: 3, point: "action=Buddy explains while pointing at a chart; prop=none; function=midpoint_turn; value=variable rewards explain the pull", narration: "The reward is unpredictable.", speaker: "buddy", emotion: "neutral" },
    { scene_index: 4, point: "action=Host walks to the kitchen; prop=kettle; function=payoff_resolution practical_action; value=changed behavior", narration: "Tea instead.", speaker: "host", emotion: "happy" },
  ];

  await assert.rejects(
    () => worker.execute(
      {
        plan: { payload: { scenes: scenes.map((scene) => directedScene(scene.scene_index, { visual_event: "reaction-pop" })) } },
        script: {
          payload: { scenes },
          produced_by: { transformation: "dialogue_script_writer", version: "5" },
        },
        cast,
      } as never,
      ctx as never,
    ),
    /action quality gate failed: score/,
  );
});
