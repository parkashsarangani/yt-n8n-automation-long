const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const registry = readFileSync(join(root, "remotion/src/lib/assetRegistry.ts"), "utf8");
const background = readFileSync(join(root, "remotion/src/components/Background.tsx"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "remotion/public/assets/manifest.json"), "utf8"));

test("local asset registry declares multiple source families", () => {
  for (const source of ["scene-pack", "iconify", "open-peeps", "lottie", "remotion-bits"]) {
    assert.match(registry, new RegExp(`library: \"${source}\"`));
    assert.ok(manifest.sources.some((entry) => entry.library === source), `${source} should be documented in manifest`);
  }
});

test("registered local assets resolve to vendored files, not runtime URLs", () => {
  const localAssets = manifest.assets.filter((asset) => asset.path);
  assert.ok(localAssets.length >= 6, "expected local scene/prop/character/motion assets");

  for (const asset of localAssets) {
    assert.equal(/^https?:\/\//.test(asset.path), false, `${asset.key} must not use a remote URL`);
    assert.ok(existsSync(join(root, "remotion/public", asset.path)), `${asset.key} missing local file ${asset.path}`);
  }
});

test("background renderer prioritizes authored layers and uses replacement plates only as fallback", () => {
  assert.match(background, /resolveScenePlate/);
  assert.match(background, /scenePlateFor\(background\)/);
  assert.match(background, /const hasAuthoredLayers = Boolean\(background\.layers\?\.back \|\| background\.layers\?\.middle \|\| background\.layers\?\.front\)/);
  assert.match(background, /const useReplacementPlate = scenePlate\?\.compositeMode === "replace-background" && !hasAuthoredLayers/);
  assert.match(background, /\{useReplacementPlate && <ScenePlate asset=\{scenePlate\} \/>\}/);
  assert.match(background, /\{!useReplacementPlate && <BackgroundLayersView/);
  assert.match(background, /staticFile\(asset\.source\.path\)/);
});

test("set-piece renderer remains exhaustive and avoids local-plus-fallback double render", () => {
  assert.match(background, /function SetPieceFallback/);
  for (const kind of ["doorway", "window", "bed", "locker", "vehicle"]) {
    assert.match(background, new RegExp(`case \"${kind}\"`), `${kind} should be handled by the exhaustive set-piece switch`);
  }
  assert.match(background, /default: return assertNever\(kind\)/);
  assert.match(background, /asset \? <LocalSetPieceAsset asset=\{asset\} \/> : <SetPieceFallback/);
  assert.doesNotMatch(background, /setPiece\.kind === \"window\" && <WindowSetPiece/);
  assert.doesNotMatch(background, /setPiece\.kind === \"bed\" && <BedSetPiece/);
  assert.doesNotMatch(background, /setPiece\.kind === \"locker\" && <LockerSetPiece/);
  assert.doesNotMatch(background, /setPiece\.kind === \"vehicle\" && <VehicleSetPiece/);
});

test("scene plates cover common room-level locations", () => {
  for (const key of ["scene:office:default", "scene:kitchen:default", "scene:living-room:default", "scene:hallway:default"]) {
    assert.ok(manifest.assets.some((asset) => asset.key === key), `${key} should be registered`);
    assert.match(registry, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("asset policy forbids network access during render", () => {
  assert.equal(manifest.policy.runtimeNetworkAccess, false);
  for (const asset of manifest.assets.filter((entry) => entry.path)) {
    assert.equal(/^https?:\/\//.test(asset.path), false, `${asset.key} must not render from a remote URL`);
  }
  assert.doesNotMatch(background, /fetch\(|axios/);
  assert.doesNotMatch(registry, /fetch\(|axios/);
});
