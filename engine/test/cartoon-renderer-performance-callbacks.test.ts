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
      point: "action=Buddy turns the glowing appliance away; prop=appliance; function=practical_swap; value=the visible cue moves out of the way",
      narration: "Move the glow.",
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
      point: "action=Host carries the laptop downstairs to the kitchen counter; prop=laptop; function=callback_payoff practical_action; value=the opening habit resolves as changed behavior",
      narration: "Fine. Laptop stays downstairs.",
      speaker: "host",
      emotion: "happy",
    },
  ];
}

function directedScene(scene_index: number) {
  const states = ["phone-unlocked", "phone-visible", "notification-badge", "blue-screen-glow", "across-room", "closed-downstairs"];
  const motions = ["glow", "none", "pulse", "glow", "slide-away", "none"];
  const locations = ["living-room", "living-room", "living-room", "living-room", "living-room", "bedroom"];
  const variants = ["day", "day", "day", "day", "day", "night"];
  return {
    scene_index,
    template_category: "cartoon",
    background_location: locations[scene_index],
    background_variant: variants[scene_index],
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
    visual_event: scene_index === 2 ? "reaction-pop" : scene_index === 5 ? "callback-card" : scene_index === 3 ? "thought-bubble" : "screen-change",
    ambient_motion: "subtle-parallax",
    speaker_emphasis: "scale-pop",
    cutaway_label: scene_index === 2 ? "THE BAIT BLINKS" : scene_index === 5 ? "LAPTOP STAYS DOWNSTAIRS" : scene_index === 3 ? "THE GLOW THAT WON'T QUIT" : "",
    primary_prop: scene_index === 3 ? "appliance" : scene_index === 5 ? "laptop" : "phone",
    prop_state: states[scene_index],
    prop_motion: motions[scene_index],
    foreground_action: scene_index === 5 ? "Laptop is carried downstairs and left on the kitchen counter" : "Prop remains the visible cue",
  };
}

function creativeDirection() {
  const sceneFunctions = ["opening_problem", "denial", "hidden_mechanism", "practical_swap", "relapse_escalation", "callback_payoff"];
  const energyBeats = ["hook", "dry correction", "visual proof", "practical correction", "relapse gag", "callback payoff"];
  const types = ["phone", "phone", "phone", "appliance", "phone", "laptop"];
  const states = ["phone-unlocked", "phone-visible", "notification-badge", "blue-screen-glow", "across-room", "closed-downstairs"];
  const motions = ["glow", "none", "pulse", "glow", "slide-away", "none"];
  const propPositions = ["foreground-right", "table", "foreground-center", "hand", "foreground-left", "table"];
  const speakerPositions = ["left", "right", "center", "center", "left", "right"];
  const listenerPositions = ["right", "left", "right", "left", "right", "left"];
  const powerShifts = [
    "the unlocked phone owns the first look",
    "Buddy catches the excuse before it grows",
    "the blinking cue wins attention for a beat",
    "the glowing appliance is moved away from the bed",
    "the habit pulls Host back toward the empty spot",
    "Host carries the laptop downstairs to the kitchen counter",
  ];
  const performance = [
    "Host notices the open screen before trying to explain it away.",
    "Buddy should sound dry, like the four seconds were generous.",
    "Host looks personally betrayed by one tiny notification blink.",
    "Buddy moves slowly so the fix feels embarrassingly obvious.",
    "Host reaches before realizing the hand moved without permission.",
    "Host concedes quietly and redirects the laptop downstairs.",
  ];

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
        voice_markers: ["You lasted", "Move the glow"],
        reaction_pattern: "points at the cue and gives one blunt action instead of a lecture",
      },
    ],
    callback: {
      seed: "the phone is already open",
      escalation: "the bait blinks before Host decides",
      payoff: "the laptop stays downstairs",
    },
    scenes: scriptScenes().map((scene) => ({
      scene_index: scene.scene_index,
      scene_function: sceneFunctions[scene.scene_index],
      energy_beat: energyBeats[scene.scene_index],
      foreground_prop: {
        type: types[scene.scene_index],
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
        type: scene.scene_index === 2 ? "reaction-pop" : scene.scene_index === 3 ? "thought-bubble" : scene.scene_index === 5 ? "callback-card" : "none",
        label: scene.scene_index === 2 ? "THE BAIT BLINKS" : scene.scene_index === 3 ? "THE GLOW THAT WON'T QUIT" : scene.scene_index === 5 ? "LAPTOP STAYS DOWNSTAIRS" : "",
        emotional_beat: scene.scene_index === 2 ? "the cue beats intention" : scene.scene_index === 3 ? "the culprit lights up literally" : scene.scene_index === 5 ? "changed behavior closes the loop" : "watching the cue move attention",
      },
      callback_role: scene.scene_index === 0 ? "seed" : scene.scene_index === 2 ? "escalation" : scene.scene_index === 5 ? "payoff" : "none",
      performance_note: performance[scene.scene_index],
    })),
  };
}

async function compile() {
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
      creative_direction: { payload: creativeDirection() },
    } as never,
    ctx as never,
  );
}

function primaryOverlayCount(event: { type?: string; callbackEcho?: unknown; metaphorVisual?: unknown }): number {
  return Number(Boolean(event.callbackEcho))
    + Number(Boolean(event.metaphorVisual))
    + Number(event.type === "callback-card");
}

test("compiler v13 emits sanitized renderer overlays without raw production notes", async () => {
  const out = await compile();
  const payload = out.payload as { scenes: Array<{ scene_index: number; template_data: string }> };
  const scene = (index: number) => JSON.parse(payload.scenes.find((entry) => entry.scene_index === index)!.template_data) as {
    background?: { location?: string; variant?: string };
    visualEvent?: {
      type?: string;
      label?: string;
      callbackEcho?: { role?: string; text?: string; intensity?: string };
      metaphorVisual?: { label?: string; emotionalBeat?: string; propType?: string };
      performanceCue?: { type?: string; label?: string };
    };
    rendererPerformance?: { version?: string; cue?: string; callbackRole?: string };
  };

  const seed = scene(0);
  const deadpan = scene(1);
  const escalation = scene(2);
  const metaphor = scene(3);
  const payoff = scene(5);

  assert.equal(seed.visualEvent?.callbackEcho?.role, "seed");
  assert.equal(seed.visualEvent?.callbackEcho?.text, "the phone is already open");
  assert.equal(seed.visualEvent?.performanceCue, undefined);
  assert.equal(seed.rendererPerformance?.version, "13");
  assert.equal(seed.rendererPerformance?.cue, "notice");
  assert.equal(primaryOverlayCount(seed.visualEvent ?? {}), 1);

  assert.equal(deadpan.visualEvent?.performanceCue?.type, "deadpan");
  assert.equal(deadpan.visualEvent?.performanceCue?.label, "DEADPAN");
  assert.ok(!JSON.stringify(deadpan.visualEvent).includes("four seconds were generous"));

  assert.equal(escalation.visualEvent?.callbackEcho?.role, "escalation");
  assert.equal(escalation.visualEvent?.metaphorVisual, undefined);
  assert.equal(escalation.visualEvent?.performanceCue, undefined);
  assert.equal(escalation.rendererPerformance?.cue, "recoil");
  assert.equal(primaryOverlayCount(escalation.visualEvent ?? {}), 1);

  assert.equal(metaphor.visualEvent?.type, "none");
  assert.equal(metaphor.visualEvent?.metaphorVisual?.label, "THE GLOW THAT WON'T QUIT");
  assert.equal(metaphor.visualEvent?.metaphorVisual?.emotionalBeat, "the culprit lights up literally");
  assert.equal(metaphor.visualEvent?.metaphorVisual?.propType, "visual beat");
  assert.equal(metaphor.visualEvent?.performanceCue, undefined);
  assert.equal(primaryOverlayCount(metaphor.visualEvent ?? {}), 1);

  assert.equal(payoff.visualEvent?.type, "callback-card");
  assert.equal(payoff.visualEvent?.label, "LAPTOP STAYS DOWNSTAIRS");
  assert.equal(payoff.visualEvent?.callbackEcho, undefined);
  assert.equal(payoff.visualEvent?.performanceCue, undefined);
  assert.equal(payoff.background?.location, "kitchen");
  assert.equal(payoff.background?.variant, "day");
  assert.equal(payoff.rendererPerformance?.cue, "reluctant-acceptance");
  assert.equal(payoff.rendererPerformance?.callbackRole, "payoff");
  assert.equal(primaryOverlayCount(payoff.visualEvent ?? {}), 1);
});
