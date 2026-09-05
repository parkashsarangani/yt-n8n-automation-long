import test from "node:test";
import assert from "node:assert/strict";
import { buildIllustratedPrompt, makeIllustratedSceneAssetsWorker, validateEpisodeDirection } from "../src/workers/illustrated-scene-assets.ts";
import { FreeMediaTerminalError } from "../src/free-media-policy.ts";
import type { WorkerContext } from "../src/runner.ts";

const shot = (shot_index: number, shot_function: any, importance: "normal" | "hero" = "normal", hero_role?: any) => ({
  shot_index,
  image_prompt: `a concrete visible action for ${shot_function} shot ${shot_index}`,
  camera_move: (shot_index % 2 ? "push-in" : "hold") as "push-in" | "hold",
  shot_function,
  importance,
  ...(hero_role ? { hero_role } : {}),
});
const validDirection = () => ({
  hero_shots: ["0:0", "1:0", "2:0"],
  scenes: [
    { scene_index: 0, shots: [shot(0, "wide", "hero", "hook"), shot(1, "object-detail")] },
    { scene_index: 1, shots: [shot(0, "reaction", "hero", "turn")] },
    { scene_index: 2, shots: [shot(0, "reveal", "hero", "payoff")] },
  ],
});

function ctxWithProvider(enabled = true, providerId = "test-provider/mock"): WorkerContext & { calls: string[] } {
  const calls: string[] = [];
  let blob = 0;
  const data = new Map<string, Uint8Array>();
  const images = enabled ? {
    id: providerId,
    async generate({ prompt }: { prompt: string }) {
      calls.push(prompt);
      return { images: [{ bytes: new TextEncoder().encode(`img-${calls.length}-${prompt}`), media_type: "image/png" }], usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, provider: "test", model: "test" } };
    },
  } : undefined;
  return {
    media: { images },
    blobs: {
      put: async (bytes: Uint8Array) => { const uri = `blob://sha256:${(++blob).toString(16).padStart(64, "0")}`; data.set(uri, bytes); return { uri }; },
      get: async (uri: string) => data.get(uri) ?? new Uint8Array(),
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    attemptNumber: 1,
    progress: async () => {},
    calls,
  } as unknown as WorkerContext & { calls: string[] };
}
const inputs = (direction = validDirection()) => ({
  direction: { payload: direction },
  script: { payload: { scenes: [
    { scene_index: 0, narration: "The machine failed while everyone ignored the warning." },
    { scene_index: 1, narration: "Then the dismissed worker stepped forward." },
    { scene_index: 2, narration: "One repair changed the whole room.", is_outro: true },
  ] } },
  intent: { payload: {} },
}) as never;

test("prompt preserves the concrete subject and visibly different style bundles", () => {
  const ink = buildIllustratedPrompt("a mechanic reaching for a broken belt", "ink_wash_stickman");
  const comic = buildIllustratedPrompt("a mechanic reaching for a broken belt", "flat_comic_expressive");
  assert.match(ink, /mechanic reaching/); assert.match(ink, /faceless/); assert.match(ink, /No typography/);
  assert.match(comic, /editorial cartoon/); assert.doesNotMatch(comic, /faceless minimal human figures/); assert.notEqual(ink, comic);
});

test("direction invariants enforce hero identity and reject three identical shot functions", () => {
  assert.doesNotThrow(() => validateEpisodeDirection(validDirection(), [0, 1, 2]));
  const mismatch = validDirection(); mismatch.hero_shots = ["0:0", "1:0", "2:1"];
  assert.throws(() => validateEpisodeDirection(mismatch, [0, 1, 2]), /hero_shots does not match/);
  const repetitive = validDirection();
  repetitive.scenes = [
    { scene_index: 0, shots: [shot(0, "wide", "hero", "hook")] },
    { scene_index: 1, shots: [shot(0, "wide", "hero", "turn")] },
    { scene_index: 2, shots: [shot(0, "wide", "hero", "payoff")] },
  ];
  assert.throws(() => validateEpisodeDirection(repetitive, [0, 1, 2]), /three consecutive shots use wide/);
});

test("multi-shot direction becomes image_uris and semantic shot_types in the manifest", async () => {
  const worker = makeIllustratedSceneAssetsWorker();
  const ctx = ctxWithProvider(true);
  const out = await worker.execute(inputs(), ctx);
  const payload = out.payload as any;
  assert.equal(worker.produces_version, "1.9.0");
  assert.equal(payload.scenes.length, 3);
  assert.equal(payload.scenes[0].image_uris.length, 2);
  assert.deepEqual(payload.scenes[0].shot_types, ["wide", "object-detail"]);
  assert.deepEqual(payload.scenes[0].hero_shot_ids, ["0:0"]);
  assert.equal(payload.visual_review.status, "unavailable");
  assert.equal(payload.visual_review.scores.opening_visual_strength, 0, "unavailable review must not masquerade as a perfect score");
});

test("paid/reference-capable routes keep tiered hero spend", async () => {
  const ctx = ctxWithProvider(true);
  await makeIllustratedSceneAssetsWorker().execute(inputs(), ctx);
  // Hook gets 3 candidates, the other heroes 2, connective shot 1.
  assert.equal(ctx.calls.length, 8);
});

test("FreeLLM route removes blind hero best-of-N quota multiplication", async () => {
  const ctx = ctxWithProvider(true, "cartoon-art/freellmapi-image/auto");
  await makeIllustratedSceneAssetsWorker().execute(inputs(), ctx);
  assert.equal(ctx.calls.length, 4, "the four directed shots should each get one baseline free image call");
});

test("FreeLLM route requests the hero tier only for hero shots, never for connective shots", async () => {
  const requests: Array<{ prompt: string; tier?: "hero" | "standard" }> = [];
  const ctx = {
    media: {
      images: {
        id: "cartoon-art/freellmapi-image/auto",
        async generate(req: { prompt: string; tier?: "hero" | "standard" }) {
          requests.push({ prompt: req.prompt, tier: req.tier });
          return { images: [{ bytes: new TextEncoder().encode(`img-${requests.length}`), media_type: "image/png" }], usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, provider: "freellmapi", model: "auto" } };
        },
      },
    },
    blobs: {
      put: async (bytes: Uint8Array) => ({ uri: `blob://sha256:${Buffer.from(bytes).toString("hex").padStart(64, "0").slice(0, 64)}` }),
      get: async () => new Uint8Array(),
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    attemptNumber: 1,
    progress: async () => {},
  } as unknown as WorkerContext;

  await makeIllustratedSceneAssetsWorker().execute(inputs(), ctx);

  const heroPrompts = requests.filter((r) => r.tier === "hero").map((r) => r.prompt);
  const standardPrompts = requests.filter((r) => r.tier !== "hero").map((r) => r.prompt);
  assert.equal(heroPrompts.length, 3, "the three declared hero shots must request the hero tier");
  assert.equal(standardPrompts.length, 1, "the one connective shot must not request the hero tier");
});

test("a retry reuses every unchanged successful shot pack instead of rerolling images", async () => {
  const worker = makeIllustratedSceneAssetsWorker();
  const ctx = ctxWithProvider(true);
  const first = await worker.execute(inputs(), ctx);
  const callsAfterFirst = ctx.calls.length;
  (ctx as any).priorArtifact = { payload: first.payload };
  await worker.execute(inputs(), ctx);
  assert.equal(ctx.calls.length, callsAfterFirst, "unchanged primary shot packs must incur zero additional image-generation calls");
});

test("a fallback scene gets a fresh independent regeneration attempt on retry, while primary scenes are reused for free", async () => {
  // Regression coverage for service.ts's targeted visual_asset_release
  // regeneration: a "fallback" source used to be treated the same as
  // "primary" for reuse purposes, so regenerateNode(assets) was a permanent
  // no-op on exactly the scenes it was meant to fix.
  const ctx = ctxWithProvider(true, "cartoon-art/freellmapi-image/auto");
  const realGenerate = (ctx.media as any).images.generate;
  let forceSceneOneFailure = true;
  (ctx.media as any).images.generate = async (req: { prompt: string }) => {
    if (forceSceneOneFailure && req.prompt.includes("for reaction shot 0")) {
      throw new Error("simulated generation failure");
    }
    return realGenerate(req);
  };

  const first = await makeIllustratedSceneAssetsWorker().execute(inputs(), ctx);
  const sceneOneFirst = (first.payload as any).scenes.find((s: any) => s.scene_index === 1);
  assert.equal(sceneOneFirst.source, "fallback", "scene 1 should fall back to the established reference after generation fails");

  forceSceneOneFailure = false;
  (ctx as any).priorArtifact = { payload: first.payload };
  const secondCallPrompts: string[] = [];
  (ctx.media as any).images.generate = async (req: { prompt: string }) => {
    secondCallPrompts.push(req.prompt);
    return realGenerate(req);
  };
  const second = await makeIllustratedSceneAssetsWorker().execute(inputs(), ctx);
  const sceneOneSecond = (second.payload as any).scenes.find((s: any) => s.scene_index === 1);

  assert.equal(sceneOneSecond.source, "primary", "the fresh regeneration attempt succeeds and must be recorded as primary");
  assert.ok(secondCallPrompts.some((p) => p.includes("for reaction shot 0")), "the fallback scene must get a fresh, independent generation call on retry");
  assert.ok(
    !secondCallPrompts.some((p) => p.includes("for wide shot 0") || p.includes("for reveal shot 0")),
    "already-successful primary scenes must still be reused for free, not regenerated",
  );
});

test("without an image provider the manifest explicitly degrades scenes to placeholders", async () => {
  const out = await makeIllustratedSceneAssetsWorker().execute(inputs(), ctxWithProvider(false));
  const payload = out.payload as any;
  assert.equal(payload.degraded_count, 3);
  assert.ok(payload.scenes.every((s: any) => s.source === "placeholder"));
  assert.equal(payload.visual_review.status, "unavailable");
});

test("outro narration is carried into template_data while regular scenes do not receive CTA text", async () => {
  const out = await makeIllustratedSceneAssetsWorker().execute(inputs(), ctxWithProvider(true));
  const scenes = (out.payload as any).scenes;
  assert.equal("line" in JSON.parse(scenes[0].template_data), false);
  assert.equal(JSON.parse(scenes[2].template_data).line, "One repair changed the whole room.");
});

test("a shot that fails before any reference exists is retried once a later scene provides one", async () => {
  const ctx = ctxWithProvider(true);
  const realGenerate = (ctx.media as any).images.generate;
  let openingAttempts = 0;
  (ctx.media as any).images.generate = async (req: { prompt: string }) => {
    const out = await realGenerate(req);
    // Paid test route: opening hero has 3 candidates x 2 attempts. Fail those,
    // then let the later deferred retry through once another shot is reference.
    if (req.prompt.includes("for wide shot 0") && ++openingAttempts <= 6) {
      throw new Error("content policy rejected the opening shot");
    }
    return out;
  };

  const out = await makeIllustratedSceneAssetsWorker().execute(inputs(), ctx);
  const sceneZero = (out.payload as any).scenes.find((s: any) => s.scene_index === 0);

  assert.ok(openingAttempts > 6, "the deferred retry must actually re-attempt the failed opening shot");
  assert.equal(sceneZero.image_uris.length, 2, "both successful scene-0 shots are distinct visuals");
  assert.equal(sceneZero.source, "primary");
});

test("duplicate content-addressed fallback references collapse to one manifest URI", async () => {
  const ctx = ctxWithProvider(true);
  const realGenerate = (ctx.media as any).images.generate;
  (ctx.media as any).images.generate = async (req: { prompt: string }) => {
    const out = await realGenerate(req);
    if (req.prompt.includes("for wide shot 0")) throw new Error("still rejected on every attempt");
    return out;
  };

  // Simulate a content-addressed blob store: equal image bytes => equal URI.
  const byContent = new Map<string, string>();
  let blob = 0;
  (ctx.blobs as any).put = async (bytes: Uint8Array) => {
    const key = Buffer.from(bytes).toString("base64");
    let uri = byContent.get(key);
    if (!uri) {
      uri = `blob://sha256:${(++blob).toString(16).padStart(64, "0")}`;
      byContent.set(key, uri);
    }
    return { uri };
  };

  const out = await makeIllustratedSceneAssetsWorker().execute(inputs(), ctx);
  const sceneZero = (out.payload as any).scenes.find((s: any) => s.scene_index === 0);

  assert.equal(sceneZero.image_uris.length, 1, "the same fallback image must appear once, satisfying asset_manifest uniqueItems");
  assert.equal(new Set(sceneZero.image_uris).size, sceneZero.image_uris.length);
  assert.equal(sceneZero.shot_types.length, 1, "render metadata must stay aligned with the unique visual list");
  assert.equal(sceneZero.source, "fallback");
});

test("terminal FreeLLM daily capacity failure aborts assets instead of becoming reference fallback", async () => {
  const ctx = ctxWithProvider(true, "cartoon-art/freellmapi-image/auto");
  let calls = 0;
  (ctx.media as any).images.generate = async () => {
    calls++;
    throw new FreeMediaTerminalError("daily free image allocation exhausted until midnight UTC");
  };

  await assert.rejects(
    () => makeIllustratedSceneAssetsWorker().execute(inputs(), ctx),
    /free-media-terminal.*daily free image allocation/i,
  );
  assert.equal(calls, 1, "worker must stop immediately rather than filling shots with fallbacks and continuing to call a dead provider");
});

test("a pathological paid direction cannot multiply the image bill", async () => {
  const ctx = ctxWithProvider(true);
  const many = {
    hero_shots: ["0:0", "1:0", "2:0"],
    scenes: [
      { scene_index: 0, shots: [shot(0, "wide", "hero", "hook"), shot(1, "object-detail"), shot(2, "reaction")] },
      { scene_index: 1, shots: [shot(0, "reveal", "hero", "turn"), shot(1, "medium"), shot(2, "close-up")] },
      { scene_index: 2, shots: [shot(0, "silhouette", "hero", "payoff"), shot(1, "wide"), shot(2, "scale-shot")] },
    ],
  };

  const out = await makeIllustratedSceneAssetsWorker().execute(inputs(many), ctx);
  const scenes = (out.payload as any).scenes;

  assert.ok(ctx.calls.length <= 70, `image generations must stay under the optional-spend ceiling, got ${ctx.calls.length}`);
  assert.ok(
    scenes.every((s: any) => s.image_uris.length === 3),
    "every directed shot still gets its own image; only optional spend is cut",
  );
});
