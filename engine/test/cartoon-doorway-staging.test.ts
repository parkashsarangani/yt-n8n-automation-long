import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyRendererStaging } from "../src/workers/cartoon-scenes-v14.ts";

const v14Source = readFileSync(new URL("../src/workers/cartoon-scenes-v14.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/workers/index.ts", import.meta.url), "utf8");

test("production cartoon compiler routes through v14 doorway staging", () => {
  assert.match(indexSource, /cartoon-scenes-v14\.ts/);
  assert.match(indexSource, /makeV14CartoonSceneCompilerWorker/);
  assert.doesNotMatch(indexSource, /makeV13CartoonSceneCompilerWorker/);
});

test("door props are removed from foreground overlays and converted to environment staging", () => {
  assert.match(v14Source, /isDoorProp/);
  assert.match(v14Source, /delete visualEvent\.foregroundProp/);
  assert.match(v14Source, /ambientMotion:\s*"doorway-cross"/);
  assert.match(v14Source, /doorwayStaging:\s*"environment"/);
});

test("door-dominant episodes preserve central-object coverage as rendered doorway set pieces", () => {
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
      foreground_prop: {
        type: "door",
        state: "open doorway",
        motion: "open",
        anchor: "foreground",
        action: "Host crosses through the doorway",
      },
      blocking: {
        speaker_position: "left",
        listener_position: "right",
        prop_position: "foreground",
        power_shift: "the doorway changes the room cue",
      },
      metaphor: { type: "none", label: "", emotional_beat: "doorway memory cue" },
      callback_role: sceneIndex === 0 ? "seed" as const : sceneIndex === 3 ? "payoff" as const : "none" as const,
      performance_note: "Treat the door as a background transition, not a carried prop",
    })),
  };

  const staged = applyRendererStaging(entries, creative);
  const compiled = staged.map((entry) => JSON.parse(entry.template_data) as Record<string, any>);

  for (const scene of compiled) {
    assert.equal(scene.visualEvent.foregroundProp, undefined, "door must not survive as a foreground overlay");
    assert.equal(scene.background.ambientMotion, "doorway-cross");
    assert.equal(scene.background.doorwaySetPiece, true);
    assert.equal(scene.rendererPerformance.doorwayStaging, "environment");
    assert.equal(scene.rendererPerformance.visibleCentralObject, "doorway-set-piece");
    assert.equal(scene.shotType, "doorway-transition");
  }

  const environments = new Set(compiled.map((scene) => scene.background.location));
  assert.ok(environments.size >= 2, "doorway-dominant episodes must still move between visible environments");
});

test("large set-piece props are forced away from character face space", () => {
  assert.match(v14Source, /locker/);
  assert.match(v14Source, /window/);
  assert.match(v14Source, /bed/);
  assert.match(v14Source, /vehicle/);
  assert.match(v14Source, /anchor:\s*foregroundProp\.anchor === "left" \|\| foregroundProp\.anchor === "right"/);
});

test("doorway memory scenes force at least room-level environment changes", () => {
  assert.match(v14Source, /isDoorwayMemoryScene/);
  assert.match(v14Source, /"office"/);
  assert.match(v14Source, /"living-room"/);
  assert.match(v14Source, /"kitchen"/);
  assert.match(v14Source, /"doorway-transition"/);
});
