import test from "node:test";
import assert from "node:assert/strict";
import { FORMATS, formatOfGeometry, videoFormat } from "../src/video-format.ts";

test("unset VIDEO_FORMAT keeps long-form, so nothing changes until it is switched", () => {
  assert.equal(videoFormat({}), "long");
  assert.equal(videoFormat({ VIDEO_FORMAT: "short" }), "short");
  assert.equal(videoFormat({ VIDEO_FORMAT: " SHORT " }), "short");
  assert.throws(() => videoFormat({ VIDEO_FORMAT: "square" }), /VIDEO_FORMAT/);
});

test("short is vertical 1080x1920, 60-75 s; long is uncapped 1920x1080", () => {
  assert.deepEqual([FORMATS.short.width, FORMATS.short.height, FORMATS.short.minDurationSec, FORMATS.short.maxDurationSec], [1080, 1920, 60, 75]);
  assert.deepEqual([FORMATS.long.width, FORMATS.long.height, FORMATS.long.minDurationSec, FORMATS.long.maxDurationSec], [1920, 1080, null, null]);
});

test("a video's format comes from its own geometry", () => {
  assert.equal(formatOfGeometry(1080, 1920), "short");
  assert.equal(formatOfGeometry(1920, 1080), "long");
  assert.equal(formatOfGeometry(1280, 720), null);
});
