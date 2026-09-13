import test from "node:test";
import assert from "node:assert/strict";
import { makeFinalizeVideoWorker } from "../src/workers/finalize-video.ts";
import type { Artifact } from "../src/artifact.ts";
import type { WorkerContext } from "../src/runner.ts";

const ctx = { logger: console, blobs: undefined, media: {}, progress: async () => {}, attemptNumber: 1 } as unknown as WorkerContext;

test("finalize_video passes the draft render through unchanged when no edited cut was supplied", async () => {
  const render = {
    payload: { video_uri: "blob://sha256:" + "a".repeat(64), media_type: "video/mp4", scene_count: 3, degraded_scenes: 0 },
    blobs: [{ role: "video", uri: "blob://sha256:" + "a".repeat(64) }],
  } as Artifact;
  const editorReview = { payload: { drive_folder_id: "f1", drive_folder_url: "https://example.test/f1", scenes: [] } } as Artifact;

  const out = await makeFinalizeVideoWorker().execute({ editor_review: editorReview, render }, ctx);
  assert.deepEqual(out.payload, render.payload);
  assert.deepEqual(out.blobs, render.blobs);
});
