const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "remotion/public/assets/manifest.json"), "utf8"));
const registry = readFileSync(join(root, "remotion/src/lib/assetRegistry.ts"), "utf8");
const composition = readFileSync(join(root, "remotion/src/lib/sceneComposition.ts"), "utf8");

const REQUIRED_SCENES = [
  "office",
  "kitchen",
  "living-room",
  "hallway",
  "bedroom",
  "classroom",
  "cafe",
  "street",
  "park",
  "car-interior",
  "hospital-room",
  "airport",
  "shop",
  "bathroom",
  "library",
  "studio",
];

test("curated scene pack provides broad complete-scene coverage", () => {
  const sceneAssets = manifest.assets.filter((asset) => asset.role === "scenePlate");
  assert.ok(sceneAssets.length >= 16, `expected at least 16 scene plates, got ${sceneAssets.length}`);

  for (const location of REQUIRED_SCENES) {
    const key = `scene:${location}:default`;
    const asset = sceneAssets.find((entry) => entry.key === key);
    assert.ok(asset, `${key} should be listed in manifest`);
    assert.equal(asset.library, "scene-pack");
    assert.equal(/^https?:\/\//.test(asset.path), false, `${key} must be vendored locally`);
    assert.ok(existsSync(join(root, "remotion/public", asset.path)), `${key} file is missing`);
    assert.match(registry, new RegExp(`scenePlate\\(\"${location}\\"`), `${location} should be registered`);
  }
});

test("scene composition profiles exist for every curated scene", () => {
  assert.match(composition, /SCENE_COMPOSITION_PROFILES/);
  assert.match(composition, /composeCharactersForScene/);
  assert.match(composition, /floorContactY/);
  assert.match(composition, /foregroundMask/);

  for (const location of REQUIRED_SCENES) {
    assert.match(composition, new RegExp(`location: \"${location}\"`), `${location} needs a composition profile`);
  }
});

test("composition director defines perspective, depth and non-floating actor slots", () => {
  for (const required of ["horizonY", "groundY", "floorContactY", "depthZones", "performance", "foreground"]) {
    assert.match(composition, new RegExp(required), `${required} should be part of the profile contract`);
  }

  assert.match(composition, /y: 2[23][0-9]/, "actor top y slots should place full rigs on the floor line, not float at scene center");
  assert.match(composition, /scale: 0\.9[0-9]/, "scene slots should carry perspective scale information");
  assert.match(composition, /shotScaleMultiplier/, "shot types should influence actor scale");
});

test("story-location aliases resolve to curated scene profiles", () => {
  for (const alias of ["doorway", "corridor", "home", "work", "car", "commute", "hospital", "clinic", "store", "terminal", "plane"]) {
    assert.match(composition, new RegExp(`${alias}:`), `${alias} alias should be declared`);
  }

  for (const alias of ["doorway: \"hallway\"", "work: \"office\"", "car: \"car-interior\"", "hospital: \"hospital-room\"", "terminal: \"airport\""]) {
    assert.match(composition, new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("composeCharactersForScene source preserves concrete slot behavior", () => {
  assert.match(composition, /const profile = compositionProfileFor\(background\)/);
  assert.match(composition, /const slots = slotsFor\(profile, characters\.length\)/);
  assert.match(composition, /const multiplier = shotScaleMultiplier\(shotType\)/);
  assert.match(composition, /x: slot\.x/);
  assert.match(composition, /y: slot\.y/);
  assert.match(composition, /scale: scale \* slot\.scale \* multiplier/);
  assert.match(composition, /gazeTarget: character\.gazeTarget \?\? slot\.gaze \?\? \"auto\"/);

  assert.match(composition, /location: \"kitchen\"[\s\S]*x: 520, y: 246, scale: 0\.90/);
  assert.match(composition, /location: \"kitchen\"[\s\S]*x: 930, y: 246, scale: 0\.90/);
});

test("shot scale and overflow behavior remain deterministic", () => {
  assert.match(composition, /case \"wide\": return 0\.9/);
  assert.match(composition, /case \"close-up\": return 1\.08/);
  assert.match(composition, /const slot = slots\[index\] \?\? slots\[slots\.length - 1\] \?\? DEFAULT_PROFILE\.slots\.solo\[0\]!/);
  assert.match(composition, /foregroundMaskForScene/);
});

test("scene plates remain runtime-local only", () => {
  assert.equal(manifest.policy.runtimeNetworkAccess, false);
  for (const asset of manifest.assets.filter((entry) => entry.path)) {
    assert.equal(/^https?:\/\//.test(asset.path), false, `${asset.key} must not render from a remote URL`);
  }
  assert.doesNotMatch(registry, /fetch\(|axios/);
  assert.doesNotMatch(composition, /fetch\(|axios/);
});
