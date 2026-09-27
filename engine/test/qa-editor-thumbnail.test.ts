/**
 * Generated thumbnails are retired: only the editor's thumbnail-final is
 * published, and without it YouTube auto-picks a frame. thumbnail_integrity
 * checks the Drive placeholder, which always passes, so without this check
 * nothing an operator sees would say an episode went up with no thumbnail.
 * It is advisory: it must show in the QA report but never hold the episode
 * private on its own.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeQaWorker } from "../src/workers/qa.ts";
import { mp4_1080p } from "./mp4-fixture.ts";

function inputs(render: Record<string, unknown>) {
  const scenes = [
    { scene_index: 0, narration: "You hear your own idea repeated back as someone else's." },
    { scene_index: 1, narration: "You interrupt, and the room moves on without you." },
  ];
  return {
    intent: { payload: { target_duration_sec: 10 } },
    script: { payload: { scenes } },
    voice: {
      payload: {
        clips: [
          { scene_index: 0, audio_uri: "blob:a0", duration_sec: 5 },
          { scene_index: 1, audio_uri: "blob:a1", duration_sec: 5 },
        ],
        duration_sec: 10,
      },
    },
    render: {
      payload: { video_uri: "blob:video", media_type: "video/mp4", scene_count: scenes.length, degraded_scenes: 0, duration_sec: 10, ...render },
    },
    thumbnail: { payload: { thumbnail_uri: "blob:t", media_type: "image/png", width: 1280, height: 720, bytes: 1000 } },
    seo: { payload: { title: "A title", description: "A description", tags: ["one", "two"] } },
  } as never;
}

const ctx = {
  blobs: { get: async () => mp4_1080p() },
  logger: { warn() {}, log() {}, error() {} },
  progress: async () => {},
} as never;

async function report(render: Record<string, unknown>) {
  const result = await makeQaWorker().execute(inputs(render), ctx);
  return result.payload as { verdict: string; warned: number; checks: Array<{ id: string; status: string; message: string }> };
}

test("an editor cut carrying thumbnail-final passes the editor_thumbnail check", async () => {
  const qa = await report({ renderer: "editor", thumbnail_uri: "blob:editor-thumb" });
  assert.equal(qa.checks.find((c) => c.id === "editor_thumbnail")!.status, "pass");
});

test("no editor thumbnail is a visible warning, even though the placeholder passes integrity", async () => {
  for (const render of [{ renderer: "editor" }, {}, { thumbnail_uri: "blob:render-by-product" }]) {
    const qa = await report(render);
    const check = qa.checks.find((c) => c.id === "editor_thumbnail")!;
    assert.equal(check.status, "warn", JSON.stringify(render));
    assert.match(check.message, /auto-pick a frame/);
    assert.equal(qa.checks.find((c) => c.id === "thumbnail_integrity")!.status, "pass");
    assert.equal(qa.verdict, "pass", "the warning is advisory and must not fail QA");
  }
});
