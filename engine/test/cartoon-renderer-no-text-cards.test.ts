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

test("cartoon renderer draws every prompt-valid prop textlessly instead of dropping it", () => {
  const source = readFileSync(CARTOON_SCENE, "utf8");

  // Types the creative director prompt (engine/prompts/cartoon_creative_director/*.md)
  // is still allowed to choose. Every one of these must produce a drawn shape, not
  // `return null` — otherwise the central object silently disappears for that topic.
  for (const type of [
    "phone", "clock", "keys", "route-map", "calendar", "door", "coffee", "shoes",
    "laptop", "bed", "window",
    "kettle", "food", "document", "locker", "vehicle", "tool", "appliance", "bill", "letter",
  ]) {
    assert.match(
      source,
      new RegExp(`type === "${type}"`),
      `missing a drawn shape for prop type "${type}"`,
    );
  }
});
