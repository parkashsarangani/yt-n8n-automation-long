import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const v14Source = readFileSync(new URL("../src/workers/cartoon-scenes-v14.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/workers/index.ts", import.meta.url), "utf8");

test("production cartoon compiler routes through v14 doorway staging", () => {
  assert.match(indexSource, /cartoon-scenes-v14\.ts/);
  assert.match(indexSource, /makeV14CartoonSceneCompilerWorker/);
  assert.doesNotMatch(indexSource, /makeV13CartoonSceneCompilerWorker/);
});

test("door props are removed from foreground overlays and converted to environment staging", () => {
  assert.match(v14Source, /isDoorProp/);
  assert.match(v14Source, /delete visualEvent\.foregroundProp/);
  assert.match(v14Source, /ambientMotion:\s*"doorway-cross"/);
  assert.match(v14Source, /doorwayStaging:\s*"environment"/);
});

test("large set-piece props are forced away from character face space", () => {
  assert.match(v14Source, /locker/);
  assert.match(v14Source, /window/);
  assert.match(v14Source, /bed/);
  assert.match(v14Source, /vehicle/);
  assert.match(v14Source, /anchor:\s*foregroundProp\.anchor === "left" \|\| foregroundProp\.anchor === "right"/);
});

test("doorway memory scenes force at least room-level environment changes", () => {
  assert.match(v14Source, /isDoorwayMemoryScene/);
  assert.match(v14Source, /"office"/);
  assert.match(v14Source, /"living-room"/);
  assert.match(v14Source, /"kitchen"/);
  assert.match(v14Source, /"doorway-transition"/);
});
