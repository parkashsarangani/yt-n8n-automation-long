/**
 * Shorts/Reels (2026-09-29): QA accepts vertical 1080x1920 as a production
 * geometry and holds a vertical video to the 60 s cap every target platform
 * can take. The format is read from the video itself, never VIDEO_FORMAT, so
 * a long-form cut returned after the switch still passes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeQaWorker } from "../src/workers/qa.ts";
import { mp4 } from "./mp4-fixture.ts";

function inputs(durationSec: number) {
  const scenes = [{ scene_index: 0, narration: "A short vertical beat." }];
  return {
    intent: { payload: { target_duration_sec: durationSec } },
    script: { payload: { scenes } },
    voice: { payload: { clips: [{ scene_index: 0, audio_uri: "blob:a0", duration_sec: durationSec }], duration_sec: durationSec } },
    render: { payload: { video_uri: "blob:video", media_type: "video/mp4", scene_count: 1, degraded_scenes: 0, duration_sec: durationSec, renderer: "editor", thumbnail_uri: "blob:t" } },
    thumbnail: { payload: { thumbnail_uri: "blob:t", media_type: "image/png", width: 1280, height: 720, bytes: 1000 } },
    seo: { payload: { title: "A title", description: "A description", tags: ["one", "two"] } },
  } as never;
}

async function checks(width: number, height: number, durationSec: number) {
  const ctx = { blobs: { get: async () => mp4(width, height) }, logger: { warn() {}, log() {}, error() {} }, progress: async () => {} } as never;
  const qa = (await makeQaWorker().execute(inputs(durationSec), ctx)).payload as { checks: Array<{ id: string; status: string; message: string }> };
  return (id: string) => qa.checks.find((c) => c.id === id);
}

test("a vertical 1080x1920 cut within 60 s passes geometry and the length cap", async () => {
  const c = await checks(1080, 1920, 45);
  assert.equal(c("render_geometry")!.status, "pass", c("render_geometry")!.message);
  assert.match(c("render_geometry")!.message, /\(short\)/);
  assert.equal(c("format_max_duration")!.status, "pass");
});

test("a vertical cut over 60 s fails QA instead of reaching the platforms", async () => {
  const c = await checks(1080, 1920, 75);
  assert.equal(c("format_max_duration")!.status, "fail", c("format_max_duration")!.message);
});

test("long-form 1920x1080 still passes and has no length cap", async () => {
  const c = await checks(1920, 1080, 600);
  assert.equal(c("render_geometry")!.status, "pass");
  assert.equal(c("format_max_duration"), undefined);
});

test("an off-spec geometry still fails", async () => {
  const c = await checks(720, 1280, 30);
  assert.equal(c("render_geometry")!.status, "fail");
});
