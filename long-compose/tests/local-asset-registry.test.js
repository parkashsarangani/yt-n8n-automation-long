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

test("background renderer prefers approved local scene plates and falls back to generated layers", () => {
  assert.match(background, /resolveScenePlate/);
  assert.match(background, /scenePlateFor\(background\)/);
  assert.match(background, /replaceLayers/);
  assert.match(background, /!replaceLayers && <BackgroundLayersView/);
  assert.match(background, /staticFile\(asset\.source\.path\)/);
});

test("scene plates cover common room-level locations", () => {
  for (const key of ["scene:office:default", "scene:kitchen:default", "scene:living-room:default", "scene:hallway:default"]) {
    assert.ok(manifest.assets.some((asset) => asset.key === key), `${key} should be registered`);
    assert.match(registry, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("asset policy forbids network access during render", () => {
  assert.equal(manifest.policy.runtimeNetworkAccess, false);
  assert.doesNotMatch(background, /fetch\(|axios|https?:\/\//);
  assert.doesNotMatch(registry, /fetch\(|axios/);
});
