import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { MemoryBlobStore } from "../src/blobs.ts";
import { MemoryRunLog } from "../src/runlog.ts";
import { ProviderRouter, type RenderRequest } from "../src/provider.ts";
import { FakeRenderer } from "../src/providers/fake.ts";
import { ComposeRenderer } from "../src/providers/compose.ts";
import { Runner } from "../src/runner.ts";
import { makeRenderWorker } from "../src/workers/index.ts";
import { enforceContinuationBridge, validateGrowthPackageSelection } from "../src/workers/watchability-release.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = "Next: the cleaner who noticed what every engineer missed.";
const PACKAGE = {
  premise: "An ignored mechanic warns about a visible failure, then becomes the only person who can repair it.",
  target_audience: "Adults who enjoy workplace reversal stories",
  curiosity_gap: "Why the mechanic knew the failure was coming",
  emotional_engine: "injustice to anxiety to public vindication",
  selected_title: "His Boss Laughed at the Warning",
  selected_title_family: "conflict",
  selected_thumbnail_concept: "Boss laughing at mechanic",
  selected_thumbnail_family: "conflict",
  opening_visual: "A mechanic points at a visibly frayed belt while his supervisor waves him away.",
  opening_line: "He pointed at the belt twice. His boss laughed the second time.",
  first_30_seconds: {
    promise: "The warning will fail exactly the way he predicted.",
    zero_to_five: "Show the damaged belt and dismissal immediately.",
    five_to_fifteen: "Escalate the machine noise while coworkers side with the boss.",
    fifteen_to_thirty: "Reveal the first physical sign that the mechanic was right."
  },
  variants: [
    { family: "curiosity", title: "The Mechanic Nobody Listened To", thumbnail_concept: "Mechanic beside frayed belt", click_reason: "The viewer wants to know what he noticed." },
    { family: "conflict", title: "His Boss Laughed at the Warning", thumbnail_concept: "Boss laughing at mechanic", click_reason: "The injustice is instantly legible." },
    { family: "reversal", title: "Then the Machine Finally Broke", thumbnail_concept: "Broken machine behind mechanic", click_reason: "The reversal promises visible consequence." }
  ],
  scores: { clickability: 0.82, story_potential: 0.88, audience_size: 0.76 },
  selection_rationale: "The conflict package makes the injustice legible before the click and sets up a concrete reversal.",
  next_video_bridge: BRIDGE,
};

test("growth package selection is a deterministic family-membership contract", () => {
  assert.deepEqual(validateGrowthPackageSelection(PACKAGE), []);
  assert.match(
    validateGrowthPackageSelection({ ...PACKAGE, selected_title_family: "reversal" }).join("; "),
    /selected title does not exactly match the reversal variant/i,
  );
  const duplicate = { ...PACKAGE, variants: [PACKAGE.variants[0], PACKAGE.variants[0], PACKAGE.variants[2]] };
  assert.match(validateGrowthPackageSelection(duplicate).join("; "), /exactly one curiosity|exactly one conflict/i);
});

test("next_video_bridge overwrites a model-authored generic outro before voice and rendering", () => {
  const released = enforceContinuationBridge({
    scenes: [
      { scene_index: 0, point: "payoff", narration: "The machine restarted, and the room went quiet." },
      { scene_index: 1, point: "outro", narration: "Like and subscribe for more stories.", is_outro: true },
    ],
    word_count: 14,
  }, PACKAGE) as any;
  const outro = released.scenes.find((scene: any) => scene.is_outro === true);
  assert.equal(outro.narration, BRIDGE);
  assert.doesNotMatch(outro.narration, /like|subscribe|share|follow/i);
  assert.ok(released.word_count > 0);
});

test("growth_package.next_video_bridge reaches the episode render request", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-continuation-")), registry);
  const blobs = new MemoryBlobStore();
  const renderer = new FakeRenderer();
  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: { log() {}, warn() {}, error() {} },
    blobs,
    media: { renderer },
  });
  const put = async (schema_id: string, payload: unknown, producer: string) =>
    (await store.put({
      schema_id,
      payload,
      produced_by: { transformation: producer, version: "1", run_id: "run_bridge", provider: null },
    })).artifact;

  const audio = await blobs.put(new TextEncoder().encode("audio"), { role: "audio", media_type: "audio/mpeg" });
  const script = await put("script", {
    scenes: [{ scene_index: 0, point: "hook", narration: "He warned them twice." }],
  }, "human");
  const voice = await put("voice", {
    voice_id: "v1",
    clips: [{ scene_index: 0, audio_uri: audio.uri, duration_sec: 3 }],
  }, "voice");
  const assets = await put("asset_manifest", {
    scenes: [{ scene_index: 0, source: "placeholder", prompt: "mechanic points at a frayed belt" }],
    degraded_count: 1,
  }, "illustrated_scene_assets");
  const growthPackage = await put("growth_package", PACKAGE, "growth_packager");

  await runner.run(makeRenderWorker(), [
    script.artifact_id,
    voice.artifact_id,
    assets.artifact_id,
    growthPackage.artifact_id,
  ]);

  const request = renderer.requests[0] as RenderRequest & { outro_line?: string };
  assert.equal(request.outro_line, BRIDGE);
  assert.doesNotMatch(request.outro_line ?? "", /subscribe|like|share|follow/i);
});

test("ComposeRenderer sends the per-episode continuation line and sends none when absent", async () => {
  const submitted: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/compose") && init?.method === "POST") {
      submitted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ job_id: `job-${submitted.length}` }), { status: 200 });
    }
    if (/\/compose-status\/job-\d+$/.test(url)) {
      return new Response(JSON.stringify({ status: "done", success: true, output_path: "/app/outputs/out.mp4" }), { status: 200 });
    }
    if (url.endsWith("/outputs/out.mp4")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  const renderer = new ComposeRenderer({
    baseUrl: "http://compose.test",
    pollIntervalSec: 0,
    sleepImpl: async () => {},
    fetchImpl,
  });
  const scene = { scene_index: 0, audio: new Uint8Array([1]), audio_media_type: "audio/mpeg" };

  const withBridge: RenderRequest & { outro_line?: string } = { scenes: [scene], outro_line: BRIDGE };
  await renderer.render(withBridge);
  await renderer.render({ scenes: [scene] });

  assert.equal(submitted[0]!.outro_line, BRIDGE);
  assert.equal("outro_line" in submitted[1]!, false, "no generic CTA may reappear when no package bridge exists");
});
