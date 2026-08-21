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
