/**
 * Shorts/Reels (2026-09-29): with VIDEO_FORMAT=short the render worker asks
 * the compositor for a 9:16 draft and refuses one that comes back in the
 * wrong shape. Unset keeps long-form's request exactly as it was (no aspect).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeRenderWorker } from "../src/workers/render.ts";
import { MemoryBlobStore } from "../src/blobs.ts";
import type { Artifact } from "../src/artifact.ts";
import type { WorkerContext } from "../src/runner.ts";
import { mp4 } from "./mp4-fixture.ts";

/** Run the render worker under a VIDEO_FORMAT, with a renderer returning a draft of the given size. */
async function render(format: string | undefined, returned: { width: number; height: number }) {
  const previous = process.env["VIDEO_FORMAT"];
  if (format === undefined) delete process.env["VIDEO_FORMAT"]; else process.env["VIDEO_FORMAT"] = format;
  const requests: Array<{ aspect?: string }> = [];
  try {
    const blobs = new MemoryBlobStore();
    const audio = await blobs.put(new Uint8Array([1]), { role: "audio", media_type: "audio/wav" });
    const ctx = {
      blobs, logger: { log() {}, warn() {}, error() {} }, progress: async () => {},
      media: { renderer: { id: "long-compose", render: async (req: { aspect?: string }) => { requests.push(req); return { video: mp4(returned.width, returned.height), media_type: "video/mp4", captions_srt: "1\n00:00:00,000 --> 00:00:03,000\nA short vertical beat.\n" }; } } },
    } as unknown as WorkerContext;
    const inputs = {
      script: { payload: { scenes: [{ scene_index: 0, point: "[scenario] beat", narration: "A short vertical beat." }] } } as Artifact,
      voice: { payload: { clips: [{ scene_index: 0, audio_uri: audio.uri, duration_sec: 3, media_type: "audio/wav" }] } } as Artifact,
    };
    await makeRenderWorker().execute(inputs, ctx);
    return requests;
  } finally {
    if (previous === undefined) delete process.env["VIDEO_FORMAT"]; else process.env["VIDEO_FORMAT"] = previous;
  }
}

test("short format requests a 9:16 draft and accepts a 1080x1920 result", async () => {
  const requests = await render("short", { width: 1080, height: 1920 });
  assert.equal(requests[0]!.aspect, "9:16");
});

test("a short draft that comes back landscape is refused", async () => {
  await assert.rejects(render("short", { width: 1920, height: 1080 }), /a short draft must be 1080x1920/);
});

test("long-form (unset) sends no aspect: the request is what it always was", async () => {
  const requests = await render(undefined, { width: 1920, height: 1080 });
  assert.equal(requests[0]!.aspect, undefined);
});
