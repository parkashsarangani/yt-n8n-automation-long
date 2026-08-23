import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compilerSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "workers", "cartoon-scenes-v13.ts"),
  "utf8",
);

test("cartoon compiler emits renderer shot and style metadata", () => {
  for (const token of [
    "RendererShotType",
    "RendererVisualStyle",
    "rendererShotTypeFor",
    "rendererVisualStyleFor",
    "shotType",
    "visualStyle",
    "prop-close-up",
    "doorway-transition",
    "counter-shot",
    "table-shot",
  ]) {
    assert.match(compilerSource, new RegExp(token));
  }
});

test("renderer visual style derives from semantic scene fields, not prompt prose labels", () => {
  assert.match(compilerSource, /foregroundPropKind\(scene\)/);
  assert.match(compilerSource, /normalized\(scene\.foreground_prop\.type\)/);
  assert.match(compilerSource, /scene\.callback_role === "payoff"/);
  assert.match(compilerSource, /scene\.blocking\.prop_position/);
  assert.match(compilerSource, /rendererPerformance:[\s\S]*shotType/);
  assert.match(compilerSource, /rendererPerformance:[\s\S]*visualStyle: visualStyle\.name/);
});
