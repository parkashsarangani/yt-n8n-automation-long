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

test("compiler renders every background location the schema and prompt actually promise", async () => {
  // Real production failure: cartoon_visual_planner correctly staged a
  // background_location="hallway" crossing scene (schema-valid, and the
  // prompt's own doorway recipe requires it), but the compiler's BACKGROUNDS
  // lookup didn't have "hallway" as a key -- and five other locations the
  // schema/prompt also document (airport, bathroom, library, shop, studio)
  // were missing too. compileFromShallow silently fell back to a generic
  // synthesized scene for each one, collapsing distinct scenes into an
  // identical repeated key and triggering the repetitive-staging gate on
  // scenes that were never actually static in the first place.
  const worker = makeCartoonSceneCompilerWorker();
  const locations = ["airport", "bathroom", "hallway", "library", "shop", "studio"];
  const warnings: string[] = [];
  const capturingCtx = { logger: { log() {}, warn: (msg: string) => warnings.push(msg), error() {} } };

  const out = await worker.execute(
    {
      plan: {
        payload: {
          scenes: locations.map((location, scene_index) => directedScene(scene_index, {
            background_location: location,
            framing: ["establishing", "two-shot", "prop-insert", "reaction-closeup", "over-shoulder", "payoff-hold"][scene_index],
            camera_motion: ["static", "push-in", "pan-left", "pull-out", "reaction-push", "prop-focus"][scene_index],
            visual_event: scene_index === 0 ? "screen-change" : "none",
          })),
        },
      },
      script: {
        payload: {
          scenes: locations.map((_, scene_index) => ({
            scene_index,
            point: `beat-${scene_index}`,
            narration: `Line ${scene_index} moves the scene.`,
            speaker: scene_index % 2 === 0 ? "host" : "buddy",
            emotion: "neutral",
          })),
        },
        produced_by: { transformation: "dialogue_script_writer", version: "2" },
      },
      cast,
    } as never,
    capturingCtx as never,
  );

  assert.equal(warnings.filter((w) => w.includes("unknown background location")).length, 0, warnings.join("\n"));
  const payload = out.payload as { scenes: unknown[] };
  assert.equal(payload.scenes.length, locations.length);
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

test("dialogue_script_writer v5 scripts may close on a changed_behavior coda after the payoff scene", async () => {
  // Real production script: the writer added a short confirmation/habit coda
  // (function=payoff_confirmation, then function=changed_behavior) after the
  // actual payoff_resolution scene. The final-scene contract check only
  // recognized "payoff/resolve/resolution/..." and rejected this even though
  // it is a stronger close than a bare resolution line, per this pipeline's
  // own creative-direction guidance (behavioral closure over lesson summary).
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
      point: "action=Host reaches, notices, and grabs the kettle instead; prop=phone; function=payoff_resolution practical_action callback; value=replaces the cue with changed behavior",
      narration: "Kettle wins one.",
      speaker: "host",
      emotion: "happy",
    },
    {
      scene_index: 5,
      point: "action=Buddy watches Host fill the kettle instead; prop=kettle; function=payoff_confirmation; value=the goal is visibly completed",
      narration: "Look at that.",
      speaker: "buddy",
      emotion: "amused",
    },
    {
      scene_index: 6,
      point: "action=Host sets a note by the phone as a reminder; prop=phone; function=changed_behavior; value=the solution becomes a repeatable habit",
      narration: "Tomorrow too.",
      speaker: "host",
      emotion: "neutral",
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
  assert.equal(payload.scenes.length, 7);
});

test("dialogue_script_writer v5 scripts may open on a different object before settling on the central one", async () => {
  // Real production script: scenes 0-12 (opening third of 38) cycle through
  // fridge/couch/spoon while Host searches for the reason they're in the
  // kitchen; the story settles on "notepad" as its actual anchor object only
  // from scene 21 onward (middle + final thirds), which then carries the
  // payoff. That "confusion tour before settling" is the deliberate shape
  // of a forgetting/searching story, not an unfocused script -- the object
  // still has to anchor the middle and final thirds, just not the opening.
  const worker = makeCartoonSceneCompilerWorker();
  const scenes = [
    { scene_index: 0, point: "action=Host freezes beside the open fridge with empty hands; prop=fridge; function=opening_problem; value=viewer sees the memory fail happen physically", narration: "Wait, why am I here?", speaker: "host", emotion: "confused" },
    { scene_index: 1, point: "action=Buddy leans over the couch toward Host; prop=couch; function=escalation; value=the search becomes visible", narration: "You have been standing there a while.", speaker: "buddy", emotion: "neutral" },
    { scene_index: 2, point: "action=Host points back toward the living-room couch; prop=couch; function=failed_attempt; value=the wrong trail is followed", narration: "It was something on the couch, maybe.", speaker: "host", emotion: "neutral" },
    { scene_index: 3, point: "action=Buddy places the spoon beside a notepad on the coffee table; prop=notepad; function=hidden_mechanism; value=the real cue appears", narration: "This was on the table the whole time.", speaker: "buddy", emotion: "amused" },
    { scene_index: 4, point: "action=Host picks up the notepad and flips to a blank page; prop=notepad; function=midpoint_turn; value=the object becomes the plan", narration: "Right. This was the plan.", speaker: "host", emotion: "surprised" },
    { scene_index: 5, point: "action=Host writes the item on the notepad while seated; prop=notepad; function=practical_action viewer_value; value=commit the plan to the object", narration: "Write it down this time.", speaker: "host", emotion: "neutral" },
    { scene_index: 6, point: "action=Host grips the note and starts toward the kitchen; prop=notepad; function=practical_action; value=carry the cue across the room", narration: "Follow the note, not the memory.", speaker: "host", emotion: "neutral" },
    { scene_index: 7, point: "action=Host opens the fridge and reaches directly for the item on the note; prop=notepad; function=payoff_resolution practical_action callback; value=the note replaces the failed memory", narration: "There it is. First try.", speaker: "host", emotion: "happy" },
    { scene_index: 8, point: "action=Host places the item beside the notepad and writes a fresh reminder; prop=notepad; function=changed_behavior; value=the solution becomes a repeatable habit", narration: "Tomorrow too.", speaker: "host", emotion: "neutral" },
  ];

  const out = await worker.execute(
    {
      plan: {
        payload: {
          scenes: scenes.map((scene) => directedScene(scene.scene_index, {
            visual_event: scene.scene_index === 0 ? "screen-change" : "reaction-pop",
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
  assert.equal(payload.scenes.length, 9);
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

test("dialogue_script_writer v5 explanation-framed actions do not count as visible action", async () => {
  const worker = makeCartoonSceneCompilerWorker();
  const scenes = [
    { scene_index: 0, point: "action=Host holds the bill at the kitchen table; prop=bill; function=opening_problem; value=the confusing bill is visible", narration: "This bill grew teeth.", speaker: "host", emotion: "surprised" },
    { scene_index: 1, point: "action=Buddy explains while pointing at the bill; prop=bill; function=escalation; value=the fee is introduced", narration: "That fee is doing the humming.", speaker: "buddy", emotion: "neutral" },
    { scene_index: 2, point: "action=Host says the bill is confusing; prop=bill; function=midpoint_turn; value=names the misunderstanding", narration: "I still hate it.", speaker: "host", emotion: "angry" },
    { scene_index: 3, point: "action=Buddy summarizes the fee while pointing at the bill; prop=bill; function=practical_action viewer_value; value=read the line item before reacting", narration: "Read the boring line first.", speaker: "buddy", emotion: "neutral" },
    { scene_index: 4, point: "action=Host folds the bill and nods; prop=bill; function=payoff_resolution practical_action; value=return to the object with changed behavior", narration: "Fine. Teeth removed.", speaker: "host", emotion: "happy" },
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
    /2\/5 scenes have visible actions/,
  );
});
