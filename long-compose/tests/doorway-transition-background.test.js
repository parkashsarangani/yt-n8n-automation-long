import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const backgroundSource = readFileSync(new URL("../remotion/src/components/Background.tsx", import.meta.url), "utf8");

test("background supports generic set-piece rendering", () => {
  assert.match(backgroundSource, /BackgroundSetPieceKind/);
  assert.match(backgroundSource, /function SetPieceOverlay/);
  assert.match(backgroundSource, /background\.setPiece/);
  for (const kind of ["doorway", "window", "bed", "locker", "vehicle"]) {
    assert.match(backgroundSource, new RegExp(`"${kind}"`));
  }
});

test("doorway transitions render as background set pieces", () => {
  assert.match(backgroundSource, /"doorway-cross"/);
  assert.match(backgroundSource, /function DoorwaySetPiece/);
  assert.match(backgroundSource, /case "doorway"/);
});

test("set pieces stay in the background layer, not character foreground", () => {
  assert.match(backgroundSource, /pointerEvents:\s*"none"/);
  assert.match(backgroundSource, /left:\s*104/);
  assert.doesNotMatch(backgroundSource, /zIndex:\s*7/);
});
