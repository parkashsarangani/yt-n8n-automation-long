const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const sceneSource = fs.readFileSync(
  path.join(root, "remotion", "src", "compositions", "CartoonScene.tsx"),
  "utf8",
);

test("cartoon renderer exposes explicit visual style tokens", () => {
  for (const token of [
    "CartoonVisualStyleName",
    "clean-flat",
    "warm-modern",
    "bold-outline",
    "soft-editorial",
    "lineWeight",
    "deep-stage",
    "layered-parallax",
    "warm-window",
    "cool-monitor",
    "morning-soft",
    "STYLE_PRESETS",
    "resolveVisualStyle",
  ]) {
    assert.match(sceneSource, new RegExp(token));
  }
});

test("cartoon renderer has distinct shot-composition paths", () => {
  for (const shot of [
    "wide",
    "medium",
    "close-up",
    "prop-close-up",
    "doorway-transition",
    "counter-shot",
    "table-shot",
  ]) {
    assert.match(sceneSource, new RegExp(`"${shot}"`));
  }

  assert.match(sceneSource, /shotOffset/);
  assert.match(sceneSource, /propTransform/);
  assert.match(sceneSource, /characterLayerTransform/);
  assert.match(sceneSource, /StyleFrame/);
  assert.match(sceneSource, /visualStyle\?: CartoonVisualStyle/);
  assert.match(sceneSource, /shotType\?: CartoonShotType/);
});

test("visual appearance upgrade stays textless", () => {
  assert.doesNotMatch(sceneSource, /function\s+CallbackEchoOverlay/);
  assert.doesNotMatch(sceneSource, /function\s+PerformanceCueOverlay/);
  assert.doesNotMatch(sceneSource, /function\s+MetaphorVisualOverlay/);
  assert.doesNotMatch(sceneSource, /WHAT YOUR BRAIN SEES/);
  assert.doesNotMatch(sceneSource, /NEW SLIDE/);
});
