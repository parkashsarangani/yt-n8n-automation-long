/**
 * Fast RFC 0010 development harness.
 *
 * Freeze what RFC 0010 is not trying to improve:
 *   - one fixed, route-diverse script
 *   - one cached ElevenLabs narration + alignment fixture
 *
 * Keep the actual visual system live:
 *   - Visual Director
 *   - Pexels retrieval + exact segment selection
 *   - fal image/video generation
 *   - deterministic motion graphics
 *   - multimodal candidate gates
 *   - timeline construction, render, rendered-frame QA
 *
 * This is a development smoke test, not a substitute for the 90-120 second
 * control-vs-candidate acceptance benchmark.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FsBlobStore } from "../src/blobs.ts";
import { GraphExecutor, type GraphRunResult } from "../src/executor.ts";
import { loadGraph, validateGraph } from "../src/graph.ts";
import { loadAgentDefs, validateCatalog } from "../src/catalog.ts";
import { sampleRenderedFrames, type TimedFrame } from "../src/media/render-frame-sampler.ts";
import { PromptStore } from "../src/prompts.ts";
import { ComposeRenderer } from "../src/providers/compose.ts";
import { ElevenLabsProvider } from "../src/providers/elevenlabs.ts";
import { FalImageProvider } from "../src/providers/fal.ts";
import { OpenAIProvider } from "../src/providers/openai.ts";
import { ProviderRouter } from "../src/provider.ts";
import { SchemaRegistry } from "../src/registry.ts";
import { Runner, type TransformationDef } from "../src/runner.ts";
import { JsonlRunLog } from "../src/runlog.ts";
import { FsArtifactStore } from "../src/store.ts";
import { scoreVisualBeatFrames, type QaImage } from "../src/visual-beat-qa.ts";
import type { VisualBeat, VisualBeatPlan } from "../src/visual-routing.ts";
import { evaluateVisualSmoke, type VisualSmokeRenderedBeat, type VisualSmokeResolvedBeat } from "../src/visual-smoke.ts";
import { allTransformations, defaultWorkers } from "../src/workers/index.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env["AMOS_DATA"] ?? path.join(ROOT, ".vidgen-data");
const EXPORT_DIR = process.env["RFC0010_SMOKE_EXPORT_DIR"] ?? path.join(DATA, "rfc0010-live-media-smoke-export");
const FIXTURE_CACHE = process.env["RFC0010_SMOKE_FIXTURE_CACHE"] ?? path.join(DATA, "rfc0010-smoke-fixtures");

const SCENES = [
  {
    scene_index: 0,
    point: "Authentic modern physical action for stock-video retrieval: a real commuter sends a phone message while moving through a train station.",
    visual_intent: "Prefer authentic stock footage of the exact action/environment over generic phone imagery.",
    narration: "A commuter taps send while walking through a busy train station. The message can cross the city and reach another phone before that person even reaches the platform.",
  },
  {
    scene_index: 1,
    point: "Historically specific physical scene where stock is unlikely to be exact and a realistic generated image should be stronger.",
    visual_intent: "Show a historically plausible mounted courier physically carrying a message across an ancient landscape; avoid modern objects and generic portraits.",
    narration: "Two thousand years ago, the same message might travel with a mounted courier. A sealed note, a horse, a road, and hours or days of physical travel replaced the instant electronic hop.",
  },
  {
    scene_index: 2,
    point: "Quantitative comparison that should be explained with authored motion graphics rather than decorative B-roll.",
    visual_intent: "Use a clear distance-versus-time comparison or animated scale showing walking, horse travel, and electronic delivery.",
    narration: "Put the speeds on one scale. Walking at five kilometers an hour covers twenty kilometers in four hours. A phone message can cover that distance in a fraction of a second.",
  },
  {
    scene_index: 3,
    point: "Payoff that returns to the authentic modern action and visually contrasts it with the historical journey without losing continuity.",
    visual_intent: "Return to a real station/phone action or a strong generated transition only if it materially improves the contrast; no generic technology montage.",
    narration: "That is the transformation: the information no longer has to travel at the speed of the person carrying it. The commuter keeps walking, while the message has already arrived.",
    is_outro: true,
  },
] as const;

const WORD_COUNT = SCENES.reduce((sum, scene) => sum + scene.narration.trim().split(/\s+/).length, 0);

type VoiceClip = {
  scene_index: number;
  audio_uri: string;
  alignment_uri?: string;
  duration_sec: number;
  media_type?: string;
};
type VoicePayload = { voice_id: string; clips: VoiceClip[]; total_duration_sec?: number };
type CachedVoice = {
  version: 1;
  cache_key: string;
  voice_id: string;
  total_duration_sec: number;
  clips: Array<{
    scene_index: number;
    duration_sec: number;
    media_type: string;
    audio_file: string;
    alignment_file?: string;
  }>;
};
type TimelineBeat = {
  id: string;
  ordinal: number;
  absolute_start_sec: number;
  absolute_end_sec: number;
  continuity_group: string;
};
type VisualTimeline = { beats: TimelineBeat[]; total_duration_sec: number };
type ResolvedAssets = { beats: VisualSmokeResolvedBeat[]; summary: Record<string, unknown> };
type RenderedVideo = { video_uri: string; duration_sec?: number };

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`${name} is required for the RFC 0010 live-media smoke test`);
  return value;
}

function boolEnv(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(env(name) ?? "");
}

function fixtureKey(voiceId: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ voice_id: voiceId, scenes: SCENES.map(({ scene_index, narration }) => ({ scene_index, narration })) }))
    .digest("hex")
    .slice(0, 24);
}

async function assertRun(name: string, result: GraphRunResult): Promise<void> {
  if (result.failures.length) {
    throw new Error(`${name} failed: ${result.failures.map((failure) => `${failure.node_id}: ${failure.error}`).join(" | ")}`);
  }
  if (result.waiting.length) {
    throw new Error(`${name} unexpectedly stopped at human gate(s): ${result.waiting.map((waiting) => waiting.node_id).join(", ")}`);
  }
}

function clampTime(value: number, end: number): number {
  return Math.max(0, Math.min(value, Math.max(0, end - 0.04)));
}

function beatTimes(beat: TimelineBeat, total: number): number[] {
  const duration = Math.max(0.12, beat.absolute_end_sec - beat.absolute_start_sec);
  return [0.2, 0.5, 0.8].map((ratio) => clampTime(beat.absolute_start_sec + duration * ratio, total));
}

function group(frames: TimedFrame[], index: number): QaImage[] {
  return frames.slice(index * 3, index * 3 + 3).map(({ bytes, media_type }) => ({ bytes, media_type }));
}

async function writeVoiceCache(cacheDir: string, voice: VoicePayload, blobs: FsBlobStore, cacheKey: string): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const clips: CachedVoice["clips"] = [];
  for (const clip of voice.clips) {
    const audioFile = `scene-${clip.scene_index}.audio`;
    await writeFile(path.join(cacheDir, audioFile), await blobs.get(clip.audio_uri));
    let alignmentFile: string | undefined;
    if (clip.alignment_uri) {
      alignmentFile = `scene-${clip.scene_index}.alignment.json`;
      await writeFile(path.join(cacheDir, alignmentFile), await blobs.get(clip.alignment_uri));
    }
    clips.push({
      scene_index: clip.scene_index,
      duration_sec: clip.duration_sec,
      media_type: clip.media_type ?? "audio/mpeg",
      audio_file: audioFile,
      ...(alignmentFile ? { alignment_file: alignmentFile } : {}),
    });
  }
  const manifest: CachedVoice = {
    version: 1,
    cache_key: cacheKey,
    voice_id: voice.voice_id,
    total_duration_sec: voice.total_duration_sec ?? voice.clips.reduce((sum, clip) => sum + clip.duration_sec, 0),
    clips,
  };
  await writeFile(path.join(cacheDir, "voice.json"), JSON.stringify(manifest, null, 2));
}

async function importVoiceCache(
  cacheDir: string,
  store: FsArtifactStore,
  blobs: FsBlobStore,
  scriptId: string,
): Promise<string | null> {
  let cached: CachedVoice;
  try {
    cached = JSON.parse(await readFile(path.join(cacheDir, "voice.json"), "utf8")) as CachedVoice;
  } catch {
    return null;
  }
  if (cached.version !== 1) return null;
  const clips: VoiceClip[] = [];
  for (const clip of cached.clips) {
    const audio = await blobs.put(await readFile(path.join(cacheDir, clip.audio_file)), { role: "audio", media_type: clip.media_type });
    let alignmentUri: string | undefined;
    if (clip.alignment_file) {
      const alignment = await blobs.put(await readFile(path.join(cacheDir, clip.alignment_file)), { role: "alignment", media_type: "application/json" });
      alignmentUri = alignment.uri;
    }
    clips.push({
      scene_index: clip.scene_index,
      audio_uri: audio.uri,
      duration_sec: clip.duration_sec,
      media_type: clip.media_type,
      ...(alignmentUri ? { alignment_uri: alignmentUri } : {}),
    });
  }
  const stored = await store.put({
    schema_id: "voice",
    payload: { voice_id: cached.voice_id, clips, total_duration_sec: cached.total_duration_sec },
    produced_by: { transformation: "voice", version: "fixture-cache-v1", run_id: `rfc0010-smoke-cache-${cached.cache_key}`, provider: "cached-elevenlabs" },
    parents: [scriptId],
  });
  return stored.artifact.artifact_id;
}

async function getVoiceFixture(args: {
  runner: Runner;
  transformations: Map<string, TransformationDef>;
  store: FsArtifactStore;
  blobs: FsBlobStore;
  scriptId: string;
  voiceId: string;
}): Promise<{ artifactId: string; source: "cache" | "generated"; cacheKey: string }> {
  const cacheKey = fixtureKey(args.voiceId);
  const cacheDir = path.join(FIXTURE_CACHE, cacheKey);
  if (!boolEnv("RFC0010_SMOKE_REFRESH_VOICE")) {
    const imported = await importVoiceCache(cacheDir, args.store, args.blobs, args.scriptId);
    if (imported) return { artifactId: imported, source: "cache", cacheKey };
  }

  const voiceDef = args.transformations.get("voice");
  if (!voiceDef) throw new Error("voice worker missing from transformation catalog");
  const generated = await args.runner.run(voiceDef, [args.scriptId], { runId: `rfc0010-smoke-voice-${Date.now()}` });
  const payload = generated.artifact.payload as VoicePayload;
  await writeVoiceCache(cacheDir, payload, args.blobs, cacheKey);
  return { artifactId: generated.artifact.artifact_id, source: "generated", cacheKey };
}

async function main(): Promise<void> {
  requireEnv("FREELLMAPI_API_KEY");
  requireEnv("FAL_KEY");
  requireEnv("PEXELS_API_KEY");
  const elevenKey = requireEnv("ELEVENLABS_API_KEY");
  const voiceId = requireEnv("ELEVENLABS_VOICE_ID");
  const composeUrl = requireEnv("COMPOSE_URL");
  const textModel = env("FREELLMAPI_TEXT_MODEL") ?? "gemini-3.5-flash";
  if (/^auto(?::|$)/i.test(textModel) || !/gemini/i.test(textModel)) {
    throw new Error(`FREELLMAPI_TEXT_MODEL must remain a concrete Gemini model; got ${textModel}`);
  }

  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const agents = (await loadAgentDefs(path.join(ROOT, "agents"))) as Map<string, TransformationDef>;
  validateCatalog(agents as never, { hasSchema: (id) => registry.has(id), hasPrompt: (ref) => prompts.has(ref) });

  const graph = await loadGraph(path.join(ROOT, "graphs", "visual_live_media_smoke.json"));
  const store = await FsArtifactStore.open(DATA, registry);
  const blobs = await FsBlobStore.open(DATA);
  const runLog = new JsonlRunLog(path.join(DATA, "runs.jsonl"));
  const speech = new ElevenLabsProvider({ apiKey: elevenKey });
  const images = new FalImageProvider({ apiKey: requireEnv("FAL_KEY") });
  const renderer = new ComposeRenderer({ baseUrl: composeUrl });
  const transformations = allTransformations(
    agents,
    defaultWorkers({ voice: { voiceId }, illustratedAssets: {}, visualBeatAssets: {} }),
  );
  validateGraph(graph, { registry, transformations });

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

  const script = await store.put({
    schema_id: "script",
    payload: { scenes: SCENES, word_count: WORD_COUNT },
    produced_by: { transformation: "human", version: "1", run_id: "rfc0010-live-media-smoke-seed", provider: null },
  });

  const voice = await getVoiceFixture({
    runner,
    transformations,
    store,
    blobs,
    scriptId: script.artifact.artifact_id,
    voiceId,
  });
  console.log("=== RFC 0010 LIVE-MEDIA SMOKE ===");
  console.log(`script=${script.artifact.artifact_id} words=${WORD_COUNT}`);
  console.log(`voice=${voice.artifactId} source=${voice.source} cache_key=${voice.cacheKey}`);
  console.log(`text_model=${textModel} images=${images.id} renderer=${renderer.id}`);

  const result = await executor.start(graph, {
    script: script.artifact.artifact_id,
    voice: voice.artifactId,
  });
  await assertRun("RFC 0010 live-media smoke", result);

  const directionId = result.outputs["visual_direction"];
  const assetsId = result.outputs["visual_assets"];
  const timelineId = result.outputs["visual_timeline"];
  const renderId = result.outputs["candidate_render"];
  if (!directionId || !assetsId || !timelineId || !renderId) {
    throw new Error("live-media smoke completed without direction/assets/timeline/render outputs");
  }

  const direction = await store.require(directionId, { schema_id: "visual_beat_plan" });
  const assets = await store.require(assetsId, { schema_id: "visual_beat_assets" });
  const timeline = await store.require(timelineId, { schema_id: "visual_timeline" });
  const render = await store.require(renderId, { schema_id: "rendered_video" });
  const plan = direction.payload as VisualBeatPlan;
  const resolved = assets.payload as ResolvedAssets;
  const timed = timeline.payload as VisualTimeline;
  const video = render.payload as RenderedVideo;

  const ordered = [...timed.beats].sort((a, b) => a.ordinal - b.ordinal);
  const planById = new Map(plan.beats.map((beat) => [beat.id, beat]));
  const videoBytes = await blobs.get(video.video_uri);
  const times = ordered.flatMap((beat) => beatTimes(beat, timed.total_duration_sec));
  const frames = await sampleRenderedFrames(videoBytes, times);
  const renderedResults: VisualSmokeRenderedBeat[] = [];

  for (let index = 0; index < ordered.length; index++) {
    const timelineBeat = ordered[index]!;
    const beat = planById.get(timelineBeat.id) as VisualBeat | undefined;
    if (!beat) throw new Error(`${timelineBeat.id}: timeline beat missing VisualBeat contract`);
    const current = group(frames, index);
    const previous = index > 0 ? group(frames, index - 1)[1] : undefined;
    const next = index + 1 < ordered.length ? group(frames, index + 1)[1] : undefined;
    const qa = await scoreVisualBeatFrames(current, beat, { ...(previous ? { previous } : {}), ...(next ? { next } : {}) });
    renderedResults.push({
      id: beat.id,
      qa_available: qa !== null,
      semantic_match: qa?.scores.semantic_match ?? 0,
      action_match: qa?.scores.action_match ?? 0,
      visual_interest: qa?.scores.visual_interest ?? 0,
      continuity: qa?.scores.continuity ?? 0,
      generic_filler: qa?.generic_filler ?? false,
      why_failure: qa?.why_failure ?? false,
      repetitive: qa?.repetitive_with_context ?? false,
      continuity_required: Boolean(beat.continuity.group || beat.continuity.entities.length),
      reason: qa?.reason ?? "rendered-frame QA unavailable",
    });
    console.log(`[smoke-qa] ${index + 1}/${ordered.length} ${beat.id}: ${qa ? "scored" : "unavailable"}`);
  }

  const report = evaluateVisualSmoke(renderedResults, resolved.beats);
  await mkdir(EXPORT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(EXPORT_DIR, "candidate-rfc0010-smoke.mp4"), videoBytes),
    writeFile(path.join(EXPORT_DIR, "script.json"), JSON.stringify({ word_count: WORD_COUNT, scenes: SCENES }, null, 2)),
    writeFile(path.join(EXPORT_DIR, "visual-direction.json"), JSON.stringify(direction.payload, null, 2)),
    writeFile(path.join(EXPORT_DIR, "visual-assets.json"), JSON.stringify(assets.payload, null, 2)),
    writeFile(path.join(EXPORT_DIR, "visual-timeline.json"), JSON.stringify(timeline.payload, null, 2)),
    writeFile(path.join(EXPORT_DIR, "smoke-report.json"), JSON.stringify(report, null, 2)),
  ]);

  const manifest = {
    generated_at: new Date().toISOString(),
    purpose: "RFC 0010 development smoke; not production acceptance",
    fixture: {
      word_count: WORD_COUNT,
      scene_count: SCENES.length,
      voice_source: voice.source,
      voice_cache_key: voice.cacheKey,
      voice_artifact_id: voice.artifactId,
    },
    live_surfaces: [
      "visual_director",
      "pexels_retrieval",
      "fal_generation",
      "motion_graphics",
      "candidate_multimodal_gate",
      "timeline",
      "render",
      "rendered_frame_qa",
    ],
    providers: {
      text_model: textModel,
      image_provider: images.id,
      renderer: renderer.id,
      generated_video_model: env("FAL_TEXT_TO_VIDEO_MODEL") ?? "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    },
    artifacts: { direction: directionId, assets: assetsId, timeline: timelineId, render: renderId },
    result: report,
  };
  await writeFile(path.join(EXPORT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log("\n=== RFC 0010 LIVE-MEDIA SMOKE RESULT ===");
  console.log(`SMOKE_RESULT=${report.pass ? "PASS" : "FAIL"}`);
  console.table(report.summary);
  for (const [category, failures] of [
    ["technical", report.technical_failures],
    ["sourcing", report.sourcing_failures],
    ["coverage", report.coverage_failures],
    ["quality", report.quality_failures],
  ] as const) {
    for (const failure of failures) console.log(`  ${category}: ${failure}`);
  }
  for (const warning of report.warnings) console.log(`  warning: ${warning}`);
  console.log(`export_dir=${EXPORT_DIR}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
