import test from "node:test";
import assert from "node:assert/strict";

import { assertYouTubeProductionGeometry, readMp4Geometry } from "../src/media/mp4.ts";
import { box, concat, mp4, tkhd } from "./mp4-fixture.ts";

test("MP4 geometry reader ignores zero-sized audio tracks and reads video display size", () => {
  assert.deepEqual(readMp4Geometry(mp4(1920, 1080)), { width: 1920, height: 1080 });
});

test("production YouTube guard accepts 1080p landscape", () => {
  assert.deepEqual(assertYouTubeProductionGeometry(mp4(1920, 1080)), { width: 1920, height: 1080 });
});

test("production YouTube guard rejects the observed 720p regression before upload", () => {
  assert.throws(
    () => assertYouTubeProductionGeometry(mp4(1280, 720)),
    /video is 1280x720; production requires 1920x1080/,
  );
});

test("production YouTube guard rejects malformed MP4 bytes rather than guessing", () => {
  assert.throws(
    () => assertYouTubeProductionGeometry(new TextEncoder().encode("not an mp4")),
    /could not read MP4 display geometry/,
  );
});
