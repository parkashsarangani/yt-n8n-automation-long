/** Worker registry: agents reason; workers own deterministic effects. */
import type { TransformationDef } from "../runner.ts";
import { makeVoiceWorker, type VoiceWorkerOptions } from "./voice.ts";
import { makeTtsModerationWorker, type TtsModerationWorkerOptions } from "./tts-moderation.ts";
import { makeAssetWorker, type AssetWorkerOptions } from "./assets.ts";
import { makeRenderWorker, type RenderWorkerOptions } from "./render.ts";
import { makeThumbnailWorker, type ThumbnailWorkerOptions } from "./thumbnail.ts";
import { makePublishWorker, type PublishWorkerOptions } from "./publish.ts";
import { makeMeasureWorker, type MeasureWorkerOptions } from "./measure.ts";
import { makeQaWorker, type QaWorkerOptions } from "./qa.ts";
import { makeGrowthPackageReleaseWorker } from "./growth-package-release.ts";
import { makeWatchabilityReleaseWorker } from "./watchability-release.ts";
import { makeIllustratedSceneAssetsWorker, type IllustratedSceneAssetsWorkerOptions } from "./illustrated-scene-assets.ts";
import { makeVisualBeatAssetsWorker, type VisualBeatAssetsWorkerOptions } from "./visual-beat-resolver.ts";
import { makeVisualTimelineWorker } from "./visual-timeline.ts";
import { makeVisualTimelineRenderWorker } from "./visual-timeline-render.ts";
import { makeVisualTimelineManifestWorker } from "./visual-timeline-manifest.ts";
import { makeVisualBeatReleaseWorker } from "./visual-beat-release.ts";
import { makeVisualBenchmarkRenderWorker } from "./visual-benchmark-render.ts";
import { makeVisualBenchmarkQaWorker } from "./visual-benchmark-qa.ts";
import { makeVisualAssetReleaseWorker } from "./visual-asset-release.ts";

export {
  makeVoiceWorker, makeTtsModerationWorker, makeAssetWorker, makeRenderWorker, makeThumbnailWorker,
  makePublishWorker, makeMeasureWorker, makeQaWorker,
  makeGrowthPackageReleaseWorker, makeWatchabilityReleaseWorker,
  makeIllustratedSceneAssetsWorker, makeVisualBeatAssetsWorker,
  makeVisualTimelineWorker, makeVisualTimelineRenderWorker, makeVisualTimelineManifestWorker,
  makeVisualBeatReleaseWorker,
  makeVisualBenchmarkRenderWorker, makeVisualBenchmarkQaWorker,
  makeVisualAssetReleaseWorker,
};
export { buildPrompt } from "./assets.ts";

export interface WorkerSetOptions {
  voice: VoiceWorkerOptions;
  ttsModeration?: TtsModerationWorkerOptions;
  assets?: AssetWorkerOptions;
  illustratedAssets?: IllustratedSceneAssetsWorkerOptions;
  visualBeatAssets?: VisualBeatAssetsWorkerOptions;
  render?: RenderWorkerOptions;
  thumbnail?: ThumbnailWorkerOptions;
  measure?: MeasureWorkerOptions;
  qa?: QaWorkerOptions;
  publish?: PublishWorkerOptions;
}

export function defaultWorkers(opts: WorkerSetOptions): Map<string, TransformationDef> {
  const workers: TransformationDef[] = [
    makeGrowthPackageReleaseWorker(),
    makeWatchabilityReleaseWorker(),
    makeTtsModerationWorker(opts.ttsModeration ?? {}),
    // Production/default registration always enforces an approved moderation
    // artifact. Direct unit fixtures can still instantiate makeVoiceWorker()
    // without requireModeration when they are not making a real TTS call.
    makeVoiceWorker({ ...opts.voice, requireModeration: true }),
    makeAssetWorker(opts.assets ?? {}),
    // Legacy/manual compatibility worker. The production illustrated_story
    // graph now uses the RFC 0010 visual director/resolver/timeline stack.
    makeIllustratedSceneAssetsWorker(opts.illustratedAssets ?? {}),
    makeVisualBeatAssetsWorker(opts.visualBeatAssets ?? {}),
    makeVisualTimelineWorker(),
    makeVisualTimelineManifestWorker(),
    makeVisualBeatReleaseWorker(),
    makeVisualTimelineRenderWorker(),
    // Benchmark-only helpers remain available for explicit comparison runs;
    // they are not a second production visual implementation.
    makeVisualBenchmarkRenderWorker(),
    makeVisualBenchmarkQaWorker(),
    makeVisualAssetReleaseWorker(),
    makeRenderWorker(opts.render ?? {}),
    makeThumbnailWorker(opts.thumbnail ?? {}),
    makeMeasureWorker(opts.measure ?? {}),
    makeQaWorker(opts.qa ?? {}),
    ...(opts.publish ? [makePublishWorker(opts.publish)] : []),
  ];
  return new Map(workers.map((worker) => [worker.name, worker]));
}

export function allTransformations(agents: Map<string, TransformationDef>, workers: Map<string, TransformationDef>): Map<string, TransformationDef> {
  const merged = new Map(agents);
  for (const [name, def] of workers) {
    if (merged.has(name)) throw new Error(`transformation "${name}" is registered as both an agent and a worker`);
    merged.set(name, def);
  }
  return merged;
}
