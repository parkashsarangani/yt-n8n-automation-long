const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const background = readFileSync(join(root, "remotion/src/components/Background.tsx"), "utf8");
const sceneDressing = readFileSync(join(root, "remotion/src/components/SceneDressing.tsx"), "utf8");
const cinematic = readFileSync(join(root, "remotion/src/lib/cinematicDirection.ts"), "utf8");
const sfxManifest = readFileSync(join(root, "remotion/public/assets/sfx/manifest.json"), "utf8");

test("background renderer is art-directed beyond raw starter plates", () => {
  assert.match(background, /SceneDressing/);
  assert.match(background, /<SceneDressing background=\{background\} frame=\{frame\}/);
  for (const location of ["KitchenDressing", "LivingRoomDressing", "OfficeDressing", "HallwayDressing", "StreetDressing"]) {
    assert.match(sceneDressing, new RegExp(location));
  }
  for (const detail of ["FramedArt", "Shelf", "PracticalLight", "TableDepth", "Rug"]) {
    assert.match(sceneDressing, new RegExp(detail));
  }
});

test("cinematic direction includes acting presets and walk-cycle surface", () => {
  for (const token of [
    "ActingPreset",
    "walk-cross",
    "double-take",
    "notices-prop",
    "small-defeat",
    "payoff-freeze",
    "cinematicActingStageTransform",
  ]) {
    assert.match(cinematic, new RegExp(token));
  }
});

test("SFX cues are locally declared and do not require runtime network access", () => {
  const manifest = JSON.parse(sfxManifest);
  assert.equal(manifest.runtimeNetworkAccess, false);
  assert.equal(manifest.status, "cue-contract");
  const cues = manifest.cues.map((cue) => cue.cue);
  assert.deepEqual(cues, ["room-change", "prop", "reaction", "payoff"]);
});

test("SFX cue visuals are connected to cinematic overlay styling", () => {
  for (const cue of ["room-change", "reaction", "prop"]) {
    assert.match(cinematic, new RegExp(cue));
  }
  assert.match(cinematic, /cinematicOverlayStyle/);
});
