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
  const prompt = buildIllustratedPrompt("a field of rats converging on a stone well");
  assert.ok(prompt.startsWith("Subject: a field of rats converging on a stone well."));
});

test("image_style selects a genuinely different visual identity, not a label swap", () => {
  const inkWash = buildIllustratedPrompt("a shopkeeper handing a child free candy", "ink_wash_stickman");
  const comic = buildIllustratedPrompt("a shopkeeper handing a child free candy", "flat_comic_expressive");
  assert.match(inkWash, /faceless/);
  assert.match(inkWash, /muted, near-monochrome palette/);
  assert.match(comic, /expressive minimal faces/);
  assert.match(comic, /bright but limited flat color palette/);
  assert.doesNotMatch(comic, /faceless/);
  assert.doesNotMatch(inkWash, /expressive minimal faces/);
});

test("an unrecognized image_style falls back to the default rather than throwing", () => {
  const prompt = buildIllustratedPrompt("a shopkeeper handing a child free candy", "nonsense" as never);
  assert.match(prompt, /faceless/, "falls back to ink_wash_stickman, the default");
});

test("all five image styles are visually distinct from one another", () => {
  const subject = "a delivery driver checking a paper map at dawn";
  const prompts = {
    ink_wash_stickman: buildIllustratedPrompt(subject, "ink_wash_stickman"),
    flat_comic_expressive: buildIllustratedPrompt(subject, "flat_comic_expressive"),
    documentary_sketch: buildIllustratedPrompt(subject, "documentary_sketch"),
    watercolor_storybook: buildIllustratedPrompt(subject, "watercolor_storybook"),
    noir_charcoal: buildIllustratedPrompt(subject, "noir_charcoal"),
  };
  assert.match(prompts.documentary_sketch, /charcoal and graphite reportage/);
  assert.match(prompts.documentary_sketch, /courtroom-sketch-artist register/);
  assert.match(prompts.watercolor_storybook, /soft watercolor storybook/);
  assert.match(prompts.watercolor_storybook, /warm pastel palette/);
  assert.match(prompts.noir_charcoal, /high-contrast noir charcoal/);
  assert.match(prompts.noir_charcoal, /chiaroscuro/);
  const unique = new Set(Object.values(prompts));
  assert.equal(unique.size, 5, "every style must produce a distinct prompt");
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
      intent: { payload: {} },
    } as never,
    ctx,
  );
  const payload = out.payload as { scenes: Array<Record<string, unknown>>; degraded_count: number };
  assert.equal(payload.degraded_count, 2);
  assert.equal(payload.scenes.length, 2);
  assert.equal(payload.scenes[0]!["source"], "placeholder");
});

function contentAddressedCtx(
  behavior: (callIndex: number) => "ok" | "fail",
): WorkerContext & { promptsSeen: string[] } {
  let calls = 0;
  const store = new Map<string, Uint8Array>();
  const promptsSeen: string[] = [];
  const images = {
    id: "test-provider/mock",
    async generate({ prompt }: { prompt: string }) {
      calls++;
      promptsSeen.push(prompt);
      if (behavior(calls) === "fail") throw new Error(`mock generation failure (call ${calls})`);
      return {
        images: [{ bytes: new TextEncoder().encode(`img-bytes-for:${prompt}`), media_type: "image/png" }],
        usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, provider: "test", model: "test" },
      };
    },
  };
  return {
    media: { images },
    blobs: {
      put: async (bytes: Uint8Array, meta: { media_type: string }) => {
        const key = Buffer.from(bytes).toString("base64");
        const uri = `blob://sha256:${key.padEnd(64, "0").slice(0, 64)}`;
        store.set(uri, bytes);
        void meta;
        return { uri };
      },
      get: async (uri: string) => store.get(uri) ?? new Uint8Array(),
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    attemptNumber: 1,
    progress: async () => {},
    promptsSeen,
  } as unknown as WorkerContext & { promptsSeen: string[] };
}

test("the outro scene's line reaches template_data so the CTA actually appears on screen", async () => {
  const worker = makeIllustratedSceneAssetsWorker();
  const ctx = contentAddressedCtx(() => "ok");
  const out = await worker.execute(
    {
      direction: {
        payload: {
          scenes: [
            { scene_index: 0, image_prompt: "a farmer planting an extra row of wheat", camera_move: "hold" },
            { scene_index: 1, image_prompt: "the same field, now visibly larger", camera_move: "pull-out" },
          ],
        },
      },
      script: {
        payload: {
          scenes: [
            { scene_index: 0, narration: "He planted one extra row, just in case." },
            { scene_index: 1, narration: "If this saved you a bad year, tell a farmer you know. Subscribe for the next one.", is_outro: true },
          ],
        },
      },
      intent: { payload: {} },
    } as never,
    ctx,
  );

  const payload = out.payload as { scenes: Array<Record<string, unknown>> };
  const outroData = JSON.parse(payload.scenes[1]!["template_data"] as string) as Record<string, unknown>;
  assert.equal(outroData.line, "If this saved you a bad year, tell a farmer you know. Subscribe for the next one.");
  const nonOutroData = JSON.parse(payload.scenes[0]!["template_data"] as string) as Record<string, unknown>;
  assert.equal("line" in nonOutroData, false, "only the actual outro scene gets a line");
});

test("a mid-episode generation failure reuses the episode's reference image instead of a blank placeholder", async () => {
  const worker = makeIllustratedSceneAssetsWorker();
  const ctx = contentAddressedCtx((call) => (call === 2 ? "fail" : "ok"));
  const out = await worker.execute(
    {
      direction: {
        payload: {
          scenes: [
            { scene_index: 0, image_prompt: "a stone well at dusk", camera_move: "hold" },
            { scene_index: 1, image_prompt: "rats converging on the well", camera_move: "push-in" },
            { scene_index: 2, image_prompt: "the well at dawn, quiet again", camera_move: "pull-out" },
          ],
        },
      },
      script: {
        payload: { scenes: [0, 1, 2].map((i) => ({ scene_index: i, narration: `line ${i}` })) },
      },
      intent: { payload: {} },
    } as never,
    ctx,
  );

  const payload = out.payload as { scenes: Array<Record<string, unknown>>; degraded_count: number };
  assert.equal(payload.degraded_count, 1);
  assert.equal(payload.scenes[1]!["source"], "fallback");
  assert.ok(payload.scenes[1]!["image_uri"], "the fallback scene must still have a real image_uri, not be a bare placeholder");
  assert.equal(payload.scenes[1]!["image_uri"], payload.scenes[0]!["image_uri"], "it must reuse scene 0's actual reference image");
});

test("the very first scene failing has no reference image yet, so it still falls through to a placeholder", async () => {
  const worker = makeIllustratedSceneAssetsWorker();
  const ctx = contentAddressedCtx((call) => (call === 1 ? "fail" : "ok"));
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
      script: { payload: { scenes: [0, 1].map((i) => ({ scene_index: i, narration: `line ${i}` })) } },
      intent: { payload: {} },
    } as never,
    ctx,
  );

  const payload = out.payload as { scenes: Array<Record<string, unknown>> };
  assert.equal(payload.scenes[0]!["source"], "placeholder");
  assert.equal(payload.scenes[0]!["image_uri"], undefined);
});

test("intent.image_style threads through to the actual generated prompts", async () => {
  const worker = makeIllustratedSceneAssetsWorker();
  const ctx = contentAddressedCtx(() => "ok");
  await worker.execute(
    {
      direction: {
        payload: {
          scenes: [{ scene_index: 0, image_prompt: "a shopkeeper handing a child free candy", camera_move: "hold" }],
        },
      },
      script: { payload: { scenes: [{ scene_index: 0, narration: "line 0" }] } },
      intent: { payload: { image_style: "flat_comic_expressive" } },
    } as never,
    ctx,
  );

  assert.equal(ctx.promptsSeen.length, 1);
  assert.match(ctx.promptsSeen[0]!, /expressive minimal faces/);
});

test("an absent intent.image_style keeps the default ink_wash_stickman identity", async () => {
  const worker = makeIllustratedSceneAssetsWorker();
  const ctx = contentAddressedCtx(() => "ok");
  await worker.execute(
    {
      direction: {
        payload: {
          scenes: [{ scene_index: 0, image_prompt: "a shopkeeper handing a child free candy", camera_move: "hold" }],
        },
      },
      script: { payload: { scenes: [{ scene_index: 0, narration: "line 0" }] } },
      intent: { payload: {} },
    } as never,
    ctx,
  );

  assert.match(ctx.promptsSeen[0]!, /faceless/);
});
