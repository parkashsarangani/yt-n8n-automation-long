/**
 * Generate one controlled RFC 0010 comparison episode end to end.
 *
 * The benchmark deliberately fixes the narration so we measure visual quality,
 * not topic selection or script variance. It creates:
 *   1. a current-production RFC 0009 illustrated control render,
 *   2. an RFC 0010 hybrid Visual Director render from the exact same script
 *      and exact same ElevenLabs voice artifact,
 *   3. rendered-frame QA and a blind per-beat comparison report.
 *
 * Nothing is published. Output MP4s and JSON diagnostics are exported beneath
 * BENCHMARK_EXPORT_DIR (default /data/rfc0010-benchmark-export).
 */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { JsonlRunLog, rollup } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { OpenAIProvider } from "../src/providers/openai.ts";
import { ElevenLabsProvider } from "../src/providers/elevenlabs.ts";
import { FalImageProvider } from "../src/providers/fal.ts";
import { CachedImageProvider } from "../src/providers/cached-image.ts";
import { ComposeRenderer } from "../src/providers/compose.ts";
import { Runner, type TransformationDef } from "../src/runner.ts";
import { loadAgentDefs, validateCatalog } from "../src/catalog.ts";
import { allTransformations, defaultWorkers } from "../src/workers/index.ts";
import { FsBlobStore } from "../src/blobs.ts";
import { loadGraph, validateGraph } from "../src/graph.ts";
import { GraphExecutor, type GraphRunResult } from "../src/executor.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env["AMOS_DATA"] ?? path.join(ROOT, ".vidgen-data");
const EXPORT_DIR = process.env["BENCHMARK_EXPORT_DIR"] ?? path.join(DATA, "rfc0010-benchmark-export");

function env(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() ? value.trim() : undefined;
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is required for the RFC 0010 end-to-end benchmark`);
  return value;
}

const SCENES = [
  {
    scene_index: 0,
    point: "Hook: expose how badly intuition compresses million, billion, and trillion into the same vague category.",
    narration: "Million. Billion. Trillion. They sound like three nearby steps on the same ladder. They are not. Your brain hears all three and quietly files them under one label: a lot. So let us turn them into something you can actually feel.",
  },
  {
    scene_index: 1,
    point: "Establish the one-dollar-per-second clock as a single consistent scale for the entire explanation.",
    narration: "Imagine you earn exactly one dollar every second. No sleeping, no weekends, no pauses. One dollar, every tick of the clock. At that speed, reaching one million dollars takes about eleven and a half days. Big, but still human-sized.",
  },
  {
    scene_index: 2,
    point: "Reveal the nonlinear intuition shock between a million and a billion using the same clock.",
    narration: "Now keep the clock running toward one billion. Not for another few weeks. Not for a year. You would wait almost thirty-two years. A newborn could grow into an adult with a career before the billionth dollar finally arrived.",
  },
  {
    scene_index: 3,
    point: "Escalate from billion to trillion and force a historical-timescale visual change.",
    narration: "Then comes a trillion. At one dollar per second, a trillion dollars takes roughly thirty-one thousand seven hundred years. That reaches back far beyond the first cities and writing, into a world before agriculture had transformed human life.",
  },
  {
    scene_index: 4,
    point: "Explain the arithmetic relationship cleanly: every named step is one thousand times the previous one.",
    narration: "The reason is simple but easy to underestimate. One billion is not one million plus a lot. It is one thousand separate millions. And one trillion is one thousand separate billions: one million separate millions packed into a single word.",
  },
  {
    scene_index: 5,
    point: "Give a physical spatial analogy that is ideal for authored motion graphics rather than generic B-roll.",
    narration: "Here is another way to see it. Pretend one million dollars is only one millimeter long. On that scale, one billion stretches to one meter. One trillion does not fit across a room. It stretches for a full kilometer.",
  },
  {
    scene_index: 6,
    point: "Connect the abstract scale back to ordinary language and why public discussion routinely misreads huge quantities.",
    narration: "That is why headlines can fool our intuition. Millionaire, billionaire, trillion-dollar market: the words sit next to each other in a sentence, so the quantities feel adjacent. But each jump multiplies the previous world by another thousand.",
  },
  {
    scene_index: 7,
    point: "Closing transformation: leave the viewer with one memorable mental model for future encounters with large numbers.",
    narration: "So next time you hear billion, do not picture a slightly larger million. Picture eleven days becoming thirty-two years. And when you hear trillion, picture that clock running for more than thirty thousand years. That is the scale hidden inside the words.",
    is_outro: true,
  },
] as const;

const WORD_COUNT = SCENES.reduce((sum, scene) => sum + scene.narration.trim().split(/\s+/).length, 0);

async function assertRun(name: string, result: GraphRunResult): Promise<void> {
  if (result.failures.length) {
    throw new Error(`${name} failed: ${result.failures.map((failure) => `${failure.node_id}: ${failure.error}`).join(" | ")}`);
  }
  if (result.waiting.length) {
    throw new Error(`${name} unexpectedly stopped at human gate(s): ${result.waiting.map((waiting) => waiting.node_id).join(", ")}`);
  }
}

async function main(): Promise<void> {
  const freeKey = requireEnv("FREELLMAPI_API_KEY");
  const textModel = env("FREELLMAPI_TEXT_MODEL") ?? "gemini-3.5-flash";
  if (/^auto(?::|$)/i.test(textModel) || !/gemini/i.test(textModel)) {
    throw new Error(`FREELLMAPI_TEXT_MODEL must be a concrete Gemini model; got ${textModel}`);
  }
  void freeKey;

  const elevenKey = requireEnv("ELEVENLABS_API_KEY");
  const voiceId = requireEnv("ELEVENLABS_VOICE_ID");
  const falKey = requireEnv("FAL_KEY");
  requireEnv("PEXELS_API_KEY");
  const composeUrl = requireEnv("COMPOSE_URL");

  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const agents = (await loadAgentDefs(path.join(ROOT, "agents"))) as Map<string, TransformationDef>;
  validateCatalog(agents as never, {
    hasSchema: (id) => registry.has(id),
    hasPrompt: (ref) => prompts.has(ref),
  });

  const controlGraph = await loadGraph(path.join(ROOT, "graphs", "visual_benchmark_control.json"));
  const benchmarkGraph = await loadGraph(path.join(ROOT, "graphs", "visual_benchmark.json"));

  const store = await FsArtifactStore.open(DATA, registry);
  const blobs = await FsBlobStore.open(DATA);
  const runLog = new JsonlRunLog(path.join(DATA, "runs.jsonl"));

  const speech = new ElevenLabsProvider({ apiKey: elevenKey });
  // Persistent image bank: with a fixed benchmark script the control and
  // candidate pipelines emit the same prompts run after run, so a re-run costs
  // no fal.ai spend for images already generated. IMAGE_BANK_DIR should point
  // at a Docker volume that survives `compose down`.
  const images = new CachedImageProvider(
    new FalImageProvider({ apiKey: falKey }),
    env("IMAGE_BANK_DIR"),
    console,
  );
  const renderer = new ComposeRenderer({ baseUrl: composeUrl });
  const transformations = allTransformations(
    agents,
    defaultWorkers({
      voice: { voiceId },
      illustratedAssets: {},
      visualBeatAssets: {},
    }),
  );

  validateGraph(controlGraph, { registry, transformations });
  validateGraph(benchmarkGraph, { registry, transformations });

  const providers = new ProviderRouter({
    reasoning_high: new OpenAIProvider({ effort: "medium" }),
    reasoning_fast: new OpenAIProvider({ effort: "medium" }),
  });
  const runner = new Runner({
    store,
    registry,
    prompts,
    providers,
    runLog,
    blobs,
    media: { speech, images, renderer },
    logger: console,
  });
  const executor = new GraphExecutor({ runner, runLog, store, registry, transformations, logger: console });

  const intent = await store.put({
    schema_id: "intent",
    payload: {
      brief: "Explain the true scale difference between a million, a billion, and a trillion using time and distance analogies. The visual benchmark must make every numerical jump immediately understandable and avoid decorative filler.",
      niche: "numbers-and-scale",
      target_duration_sec: 105,
      image_style: "documentary_sketch",
      constraints: [
        "Prefer concrete visual explanation over generic atmosphere.",
        "No publication or outbound side effects.",
        "Use the supplied script verbatim so control and candidate are directly comparable.",
      ],
    },
    produced_by: { transformation: "human", version: "1", run_id: "rfc0010-benchmark-seed", provider: null },
  });

  const script = await store.put({
    schema_id: "script",
    payload: { scenes: SCENES, word_count: WORD_COUNT },
    produced_by: { transformation: "human", version: "1", run_id: "rfc0010-benchmark-seed", provider: null },
  });

  console.log("=== RFC 0010 BENCHMARK SOURCE ===");
  console.log(`script=${script.artifact.artifact_id}`);
  console.log(`words=${WORD_COUNT}`);
  console.log(`text_model=${textModel}`);
  console.log(`images=${images.id}`);
  console.log(`speech=${speech.id}`);
  console.log(`renderer=${renderer.id}`);

  const control = await executor.start(controlGraph, {
    intent: intent.artifact.artifact_id,
    script: script.artifact.artifact_id,
  });
  await assertRun("production control", control);

  const voiceIdArtifact = control.outputs["voice"];
  const controlRenderId = control.outputs["control_render"];
  if (!voiceIdArtifact || !controlRenderId) throw new Error("control graph completed without voice/control_render outputs");

  console.log("\n=== CONTROL COMPLETE ===");
  console.log(`voice=${voiceIdArtifact}`);
  console.log(`control_render=${controlRenderId}`);

  const benchmark = await executor.start(benchmarkGraph, {
    script: script.artifact.artifact_id,
    voice: voiceIdArtifact,
    control_render: controlRenderId,
  });
  await assertRun("RFC 0010 candidate", benchmark);

  const candidateRenderId = benchmark.outputs["candidate_render"];
  const reportId = benchmark.outputs["benchmark_report"];
  if (!candidateRenderId || !reportId) throw new Error("benchmark completed without candidate_render/benchmark_report outputs");

  const controlRender = await store.require(controlRenderId, { schema_id: "rendered_video" });
  const candidateRender = await store.require(candidateRenderId, { schema_id: "rendered_video" });
  const report = await store.require(reportId, { schema_id: "visual_benchmark_report" });
  const visualDirectionId = benchmark.outputs["visual_direction"];
  const visualAssetsId = benchmark.outputs["visual_assets"];
  const visualTimelineId = benchmark.outputs["visual_timeline"];

  const controlPayload = controlRender.payload as { video_uri: string; duration_sec?: number };
  const candidatePayload = candidateRender.payload as { video_uri: string; duration_sec?: number };
  const reportPayload = report.payload as { pass: boolean; failures: string[]; summary: Record<string, unknown>; beats: unknown[] };

  await mkdir(EXPORT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(EXPORT_DIR, "control.mp4"), await blobs.get(controlPayload.video_uri)),
    writeFile(path.join(EXPORT_DIR, "candidate-rfc0010.mp4"), await blobs.get(candidatePayload.video_uri)),
    writeFile(path.join(EXPORT_DIR, "benchmark-report.json"), JSON.stringify(reportPayload, null, 2)),
    writeFile(path.join(EXPORT_DIR, "script.json"), JSON.stringify({ word_count: WORD_COUNT, scenes: SCENES }, null, 2)),
  ]);

  const diagnostics: Record<string, unknown> = {};
  for (const [name, artifactId] of [
    ["visual-direction", visualDirectionId],
    ["visual-assets", visualAssetsId],
    ["visual-timeline", visualTimelineId],
  ] as const) {
    if (!artifactId) continue;
    const artifact = await store.get(artifactId);
    if (!artifact) continue;
    diagnostics[name] = artifact.payload;
    await writeFile(path.join(EXPORT_DIR, `${name}.json`), JSON.stringify(artifact.payload, null, 2));
  }

  const controlUsage = rollup((await runLog.all()).filter((row) => row.run_id === control.run_id));
  const benchmarkUsage = rollup((await runLog.all()).filter((row) => row.run_id === benchmark.run_id));
  const manifest = {
    generated_at: new Date().toISOString(),
    source: {
      topic: "How big is a billion?",
      word_count: WORD_COUNT,
      target_duration_sec: 105,
      script_artifact_id: script.artifact.artifact_id,
      voice_artifact_id: voiceIdArtifact,
      control_render_artifact_id: controlRenderId,
      candidate_render_artifact_id: candidateRenderId,
      benchmark_report_artifact_id: reportId,
    },
    providers: {
      text_model: textModel,
      image_provider: images.id,
      speech_provider: speech.id,
      renderer: renderer.id,
      generated_video_model: env("FAL_TEXT_TO_VIDEO_MODEL") ?? "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    },
    costs: {
      control_llm_cost_usd: controlUsage.cost_usd,
      benchmark_llm_cost_usd: benchmarkUsage.cost_usd,
      note: "Media-provider charges are not fully represented by the LLM run-log rollup.",
    },
    result: reportPayload,
  };
  await writeFile(path.join(EXPORT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log("\n=== RFC 0010 RESULT ===");
  console.log(`candidate_render=${candidateRenderId}`);
  console.log(`benchmark_report=${reportId}`);
  console.log(`RESULT=${reportPayload.pass ? "PASS" : "FAIL"}`);
  console.table(reportPayload.summary);
  if (reportPayload.failures.length) {
    console.log("kill-gate failures:");
    for (const failure of reportPayload.failures) console.log(`  - ${failure}`);
  }
  const bank = images.stats();
  console.log(`image_bank: ${bank.hits} reused, ${bank.misses} newly generated (${env("IMAGE_BANK_DIR") ?? "ephemeral"})`);
  console.log(`export_dir=${EXPORT_DIR}`);
  // A failed quality gate is a valid benchmark result and must still upload its
  // videos/report. Only technical execution failures exit non-zero.
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
