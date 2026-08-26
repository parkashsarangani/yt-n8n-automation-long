import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyRendererStaging } from "../src/workers/cartoon-scenes-v14.ts";

const v14Source = readFileSync(new URL("../src/workers/cartoon-scenes-v14.ts", import.meta.url), "utf8");
const v15Source = readFileSync(new URL("../src/workers/cartoon-scenes-v15.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/workers/index.ts", import.meta.url), "utf8");

test("production cartoon compiler routes through v14/v15 cinematic set-piece staging", () => {
  assert.match(indexSource, /cartoon-scenes-v15\.ts/);
  assert.match(indexSource, /makeV15CartoonSceneCompilerWorker/);
  assert.match(v15Source, /cartoon-scenes-v14\.ts/);
  assert.match(v15Source, /makeV14CartoonSceneCompilerWorker/);
  assert.match(v15Source, /version:\s*"16"/);
  assert.match(v14Source, /version:\s*"15"/);
});

test("large props still use a generic background set-piece policy", () => {
  assert.match(v14Source, /type SetPieceKind =/);
  assert.match(v14Source, /setPieceKindFromProp/);
  assert.match(v14Source, /setPieceSpecForScene/);
  assert.match(v14Source, /delete visualEvent\.foregroundProp/);
  assert.match(v14Source, /setPieceStaging:\s*setPiece \? "background"/);
  for (const kind of ["doorway", "window", "bed", "locker", "vehicle"]) {
    assert.match(v14Source, new RegExp(`"${kind}"`));
  }
});

test("doorway crossing scenes render as cinematic crossing transitions", () => {
  const entries = [0, 1, 2, 3].map((sceneIndex) => ({
    scene_index: sceneIndex,
    source: "template" as const,
    template_category: "cartoon" as const,
    template_data: JSON.stringify({
      background: { location: "living-room", variant: "day", tone: "neutral" },
      shotType: "medium",
      visualEvent: {
        type: "prop-tremble",
        foregroundProp: { type: "door", state: "open", motion: "tremble", anchor: "foreground" },
      },
    }),
  }));

  const creative = {
    character_roles: [],
    callback: { seed: "door cue", escalation: "door cue again", payoff: "door cue lands" },
    scenes: [0, 1, 2, 3].map((sceneIndex) => ({
      scene_index: sceneIndex,
      scene_function: sceneIndex === 0 ? "opening_problem" : sceneIndex === 3 ? "payoff_resolution" : "escalation",
      energy_beat: "Host walks through the doorway and the room changes",
      foreground_prop: { type: "door", state: "open doorway", motion: "open", anchor: "foreground", action: "Host crosses through the doorway" },
      blocking: { speaker_position: "left", listener_position: "right", prop_position: "foreground", power_shift: "the doorway changes the room cue" },
      metaphor: { type: "none", label: "", emotional_beat: "doorway memory cue" },
      callback_role: sceneIndex === 0 ? "seed" as const : sceneIndex === 3 ? "payoff" as const : "none" as const,
      performance_note: "Treat the door as a background transition, not a carried prop",
    })),
  };

  const staged = applyRendererStaging(entries, creative);
  const compiled = staged.map((entry) => JSON.parse(entry.template_data) as Record<string, any>);

  for (const scene of compiled) {
    assert.equal(scene.visualEvent.foregroundProp, undefined, "door must not survive as a foreground overlay");
    assert.equal(scene.background.setPiece.kind, "doorway");
    assert.equal(scene.background.setPiece.motion, "cross");
    assert.equal(scene.rendererPerformance.setPieceStaging, "background");
    assert.equal(scene.rendererPerformance.setPieceKind, "doorway");
    assert.equal(scene.rendererPerformance.visibleCentralObject, "doorway-set-piece");
    assert.equal(scene.shotType, "doorway-transition");
    assert.equal(scene.cinematic.shotRecipe, "crossing-transition");
    assert.equal(scene.cinematic.transition, "doorway-slide");
    assert.equal(scene.cinematic.propPlacement, "background-set-piece");
  }
});

test("ordinary props become physical cinematic foreground objects", () => {
  const entries = [0].map((sceneIndex) => ({
    scene_index: sceneIndex,
    source: "template" as const,
    template_category: "cartoon" as const,
    template_data: JSON.stringify({
      background: { location: "living-room", variant: "day", tone: "neutral" },
      shotType: "medium",
      visualEvent: { type: "none" },
    }),
  }));
  const creative = {
    character_roles: [],
    callback: { seed: "", escalation: "", payoff: "" },
    scenes: [{
      scene_index: 0,
      scene_function: "opening_problem",
      energy_beat: "Host realizes the charger is missing",
      foreground_prop: { type: "charger", state: "missing cue", motion: "settle", anchor: "hand", action: "Host grabs the charger" },
      blocking: { speaker_position: "left", listener_position: "right", prop_position: "hand", power_shift: "object matters" },
      metaphor: { type: "none", label: "", emotional_beat: "object cue" },
      callback_role: "seed" as const,
      performance_note: "Show the object physically, not as a badge",
    }],
  };

  const [staged] = applyRendererStaging(entries, creative);
  assert.ok(staged);
  const compiled = JSON.parse(staged.template_data) as Record<string, any>;
  assert.equal(compiled.visualEvent.foregroundProp.type, "charger");
  assert.equal(compiled.visualEvent.foregroundProp.renderMode, "physical");
  assert.equal(compiled.cinematic.propMode, "physical");
  assert.equal(compiled.rendererPerformance.qualityTarget, "cinematic-9-5");
});

test("non-door set pieces are dynamic per prop kind", () => {
  const props = ["window", "bed", "locker", "vehicle"];
  const entries = props.map((prop, sceneIndex) => ({
    scene_index: sceneIndex,
    source: "template" as const,
    template_category: "cartoon" as const,
    template_data: JSON.stringify({
      background: { location: "living-room", variant: "day", tone: "neutral" },
      shotType: "medium",
      visualEvent: { type: "prop-tremble", foregroundProp: { type: prop, state: prop === "locker" ? "glow" : "visible", motion: "tremble", anchor: "foreground" } },
    }),
  }));

  const creative = {
    character_roles: [],
    callback: { seed: "", escalation: "", payoff: "" },
    scenes: props.map((prop, sceneIndex) => ({
      scene_index: sceneIndex,
      scene_function: "visual beat",
      energy_beat: `${prop} becomes the central set piece`,
      foreground_prop: { type: prop, state: "visible", motion: "none", anchor: "foreground", action: `${prop} fills the set` },
      blocking: { speaker_position: "left", listener_position: "right", prop_position: "foreground", power_shift: "object owns the frame" },
      metaphor: { type: "none", label: "", emotional_beat: "set-piece object" },
      callback_role: "none" as const,
      performance_note: "Keep the large object behind the characters",
    })),
  };

  const staged = applyRendererStaging(entries, creative);
  const compiled = staged.map((entry) => JSON.parse(entry.template_data) as Record<string, any>);

  assert.deepEqual(compiled.map((scene) => scene.background.setPiece.kind), props);
  assert.ok(compiled.every((scene) => scene.visualEvent.foregroundProp === undefined));
  assert.ok(compiled.every((scene) => scene.rendererPerformance.setPieceStaging === "background"));
});

test("doorway compiler source contains explicit continuity and cinematic concepts", () => {
  for (const token of [
    "isDoorwayTopic",
    "sceneRoleFor",
    "spatialEnvironmentFor",
    "cinematicSpecForScene",
    "ShotRecipe",
    "propPlacementForScene",
    "qualityTarget: \"cinematic-9-5\"",
  ]) {
    assert.match(v14Source, new RegExp(token));
  }
  assert.match(v14Source, /"living-room"/);
  assert.match(v14Source, /"hallway"/);
  assert.match(v14Source, /"kitchen"/);
  assert.match(v14Source, /"doorway-transition"/);
});
