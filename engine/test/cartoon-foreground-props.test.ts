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
    primary_prop: "none",
    prop_state: "none",
    prop_motion: "none",
    foreground_action: "none",
    ...overrides,
  };
}

function phoneScenes() {
  return [
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
}

test("v5 scripts compile foreground phone props into renderable visual events", async () => {
  const worker = makeCartoonSceneCompilerWorker();
  const scenes = phoneScenes();
  const out = await worker.execute(
    {
      plan: {
        payload: {
          scenes: scenes.map((scene) => directedScene(scene.scene_index, {
            visual_event: scene.scene_index === 0 || scene.scene_index === 3 ? "screen-change" : "reaction-pop",
            primary_prop: "phone",
            prop_state: scene.scene_index === 0 ? "phone-unlocked" : scene.scene_index === 3 ? "notification-badge" : scene.scene_index === 5 ? "across-room" : "phone-visible",
            prop_motion: scene.scene_index === 3 ? "pulse" : scene.scene_index === 4 ? "slide-away" : "none",
            foreground_action: scene.point,
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

  const payload = out.payload as { scenes: Array<{ template_data: string }> };
  const compiled = payload.scenes.map((scene) => JSON.parse(scene.template_data));
  assert.equal(compiled[0].visualEvent.foregroundProp.type, "phone");
  assert.equal(compiled[0].visualEvent.foregroundProp.state, "phone-unlocked");
  assert.equal(compiled[3].visualEvent.foregroundProp.state, "notification-badge");
  assert.equal(compiled[5].visualEvent.foregroundProp.type, "phone");
});

test("v5 foreground prop gate fails if the compiled central object is absent from a third", async () => {
  const worker = makeCartoonSceneCompilerWorker();
  const scenes = phoneScenes();
  const planScenes = scenes.map((scene) => directedScene(scene.scene_index, {
    primary_prop: scene.scene_index < 4 ? "phone" : "none",
    prop_state: scene.scene_index < 4 ? "phone-visible" : "none",
    visual_event: "reaction-pop",
  }));

  await assert.rejects(
    () => worker.execute(
      {
        plan: { payload: { scenes: planScenes } },
        script: {
          payload: { scenes },
          produced_by: { transformation: "dialogue_script_writer", version: "5" },
        },
        cast,
      } as never,
      ctx as never,
    ),
    /foreground prop gate failed: central object "phone" must render as a foreground prop/,
  );
});

test("v5 runtime density gate rejects long low-density explainers", async () => {
  const worker = makeCartoonSceneCompilerWorker();
  const scenes = Array.from({ length: 18 }, (_, scene_index) => ({
    scene_index,
    point: `action=Host holds the phone during beat ${scene_index}; prop=phone; function=${scene_index === 0 ? "opening_problem" : scene_index === 17 ? "payoff_resolution practical_action" : scene_index === 9 ? "midpoint_turn" : "escalation"}; value=visible phone habit beat ${scene_index}`,
    narration: "This deliberately long narration line keeps talking about the phone habit and variable rewards without adding enough visual density for a long episode.",
    speaker: scene_index % 2 === 0 ? "host" : "buddy",
    emotion: "neutral",
  }));

  await assert.rejects(
    () => worker.execute(
      {
        plan: { payload: { scenes: scenes.map((scene) => directedScene(scene.scene_index, { primary_prop: "phone", prop_state: "phone-visible", visual_event: "reaction-pop" })) } },
        script: {
          payload: { scenes },
          produced_by: { transformation: "dialogue_script_writer", version: "5" },
        },
        cast,
      } as never,
      ctx as never,
    ),
    /runtime density gate failed/,
  );
});
