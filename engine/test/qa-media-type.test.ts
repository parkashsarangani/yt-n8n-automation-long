/**
 * The QA gate is the last thing between a returned cut and a public upload,
 * and it had no tests at all.
 *
 * The specific failure these cover happened in production on 2026-09-20, the
 * first time a human editor ever returned a cut: the editor exported a .mov,
 * the editor-return intake accepted it deliberately and preserved its real
 * media type, and QA then hard-failed anything that was not exactly
 * video/mp4. The episode imported cleanly, passed geometry and duration, and
 * parked at approve_publish on a verdict of "fail" -- one half of the system
 * permitting what the other half rejected.
 *
 * The last test is the one that matters: it fails if the two lists ever drift
 * apart again, which is the actual defect. Widening QA was incidental.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeQaWorker } from "../src/workers/qa.ts";
import { EDITOR_CUT_MEDIA_TYPES, isEditorCutFilename } from "../src/workers/editor-package.ts";
import { mp4_1080p } from "./mp4-fixture.ts";

const VIDEO_URI = "blob:video";

/** Minimal inputs: only the render's media type varies between cases. */
function inputs(mediaType: string | undefined) {
  const scenes = [
    { scene_index: 0, narration: "You hear your own idea repeated back as someone else's." },
    { scene_index: 1, narration: "You interrupt, and the room moves on without you." },
  ];
  return {
    intent: { payload: { target_duration_sec: 180 } },
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
      payload: {
        video_uri: VIDEO_URI,
        ...(mediaType === undefined ? {} : { media_type: mediaType }),
        scene_count: scenes.length,
        degraded_scenes: 0,
        duration_sec: 10,
      },
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

async function mediaTypeCheck(mediaType: string | undefined) {
  const result = await makeQaWorker().execute(inputs(mediaType), ctx);
  const checks = (result.payload as { checks: Array<{ id: string; status: string; message: string }> }).checks;
  return checks.find((c) => c.id === "render_media_type")!;
}

test("a QuickTime cut from the editor passes QA", async () => {
  // The exact production case: a .mov export, 1920x1080, complete.
  const check = await mediaTypeCheck("video/quicktime");
  assert.equal(check.status, "pass", check.message);
});

test("mp4 and m4v pass too", async () => {
  assert.equal((await mediaTypeCheck("video/mp4")).status, "pass");
  assert.equal((await mediaTypeCheck("video/x-m4v")).status, "pass");
});

test("a container the intake would never accept still fails", async () => {
  // Widening is not the same as removing the check.
  const check = await mediaTypeCheck("video/webm");
  assert.equal(check.status, "fail");
  assert.match(check.message, /expected one of/);
});

test("a missing media type fails rather than passing by omission", async () => {
  const check = await mediaTypeCheck(undefined);
  assert.equal(check.status, "fail");
  assert.match(check.message, /missing/);
});

test("every container the editor-return intake accepts is accepted by QA", async () => {
  // The real regression guard. Intake decides by filename extension, QA by
  // media type, and they are only consistent if these two lists agree. When
  // they disagreed, a correct episode stopped one step short of publishing.
  const extensionToMediaType: Record<string, string> = {
    "final.mp4": "video/mp4",
    "final.mov": "video/quicktime",
    "final.m4v": "video/x-m4v",
  };

  for (const [filename, mediaType] of Object.entries(extensionToMediaType)) {
    assert.ok(isEditorCutFilename(filename), `intake must accept ${filename}`);
    assert.ok(
      EDITOR_CUT_MEDIA_TYPES.has(mediaType),
      `intake accepts ${filename} but QA would reject ${mediaType}`,
    );
    assert.equal((await mediaTypeCheck(mediaType)).status, "pass", `QA must pass ${mediaType}`);
  }

  // And nothing beyond that set is silently allowed.
  assert.equal(EDITOR_CUT_MEDIA_TYPES.size, Object.keys(extensionToMediaType).length);
});
