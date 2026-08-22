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

const creativeSceneFunctions = [
  "opening_problem",
  "failed_attempt",
  "cue_mechanism",
  "practical_swap",
  "automatic_reach",
  "payoff_resolution",
];
const creativeEnergyBeats = [
  "hook",
  "self-own",
  "temptation",
  "practical turn",
  "relapse beat",
  "callback payoff",
];
const creativeBlocking = [
  { speaker_position: "left", listener_position: "right", prop_position: "table", power_shift: "the phone wins the first look before anyone explains it" },
  { speaker_position: "right", listener_position: "left", prop_position: "foreground-center", power_shift: "Buddy catches the rule breaking in real time" },
  { speaker_position: "center", listener_position: "right", prop_position: "background", power_shift: "the room exposes the cue before Host can defend it" },
  { speaker_position: "right", listener_position: "left", prop_position: "foreground-right", power_shift: "Buddy moves the bait out of easy reach" },
  { speaker_position: "left", listener_position: "right", prop_position: "foreground-left", power_shift: "Host's hand betrays the plan before Host does" },
  { speaker_position: "center", listener_position: "right", prop_position: "table", power_shift: "the kettle replaces the phone as the new action" },
];
const creativeForegroundProps = [
  { type: "phone", state: "phone-unlocked", motion: "glow", anchor: "table", action: "Phone is already open before Host remembers touching it" },
  { type: "phone", state: "one-minute-timer", motion: "pulse", anchor: "foreground", action: "Phone proves the one-minute promise is already broken" },
  { type: "clock", state: "running-late", motion: "pulse", anchor: "background", action: "Clock interrupts the excuse from behind the phone" },
  { type: "phone", state: "across-room", motion: "slide-away", anchor: "right", action: "Buddy slides the phone out of reach" },
  { type: "phone", state: "empty-spot", motion: "tremble", anchor: "left", action: "Host reaches where the phone used to be" },
  { type: "kettle", state: "kettle-wins", motion: "bounce", anchor: "table", action: "Host grabs the kettle instead of the phone" },
];
const creativeMetaphors = [
  { type: "none", label: "", emotional_beat: "" },
  { type: "none", label: "", emotional_beat: "" },
  { type: "callback-card", label: "THE BAIT BLINKS", emotional_beat: "caught by the cue" },
  { type: "none", label: "", emotional_beat: "" },
  { type: "reaction-pop", label: "HAND WENT ROGUE", emotional_beat: "the habit moves before the person chooses" },
  { type: "callback-card", label: "KETTLE WINS", emotional_beat: "the replacement action closes the loop" },
];
const creativePerformanceNotes = [
  "Host should notice the unlocked phone before saying anything clever",
  "Buddy points once, then lets the accusation sit",
  "Host looks betrayed by the blinking cue, not educated by it",
  "Buddy makes the slide-away motion small and practical",
  "Host catches their own hand mid-reach and looks offended",
  "Host accepts the kettle like a tiny defeat that actually works",
];

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
      scene_function: creativeSceneFunctions[scene.scene_index]!,
      energy_beat: creativeEnergyBeats[scene.scene_index]!,
      foreground_prop: creativeForegroundProps[scene.scene_index]!,
      blocking: creativeBlocking[scene.scene_index]!,
      metaphor: creativeMetaphors[scene.scene_index]!,
      callback_role: scene.scene_index === 0 ? "seed" : scene.scene_index === 2 ? "escalation" : scene.scene_index === 5 ? "payoff" : "none",
      performance_note: creativePerformanceNotes[scene.scene_index]!,
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
  assert.equal(compiled.creativeBlocking?.power_shift, "the room exposes the cue before Host can defend it");
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
