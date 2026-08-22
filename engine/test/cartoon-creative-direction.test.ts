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

function scriptScenes() {
  return [
    {
      scene_index: 0,
      point: "action=Host freezes with phone already unlocked; prop=phone; function=opening_problem engagement; value=viewer recognizes automatic checking",
      narration: "Wait. Why is it open?",
      speaker: "host",
      emotion: "surprised",
    },
    {
      scene_index: 1,
      point: "action=Buddy points at the phone; prop=phone; function=failed_attempt joke; value=the habit gets caught in the room",
      narration: "You said one minute.",
      speaker: "buddy",
      emotion: "neutral",
    },
    {
      scene_index: 2,
      point: "action=Phone lights up on the table; prop=phone; function=midpoint_turn engagement; value=the cue becomes visible",
      narration: "It lit up first.",
      speaker: "host",
      emotion: "scared",
    },
    {
      scene_index: 3,
      point: "action=Buddy slides the phone away; prop=phone; function=practical_action visual_gag; value=remove the cue before willpower is needed",
      narration: "Then move the bait.",
      speaker: "buddy",
      emotion: "skeptical",
    },
    {
      scene_index: 4,
      point: "action=Host reaches for the empty spot; prop=phone; function=escalation; value=automatic reach becomes visible",
      narration: "Nope. Hand went rogue.",
      speaker: "host",
      emotion: "annoyed",
    },
    {
      scene_index: 5,
      point: "action=Host grabs the kettle instead; prop=phone; function=payoff_resolution practical_action callback; value=changed behavior resolves the opening",
      narration: "Fine. Kettle wins.",
      speaker: "host",
      emotion: "happy",
    },
  ];
}

function directedScene(scene_index: number) {
  return {
    scene_index,
    template_category: "cartoon",
    background_location: "living-room",
    background_variant: "day",
    background_tone: "neutral",
    framing: "two-shot",
    camera_motion: "static",
    listener_actor_id: scene_index === 1 || scene_index === 3 ? "host" : "buddy",
    speaker_emotion: "neutral",
    speaker_gesture: "idle",
    speaker_gaze_target: "auto",
    listener_emotion: "skeptical",
    listener_gesture: "idle",
    listener_gaze_target: "auto",
    visual_event: "screen-change",
    ambient_motion: "subtle-parallax",
    speaker_emphasis: "scale-pop",
    cutaway_label: "",
    primary_prop: "phone",
    prop_state: "phone-visible",
    prop_motion: "none",
    foreground_action: "Phone sits on the table",
  };
}

function creativeDirection(overrides: Record<string, unknown> = {}) {
  return {
    character_roles: [
      {
        character_id: "host",
        comic_role: "impulsive self-aware person already inside the mistake",
        voice_markers: ["Wait", "Nope", "Fine"],
        reaction_pattern: "admits the mistake before trying to dodge it",
      },
      {
        character_id: "buddy",
        comic_role: "dry observer who makes the practical correction",
        voice_markers: ["You said", "Then move"],
        reaction_pattern: "points at the object and lets the correction land",
      },
    ],
    callback: {
      seed: "one minute",
      escalation: "the phone becomes bait",
      payoff: "KETTLE WINS",
    },
    scenes: scriptScenes().map((scene) => ({
      scene_index: scene.scene_index,
      scene_function: scene.scene_index === 0 ? "opening_problem" : scene.scene_index === 5 ? "payoff_resolution" : "habit_escalation",
      energy_beat: scene.scene_index === 0 ? "hook" : scene.scene_index === 5 ? "callback payoff" : "temptation",
      foreground_prop: {
        type: scene.scene_index === 2 ? "clock" : "phone",
        state: scene.scene_index === 2 ? "running-late" : "notification-badge",
        motion: scene.scene_index === 2 ? "pulse" : "glow",
        anchor: scene.scene_index === 2 ? "background" : "table",
        action: scene.scene_index === 2 ? "Clock interrupts the excuse" : "Phone stays visible as the temptation",
      },
      blocking: {
        speaker_position: "left",
        listener_position: "right",
        prop_position: scene.scene_index === 2 ? "background" : "table",
        power_shift: scene.scene_index === 2 ? "the room proves the excuse wrong" : "attention stays on the cue",
      },
      metaphor: {
        type: scene.scene_index === 2 ? "callback-card" : "none",
        label: scene.scene_index === 2 ? "THE BAIT BLINKS" : "",
        emotional_beat: scene.scene_index === 2 ? "caught by the cue" : "",
      },
      callback_role: scene.scene_index === 0 ? "seed" : scene.scene_index === 2 ? "escalation" : scene.scene_index === 5 ? "payoff" : "none",
      performance_note: scene.scene_index === 2 ? "Host looks betrayed by the room" : "Keep the exchange small and human",
    })),
    ...overrides,
  };
}

async function compile(creative = creativeDirection()) {
  const scenes = scriptScenes();
  const worker = makeCartoonSceneCompilerWorker();
  return worker.execute(
    {
      plan: { payload: { scenes: scenes.map((scene) => directedScene(scene.scene_index)) } },
      script: {
        payload: { scenes },
        produced_by: { transformation: "dialogue_script_writer", version: "6" },
      },
      cast,
      creative_direction: { payload: creative },
    } as never,
    ctx as never,
  );
}

test("creative_direction foreground props override visual plan props", async () => {
  const out = await compile();
  const payload = out.payload as { scenes: Array<{ scene_index: number; template_data: string }> };
  const scene = payload.scenes.find((entry) => entry.scene_index === 2)!;
  const compiled = JSON.parse(scene.template_data) as { visualEvent: { type: string; label?: string; foregroundProp?: { type: string; state: string; motion: string } }; creativeBlocking?: { power_shift: string }; creativeEnergyBeat?: string };

  assert.equal(compiled.visualEvent.foregroundProp?.type, "clock");
  assert.equal(compiled.visualEvent.foregroundProp?.state, "running-late");
  assert.equal(compiled.visualEvent.type, "callback-card");
  assert.equal(compiled.visualEvent.label, "THE BAIT BLINKS");
  assert.equal(compiled.creativeBlocking?.power_shift, "the room proves the excuse wrong");
  assert.equal(compiled.creativeEnergyBeat, "temptation");
});

test("creative_direction character voice gate rejects interchangeable roles", async () => {
  const bad = creativeDirection({
    character_roles: [
      {
        character_id: "host",
        comic_role: "generic explainer",
        voice_markers: ["interesting"],
        reaction_pattern: "explains the concept",
      },
      {
        character_id: "buddy",
        comic_role: "generic explainer",
        voice_markers: ["interesting"],
        reaction_pattern: "explains the concept",
      },
    ],
  });

  await assert.rejects(
    () => compile(bad),
    /character voice gate failed: active speakers must have distinct comic_role values/,
  );
});
