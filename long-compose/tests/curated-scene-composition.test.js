const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "remotion/public/assets/manifest.json"), "utf8"));
const registry = readFileSync(join(root, "remotion/src/lib/assetRegistry.ts"), "utf8");
const compositionPath = join(root, "remotion/src/lib/sceneComposition.ts");
const composition = readFileSync(compositionPath, "utf8");

function loadSceneComposition() {
  const compiled = ts.transpileModule(composition, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require: (id) => {
      if (id.startsWith("../components/")) return {};
      throw new Error(`unexpected runtime import from sceneComposition.ts: ${id}`);
    },
  };

  vm.runInNewContext(compiled, sandbox, { filename: "sceneComposition.ts" });
  return module.exports;
}

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

test("composeCharactersForScene applies concrete kitchen pair slots and preserves explicit gaze", () => {
  const { composeCharactersForScene } = loadSceneComposition();
  const result = composeCharactersForScene([
    { characterId: "host", x: 0, y: 0, scale: 1 },
    { characterId: "guest", x: 0, y: 0, scale: 1, gazeTarget: "camera" },
  ], { location: "kitchen" }, "medium");

  assert.equal(result[0].x, 520);
  assert.equal(result[0].y, 246);
  assert.equal(result[0].scale, 0.90);
  assert.equal(result[0].gazeTarget, "right");

  assert.equal(result[1].x, 930);
  assert.equal(result[1].y, 246);
  assert.equal(result[1].scale, 0.90);
  assert.equal(result[1].gazeTarget, "camera", "explicit gazeTarget should not be clobbered");
});

test("composeCharactersForScene resolves aliases and applies shot scale multipliers", () => {
  const { composeCharactersForScene, compositionProfileFor, foregroundMaskForScene } = loadSceneComposition();

  assert.equal(compositionProfileFor({ location: "commute" }).location, "car-interior");
  assert.equal(compositionProfileFor({ location: "doorway" }).location, "hallway");
  assert.equal(foregroundMaskForScene({ location: "store" }), "shop-counter");

  const wide = composeCharactersForScene([{ characterId: "solo", x: 0, y: 0, scale: 1 }], { location: "park" }, "wide")[0];
  const close = composeCharactersForScene([{ characterId: "solo", x: 0, y: 0, scale: 1 }], { location: "park" }, "close-up")[0];

  assert.equal(wide.x, 710);
  assert.equal(wide.y, 230);
  assert.ok(wide.scale < close.scale, "wide shot should scale actors smaller than close-up");
  assert.equal(Number(wide.scale.toFixed(3)), 0.846);
  assert.equal(Number(close.scale.toFixed(3)), 1.015);
});

test("composeCharactersForScene uses final group slot as deterministic overflow fallback", () => {
  const { composeCharactersForScene } = loadSceneComposition();
  const result = composeCharactersForScene([
    { characterId: "a", x: 1, y: 1 },
    { characterId: "b", x: 1, y: 1 },
    { characterId: "c", x: 1, y: 1 },
    { characterId: "d", x: 1, y: 1 },
  ], { location: "office" }, "medium");

  assert.equal(result.length, 4);
  assert.deepEqual(
    { x: result[3].x, y: result[3].y, scale: result[3].scale, gazeTarget: result[3].gazeTarget },
    { x: result[2].x, y: result[2].y, scale: result[2].scale, gazeTarget: result[2].gazeTarget },
  );
});

test("scene plates remain runtime-local only", () => {
  assert.equal(manifest.policy.runtimeNetworkAccess, false);
  for (const asset of manifest.assets.filter((entry) => entry.path)) {
    assert.equal(/^https?:\/\//.test(asset.path), false, `${asset.key} must not render from a remote URL`);
  }
  assert.doesNotMatch(registry, /fetch\(|axios/);
  assert.doesNotMatch(composition, /fetch\(|axios/);
});
