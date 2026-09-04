import test from "node:test";
import assert from "node:assert/strict";
import { buildIllustratedPrompt, makeIllustratedSceneAssetsWorker, validateEpisodeDirection } from "../src/workers/illustrated-scene-assets.ts";
import type { WorkerContext } from "../src/runner.ts";

const shot = (shot_index: number, shot_function: any, importance: "normal" | "hero" = "normal", hero_role?: any) => ({
  shot_index,
  image_prompt: `a concrete visible action for ${shot_function} shot ${shot_index}`,
  camera_move: shot_index % 2 ? "push-in" : "hold",
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

function ctxWithProvider(enabled = true): WorkerContext & { calls: string[] } {
  const calls: string[] = [];
  let blob = 0;
  const data = new Map<string, Uint8Array>();
  const images = enabled ? {
    id: "test-provider/mock",
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
  assert.match(comic, /flat 2D comic/); assert.doesNotMatch(comic, /faceless minimal human figures/); assert.notEqual(ink, comic);
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

test("multi-shot direction becomes image_uris and semantic shot_types in the v2 manifest", async () => {
  const worker = makeIllustratedSceneAssetsWorker();
  const ctx = ctxWithProvider(true);
  const out = await worker.execute(inputs(), ctx);
  const payload = out.payload as any;
  assert.equal(worker.produces_version, "2.0.0");
  assert.equal(payload.scenes.length, 3);
  assert.equal(payload.scenes[0].image_uris.length, 2);
  assert.deepEqual(payload.scenes[0].shot_types, ["wide", "object-detail"]);
  assert.deepEqual(payload.scenes[0].hero_shot_ids, ["0:0"]);
  assert.equal(payload.visual_review.status, "unavailable");
  assert.equal(payload.visual_review.scores.opening_visual_strength, 0, "unavailable review must not masquerade as a perfect score");
});

test("hero shots spend three generation candidates while normal shots spend one", async () => {
  const ctx = ctxWithProvider(true);
  await makeIllustratedSceneAssetsWorker().execute(inputs(), ctx);
  // 3 hero shots * 3 candidates + 1 normal shot * 1 candidate. Vision ranking/review
  // fail open with no OPENAI_API_KEY and therefore add no image-provider calls.
  assert.equal(ctx.calls.length, 10);
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

test("without an image provider the v2 manifest explicitly degrades scenes to placeholders", async () => {
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
