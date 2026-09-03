import test from "node:test";
import assert from "node:assert/strict";

import { buildIllustratedPrompt, makeIllustratedSceneAssetsWorker } from "../src/workers/illustrated-scene-assets.ts";
import type { WorkerContext } from "../src/runner.ts";

test("the built prompt carries the concrete subject plus the locked house style and negatives", () => {
  const prompt = buildIllustratedPrompt("a stick-figure man mid-throw, a pig falling into a well");
  assert.match(prompt, /a stick-figure man mid-throw, a pig falling into a well/);
  assert.match(prompt, /faceless/);
  assert.match(prompt, /muted, near-monochrome palette/);
  assert.match(prompt, /no photorealistic humans/);
  assert.match(prompt, /no text, no letters, no captions/);
});

test("the prompt never lets style/negative boilerplate crowd out the subject text", () => {
  // A real regression this format must never repeat: hybrid_visual_assets'
  // shotPrompt built prompts where the actual subject was a small fraction of
  // the total characters. Keep the subject as the first, unambiguous clause.
  const prompt = buildIllustratedPrompt("a field of rats converging on a stone well");
  assert.ok(prompt.startsWith("Subject: a field of rats converging on a stone well."));
});

function fakeCtx(images: WorkerContext["media"]["images"]): WorkerContext {
  const blobs: Array<{ bytes: Uint8Array; media_type: string }> = [];
  return {
    media: { images },
    blobs: {
      put: async (bytes: Uint8Array, meta: { media_type: string }) => {
        blobs.push({ bytes, media_type: meta.media_type });
        return { uri: `blob://sha256:${"a".repeat(64)}` };
      },
      get: async () => new Uint8Array(),
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    attemptNumber: 1,
    progress: async () => {},
  } as unknown as WorkerContext;
}

test("with no image provider, every scene degrades to a placeholder and the invariant still passes on scene 0", async () => {
  const worker = makeIllustratedSceneAssetsWorker();
  const ctx = fakeCtx(undefined);
  const out = await worker.execute(
    {
      direction: {
        payload: {
          scenes: [
            { scene_index: 0, image_prompt: "a stone well at dusk", camera_move: "hold" },
            { scene_index: 1, image_prompt: "rats converging on the well", camera_move: "push-in" },
          ],
        },
      },
      script: {
        payload: {
          scenes: [
            { scene_index: 0, narration: "It started with a well." },
            { scene_index: 1, narration: "Then the rats came." },
          ],
        },
      },
    } as never,
    ctx,
  );
  const payload = out.payload as { scenes: Array<Record<string, unknown>>; degraded_count: number };
  assert.equal(payload.degraded_count, 2);
  assert.equal(payload.scenes.length, 2);
  assert.equal(payload.scenes[0]!["source"], "placeholder");
});
