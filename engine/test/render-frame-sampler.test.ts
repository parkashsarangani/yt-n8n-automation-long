import test from "node:test";
import assert from "node:assert/strict";

import { framesUsable, sampleRenderedFrames, type TimedFrame } from "../src/media/render-frame-sampler.ts";

function frame(overrides: Partial<TimedFrame> = {}): TimedFrame {
  return {
    at_sec: 1,
    requested_sec: 1,
    bytes: new Uint8Array([1, 2, 3]),
    media_type: "image/jpeg",
    ok: true,
    ...overrides,
  };
}

test("a group of decoded frames is usable", () => {
  assert.equal(framesUsable([frame(), frame({ at_sec: 2, requested_sec: 2 })]), true);
});

test("a group containing an undecodable frame is unusable, not partially scored", () => {
  assert.equal(framesUsable([frame(), frame({ ok: false, bytes: new Uint8Array() })]), false);
});

test("an empty-bytes frame is unusable even if it claims ok", () => {
  assert.equal(framesUsable([frame({ bytes: new Uint8Array() })]), false);
});

test("an empty group is unusable", () => {
  assert.equal(framesUsable([]), false);
});

test("a frame that cannot be extracted is reported unavailable, never substituted", async () => {
  // Not a video: every ffmpeg invocation fails, so no timestamp can produce
  // pixels. The old sampler answered by reusing the previous frame's bytes
  // while still reporting the requested timestamp -- fabricated evidence.
  const notAVideo = new Uint8Array(Buffer.from("this is definitely not an mp4 container"));
  const frames = await sampleRenderedFrames(notAVideo, [0.5, 1.5, 2.5]);

  assert.equal(frames.length, 3);
  for (const [index, sampled] of frames.entries()) {
    assert.equal(sampled.ok, false, `frame ${index} must be marked unavailable`);
    assert.equal(sampled.bytes.byteLength, 0, `frame ${index} must carry no pixels`);
  }
  assert.equal(framesUsable(frames), false);

  // Crucially, no two frames share bytes: nothing was copied forward.
  assert.deepEqual(frames.map((sampled) => sampled.requested_sec), [0.5, 1.5, 2.5]);
});

test("every frame records the timestamp it was actually decoded from", async () => {
  const frames = await sampleRenderedFrames(new Uint8Array(Buffer.from("not an mp4")), [10]);
  const only = frames[0]!;
  // requested_sec preserves what the caller asked for; at_sec is what the
  // sampler actually used, so a clamp or a within-tolerance seek is visible
  // rather than hidden behind the requested value.
  assert.equal(only.requested_sec, 10);
  assert.equal(typeof only.at_sec, "number");
});
