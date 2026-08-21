import test from "node:test";
import assert from "node:assert/strict";

import { assertYouTubeProductionGeometry, readMp4Geometry } from "../src/media/mp4.ts";

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function tkhd(width: number, height: number): Uint8Array {
  const payload = new Uint8Array(84);
  payload[0] = 0; // version 0
  const view = new DataView(payload.buffer);
  view.setUint32(76, Math.round(width * 65536), false);
  view.setUint32(80, Math.round(height * 65536), false);
  return box("tkhd", payload);
}

function mp4(width: number, height: number): Uint8Array {
  const audioTrack = box("trak", tkhd(0, 0));
  const videoTrack = box("trak", tkhd(width, height));
  return box("moov", concat(audioTrack, videoTrack));
}

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
