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
  // generateWithVisionQa now retries once on a raw provider failure too (not
  // just a vision QA flag) -- both of scene 1's attempts (calls 2 and 3) must
  // fail for it to actually degrade, not just its first.
  const ctx = contentAddressedCtx((call) => (call === 2 || call === 3 ? "fail" : "ok"));
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
  // Both of scene 0's attempts (calls 1 and 2) must fail -- one raw provider
  // failure alone is now retried and recovers (see generateWithVisionQa).
  const ctx = contentAddressedCtx((call) => (call === 1 || call === 2 ? "fail" : "ok"));
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

test("ctx.priorArtifact reuses every real scene untouched, regenerating only what was a blank placeholder", async () => {
  // Real production case: a QA-triggered retry via GraphExecutor.regenerateNode
  // must not re-roll the 26 scenes that already worked -- only scene 0, the
  // one that came back a bare placeholder.
  const ctx = contentAddressedCtx(() => "ok");
  const primaryImage = await ctx.blobs.put(new TextEncoder().encode("scene0-bytes"), { role: "image", media_type: "image/png" });
  const fallbackImage = await ctx.blobs.put(new TextEncoder().encode("scene2-bytes"), { role: "image", media_type: "image/png" });
  (ctx as unknown as { priorArtifact: { payload: unknown } }).priorArtifact = {
    payload: {
      scenes: [
        { scene_index: 0, source: "primary", image_uri: primaryImage.uri, prompt: "prior prompt 0", template_data: "{}" },
        { scene_index: 1, source: "placeholder", prompt: "prior prompt 1", template_data: "{}" },
        { scene_index: 2, source: "fallback", image_uri: fallbackImage.uri, prompt: "prior prompt 2", template_data: "{}" },
      ],
      degraded_count: 2,
    },
  };

  const worker = makeIllustratedSceneAssetsWorker();
  const out = await worker.execute(
    {
      direction: {
        payload: {
          scenes: [0, 1, 2].map((i) => ({ scene_index: i, image_prompt: `subject ${i}`, camera_move: "hold" })),
        },
      },
      script: { payload: { scenes: [0, 1, 2].map((i) => ({ scene_index: i, narration: `line ${i}` })) } },
      intent: { payload: {} },
    } as never,
    ctx,
  );

  assert.equal(ctx.promptsSeen.length, 1, "only the placeholder scene should have called the image provider");
  const payload = out.payload as { scenes: Array<Record<string, unknown>>; degraded_count: number };
  assert.equal(payload.scenes[0]!["image_uri"], primaryImage.uri, "scene 0 reused byte-for-byte, not re-rolled");
  assert.equal(payload.scenes[0]!["source"], "primary");
  assert.equal(payload.scenes[2]!["image_uri"], fallbackImage.uri, "scene 2 reused byte-for-byte too");
  assert.equal(payload.scenes[2]!["source"], "fallback");
  assert.notEqual(payload.scenes[1]!["source"], "placeholder", "scene 1 (the actual blank) got regenerated");
  assert.ok(payload.scenes[1]!["image_uri"], "scene 1 now has a real image");
});

test("regenerating scene 0 gets real reference continuity from a reused scene, which the original first-attempt edge case never had", async () => {
  const store = new Map<string, Uint8Array>();
  const referencesSeen: Array<unknown> = [];
  const primaryBytes = new TextEncoder().encode("scene1-bytes");
  const primaryUri = "blob://sha256:" + "b".repeat(64);
  store.set(primaryUri, primaryBytes);

  const images = {
    id: "test-provider/mock",
    async generate() {
      throw new Error("generatePack should have been used once a reference exists");
    },
    async generatePack({ reference }: { reference?: { bytes: Uint8Array } }) {
      referencesSeen.push(reference);
      return {
        images: [{ bytes: new TextEncoder().encode("regenerated-scene0"), media_type: "image/png" }],
      };
    },
  };
  const ctx = {
    media: { images },
    blobs: {
      put: async (bytes: Uint8Array, _meta: unknown) => {
        const uri = `blob://sha256:${Buffer.from(bytes).toString("base64").padEnd(64, "0").slice(0, 64)}`;
        store.set(uri, bytes);
        return { uri };
      },
      get: async (uri: string) => store.get(uri) ?? new Uint8Array(),
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    attemptNumber: 1,
    progress: async () => {},
    priorArtifact: {
      payload: {
        scenes: [
          { scene_index: 0, source: "placeholder", prompt: "prior prompt 0", template_data: "{}" },
          { scene_index: 1, source: "primary", image_uri: primaryUri, prompt: "prior prompt 1", template_data: "{}" },
        ],
        degraded_count: 1,
      },
    },
  } as unknown as WorkerContext;

  const worker = makeIllustratedSceneAssetsWorker();
  await worker.execute(
    {
      direction: {
        payload: {
          scenes: [0, 1].map((i) => ({ scene_index: i, image_prompt: `subject ${i}`, camera_move: "hold" })),
        },
      },
      script: { payload: { scenes: [0, 1].map((i) => ({ scene_index: i, narration: `line ${i}` })) } },
      intent: { payload: {} },
    } as never,
    ctx,
  );

  assert.equal(referencesSeen.length, 1, "the regenerated scene should have gone through the reference-conditioned path");
  assert.deepEqual(referencesSeen[0], { bytes: primaryBytes, media_type: "image/png" });
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
