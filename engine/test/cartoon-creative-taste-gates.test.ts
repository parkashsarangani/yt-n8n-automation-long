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
      point: "action=Host stares at the phone already open; prop=phone; function=opening_problem engagement; value=the automatic habit is visible immediately",
      narration: "Wait. Why is it open?",
      speaker: "host",
      emotion: "surprised",
    },
    {
      scene_index: 1,
      point: "action=Buddy points at the unlocked phone; prop=phone; function=denial joke; value=the excuse gets challenged by the object",
      narration: "You lasted four seconds.",
      speaker: "buddy",
      emotion: "skeptical",
    },
    {
      scene_index: 2,
      point: "action=The phone flashes a notification; prop=phone; function=hidden_mechanism visual_gag; value=the cue becomes the villain",
      narration: "It blinked at me.",
      speaker: "host",
      emotion: "annoyed",
    },
    {
      scene_index: 3,
      point: "action=Buddy turns the phone face down; prop=phone; function=practical_swap; value=changed behavior starts on screen",
      narration: "Turn it over.",
      speaker: "buddy",
      emotion: "neutral",
    },
    {
      scene_index: 4,
      point: "action=Host reaches toward the empty phone spot; prop=phone; function=relapse_escalation visual_gag; value=the automatic reach is visible",
      narration: "My hand still went for it.",
      speaker: "host",
      emotion: "confused",
    },
    {
      scene_index: 5,
      point: "action=Host grabs the kettle instead of the phone; prop=phone; function=callback_payoff practical_action; value=the opening habit resolves as a changed behavior",
      narration: "Fine. Kettle gets the counter.",
      speaker: "host",
      emotion: "happy",
    },
  ];
}

function directedScene(scene_index: number) {
  const states = ["phone-unlocked", "phone-visible", "notification-badge", "face-down", "across-room", "phone-away"];
  const motions = ["glow", "none", "pulse", "close", "slide-away", "none"];
  return {
    scene_index,
    template_category: "cartoon",
    background_location: "living-room",
    background_variant: "day",
    background_tone: "neutral",
    framing: "two-shot",
    camera_motion: scene_index === 2 ? "push-in" : "static",
    listener_actor_id: scene_index === 1 || scene_index === 3 ? "host" : "buddy",
    speaker_emotion: scene_index === 0 ? "surprised" : "neutral",
    speaker_gesture: scene_index === 3 ? "point-left" : "idle",
    speaker_gaze_target: "auto",
    listener_emotion: "skeptical",
    listener_gesture: "idle",
    listener_gaze_target: "auto",
    visual_event: scene_index === 2 ? "reaction-pop" : scene_index === 5 ? "callback-card" : "screen-change",
    ambient_motion: "subtle-parallax",
    speaker_emphasis: "scale-pop",
    cutaway_label: scene_index === 2 ? "THE BAIT BLINKS" : scene_index === 5 ? "KETTLE GETS THE COUNTER" : "",
    primary_prop: "phone",
    prop_state: states[scene_index],
    prop_motion: motions[scene_index],
    foreground_action: "Phone remains the visible cue",
  };
}

function strongCreativeDirection() {
  return {
    character_roles: [
      {
        character_id: "host",
        comic_role: "impulsive self-aware person already inside the mistake",
        voice_markers: ["Wait", "It blinked", "Fine"],
        reaction_pattern: "admits the mistake, blames the object, then redirects the hand",
      },
      {
        character_id: "buddy",
        comic_role: "dry observer who moves the practical fix closer",
        voice_markers: ["You lasted", "Turn it over"],
        reaction_pattern: "points at the cue and gives one blunt action instead of a lecture",
      },
    ],
    callback: {
      seed: "the phone is already open",
      escalation: "the bait blinks before Host decides",
      payoff: "the kettle gets the counter instead",
    },
    scenes: scriptScenes().map((scene) => {
      const sceneFunctions = ["opening_problem", "denial", "hidden_mechanism", "practical_swap", "relapse_escalation", "callback_payoff"];
      const energyBeats = ["hook", "dry correction", "visual proof", "practical correction", "relapse gag", "callback payoff"];
      const states = ["phone-unlocked", "phone-visible", "notification-badge", "face-down", "across-room", "phone-away"];
      const motions = ["glow", "none", "pulse", "close", "slide-away", "none"];
      const propPositions = ["foreground-right", "table", "foreground-center", "hand", "foreground-left", "table"];
      const speakerPositions = ["left", "right", "center", "center", "left", "right"];
      const listenerPositions = ["right", "left", "right", "left", "right", "left"];
      const powerShifts = [
        "the unlocked phone owns the first look",
        "Buddy catches the excuse before it grows",
        "the blinking cue wins attention for a beat",
        "Buddy takes control by turning the object over",
        "the habit pulls Host back toward the empty spot",
        "Host gives the counter to the kettle instead",
      ];
      const performance = [
        "Host notices the open screen before trying to explain it away.",
        "Buddy should sound dry, like the four seconds were generous.",
        "Host looks personally betrayed by one tiny notification blink.",
        "Buddy moves slowly so the fix feels embarrassingly obvious.",
        "Host reaches before realizing the hand moved without permission.",
        "Host concedes quietly and redirects the hand to the kettle.",
      ];
      return {
        scene_index: scene.scene_index,
        scene_function: sceneFunctions[scene.scene_index],
        energy_beat: energyBeats[scene.scene_index],
        foreground_prop: {
          type: "phone",
          state: states[scene.scene_index],
          motion: motions[scene.scene_index],
          anchor: "table",
          action: powerShifts[scene.scene_index],
        },
        blocking: {
          speaker_position: speakerPositions[scene.scene_index],
          listener_position: listenerPositions[scene.scene_index],
          prop_position: propPositions[scene.scene_index],
          power_shift: powerShifts[scene.scene_index],
        },
        metaphor: {
          type: scene.scene_index === 2 ? "reaction-pop" : scene.scene_index === 5 ? "callback-card" : "none",
          label: scene.scene_index === 2 ? "THE BAIT BLINKS" : scene.scene_index === 5 ? "KETTLE GETS THE COUNTER" : "",
          emotional_beat: scene.scene_index === 2 ? "the cue beats intention" : scene.scene_index === 5 ? "changed behavior closes the loop" : "watching the cue move attention",
        },
        callback_role: scene.scene_index === 0 ? "seed" : scene.scene_index === 2 ? "escalation" : scene.scene_index === 5 ? "payoff" : "none",
        performance_note: performance[scene.scene_index],
      };
    }),
  };
}

function cloneCreative() {
  return JSON.parse(JSON.stringify(strongCreativeDirection())) as ReturnType<typeof strongCreativeDirection>;
}

async function compile(creative = strongCreativeDirection()) {
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

test("creative taste gates accept strong direction and apply blocking to render metadata", async () => {
  const out = await compile();
  const payload = out.payload as { scenes: Array<{ scene_index: number; template_data: string }> };
  const scene = payload.scenes.find((entry) => entry.scene_index === 3)!;
  const compiled = JSON.parse(scene.template_data) as {
    characters: Array<{ isSpeaking?: boolean; x?: number }>;
    visualEvent?: { foregroundProp?: { anchor?: string } };
    creativeTasteGate?: { version?: string; powerShift?: string };
  };
  const speaker = compiled.characters.find((character) => character.isSpeaking);

  assert.equal(compiled.creativeTasteGate?.version, "12");
  assert.equal(compiled.creativeTasteGate?.powerShift, "Buddy takes control by turning the object over");
  assert.equal(speaker?.x, 690);
  assert.equal(compiled.visualEvent?.foregroundProp?.anchor, "hand");
});

test("creative taste gate rejects missing callback escalation", async () => {
  const creative = cloneCreative();
  creative.scenes[2]!.callback_role = "none";

  await assert.rejects(
    () => compile(creative),
    /callback gate failed: scenes must mark seed, escalation, and payoff roles/,
  );
});

test("creative taste gate rejects generic metaphor labels", async () => {
  const creative = cloneCreative();
  creative.scenes[2]!.metaphor.label = "CALLBACK";

  await assert.rejects(
    () => compile(creative),
    /metaphor gate failed: scene 2 uses a generic metaphor label/,
  );
});

test("creative taste gate rejects flat rhythm and blocking", async () => {
  const creative = cloneCreative();
  for (const scene of creative.scenes) {
    scene.scene_function = "middle_explanation";
    scene.energy_beat = "same explanation";
    scene.blocking = {
      speaker_position: "left",
      listener_position: "right",
      prop_position: "table",
      power_shift: "they talk",
    };
  }

  await assert.rejects(
    () => compile(creative),
    /rhythm gate failed: three consecutive scenes cannot share the same scene_function/,
  );
});
