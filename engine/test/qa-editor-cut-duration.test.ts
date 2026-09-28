/**
 * Production 2026-09-28: the editor's cut of a custom episode ran 222.4s
 * against 230.8s of narration -- 8.5s (3.7%) shorter, trimmed pauses. The
 * Drive intake accepted it (it allows 0.5-2x), then QA failed it on the 3%
 * tolerance meant for our own renderer, and the finished episode parked at
 * approve_publish instead of uploading. An editor's cut is judged by the
 * intake's bounds; our renderer keeps the strict check.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeQaWorker } from "../src/workers/qa.ts";
import { mp4_1080p } from "./mp4-fixture.ts";

const VOICE_SEC = 230.8;

function inputs(render: Record<string, unknown>) {
  const scenes = [
    { scene_index: 0, narration: "You hear your own idea repeated back as someone else's." },
    { scene_index: 1, narration: "You interrupt, and the room moves on without you." },
  ];
  return {
    intent: { payload: { target_duration_sec: VOICE_SEC } },
    script: { payload: { scenes } },
    voice: {
      payload: {
        clips: [
          { scene_index: 0, audio_uri: "blob:a0", duration_sec: VOICE_SEC / 2 },
          { scene_index: 1, audio_uri: "blob:a1", duration_sec: VOICE_SEC / 2 },
        ],
        duration_sec: VOICE_SEC,
      },
    },
    render: { payload: { video_uri: "blob:video", media_type: "video/quicktime", scene_count: scenes.length, degraded_scenes: 0, ...render } },
    thumbnail: { payload: { thumbnail_uri: "blob:t", media_type: "image/png", width: 1280, height: 720, bytes: 1000 } },
    seo: { payload: { title: "A title", description: "A description", tags: ["one", "two"] } },
  } as never;
}

const ctx = {
  blobs: { get: async () => mp4_1080p() },
  logger: { warn() {}, log() {}, error() {} },
  progress: async () => {},
} as never;

async function durationCheck(render: Record<string, unknown>) {
  const result = await makeQaWorker().execute(inputs(render), ctx);
  const qa = result.payload as { verdict: string; checks: Array<{ id: string; status: string; message: string }> };
  return { qa, check: qa.checks.find((c) => c.id === "render_audio_duration")! };
}

test("the production case: an editor cut 8.5s shorter than its narration passes QA", async () => {
  const { qa, check } = await durationCheck({ renderer: "editor", duration_sec: 222.355, thumbnail_uri: "blob:et" });
  assert.equal(check.status, "pass", check.message);
  assert.match(check.message, /8\.4s shorter/);
  assert.equal(qa.verdict, "pass");
});

test("an editor cut longer than the narration (intro/outro cards) passes too", async () => {
  const { check } = await durationCheck({ renderer: "editor", duration_sec: VOICE_SEC + 25 });
  assert.equal(check.status, "pass", check.message);
});

test("an editor cut outside the intake's bounds -- a partial export or another episode -- still fails", async () => {
  for (const duration_sec of [VOICE_SEC * 0.4, VOICE_SEC * 2.2]) {
    const { check } = await durationCheck({ renderer: "editor", duration_sec });
    assert.equal(check.status, "fail", `${duration_sec}s`);
  }
});

test("our own renderer keeps the strict tolerance: 8.5s off still fails", async () => {
  const { check } = await durationCheck({ duration_sec: 222.355 });
  assert.equal(check.status, "fail", check.message);
});
