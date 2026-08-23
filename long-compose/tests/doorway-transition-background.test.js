import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const backgroundSource = readFileSync(new URL("../remotion/src/components/Background.tsx", import.meta.url), "utf8");

test("doorway transitions render as background set pieces", () => {
  assert.match(backgroundSource, /"doorway-cross"/);
  assert.match(backgroundSource, /function DoorwayCrossOverlay/);
  assert.match(backgroundSource, /case "doorway-cross"/);
});

test("doorway set piece stays in the background layer, not character foreground", () => {
  assert.match(backgroundSource, /pointerEvents:\s*"none"/);
  assert.match(backgroundSource, /left:\s*104/);
  assert.doesNotMatch(backgroundSource, /zIndex:\s*7/);
});
