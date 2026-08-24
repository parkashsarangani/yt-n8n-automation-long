const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const CARTOON_SCENE = path.join(root, "remotion", "src", "compositions", "CartoonScene.tsx");
const PROP_ASSET = path.join(root, "remotion", "src", "components", "PropAsset.tsx");
const ASSET_REGISTRY = path.join(root, "remotion", "src", "lib", "assetRegistry.ts");

const VALID_PROP_TYPES = [
  "phone", "clock", "keys", "route-map", "calendar", "door", "coffee", "shoes",
  "laptop", "bed", "window", "kettle", "food", "document", "locker", "vehicle",
  "tool", "appliance", "bill", "letter",
];

test("cartoon renderer does not render text-heavy event cards", () => {
  const source = fs.readFileSync(CARTOON_SCENE, "utf8");

  assert.doesNotMatch(source, /function\s+CallbackEchoOverlay/);
  assert.doesNotMatch(source, /function\s+PerformanceCueOverlay/);
  assert.doesNotMatch(source, /function\s+MetaphorVisualOverlay/);
  assert.doesNotMatch(source, /function\s+EventEnhancements/);
  assert.doesNotMatch(source, /objectLabel/);
  assert.doesNotMatch(source, /NEW SLIDE/);
  assert.doesNotMatch(source, /WHAT YOUR BRAIN SEES/);
  assert.doesNotMatch(source, /WHAT IF/);
  assert.doesNotMatch(source, /CALLBACK/);
});

test("cartoon renderer draws every prompt-valid prop textlessly instead of dropping it", () => {
  const sceneSource = fs.readFileSync(CARTOON_SCENE, "utf8");
  const propSource = fs.readFileSync(PROP_ASSET, "utf8");
  const registrySource = fs.readFileSync(ASSET_REGISTRY, "utf8");

  assert.match(sceneSource, /<PropAsset/);
  assert.match(propSource, /FALLBACK_GLYPH_BY_TYPE/);
  assert.match(propSource, /fallback-glyph/);

  for (const type of VALID_PROP_TYPES) {
    const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hasAssetAlias = new RegExp(`${escaped}:\s*\"prop:`).test(registrySource) || new RegExp(`\"${escaped}\":\s*\"prop:`).test(registrySource);
    const hasFallbackGlyph = new RegExp(`${escaped}:\s*\"`).test(propSource) || new RegExp(`\"${escaped}\":\s*\"`).test(propSource);
    assert.ok(hasAssetAlias || hasFallbackGlyph, `missing a drawn asset/fallback shape for prop type "${type}"`);
  }
});
