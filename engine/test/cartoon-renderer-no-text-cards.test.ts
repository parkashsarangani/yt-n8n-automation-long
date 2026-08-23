import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CARTOON_SCENE = path.join(HERE, "../../long-compose/remotion/src/compositions/CartoonScene.tsx");

test("cartoon renderer does not render text-heavy event cards", () => {
  const source = readFileSync(CARTOON_SCENE, "utf8");

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
