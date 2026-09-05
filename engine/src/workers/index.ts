/**
 * Worker registry.
 *
 * Agents load from disk as data (RFC 0003); workers are code and register here.
 * That asymmetry is intentional: reasoning should be cheap to add, side effects
 * should not be.
 */

import type { TransformationDef } from "../runner.ts";
import { makeVoiceWorker, type VoiceWorkerOptions } from "./voice.ts";
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
import { makeVisualAssetReleaseWorker } from "./visual-asset-release.ts";

export {
  makeVoiceWorker,
  makeAssetWorker,
  makeRenderWorker,
  makeThumbnailWorker,
  makePublishWorker,
  makeMeasureWorker,
  makeQaWorker,
  makeGrowthPackageReleaseWorker,
  makeWatchabilityReleaseWorker,
  makeIllustratedSceneAssetsWorker,
  makeVisualBeatAssetsWorker,
  makeVisualAssetReleaseWorker,
};
export { buildPrompt } from "./assets.ts";

export interface WorkerSetOptions {
  voice: VoiceWorkerOptions;
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
    makeVoiceWorker(opts.voice),
    makeAssetWorker(opts.assets ?? {}),
    // RFC 0009 remains the production control until RFC 0010 passes its rendered
    // comparison benchmark.
    makeIllustratedSceneAssetsWorker(opts.illustratedAssets ?? {}),
    // RFC 0010 resolves on measured ElevenLabs timing and emits an isolated
    // beat-level asset artifact; it cannot change production by itself.
    makeVisualBeatAssetsWorker(opts.visualBeatAssets ?? {}),
    makeVisualAssetReleaseWorker(),
    makeRenderWorker(opts.render ?? {}),
    makeThumbnailWorker(opts.thumbnail ?? {}),
    makeMeasureWorker(opts.measure ?? {}),
    makeQaWorker(opts.qa ?? {}),
    ...(opts.publish ? [makePublishWorker(opts.publish)] : []),
  ];
  return new Map(workers.map((worker) => [worker.name, worker]));
}

export function allTransformations(
  agents: Map<string, TransformationDef>,
  workers: Map<string, TransformationDef>,
): Map<string, TransformationDef> {
  const merged = new Map(agents);
  for (const [name, def] of workers) {
    if (merged.has(name)) {
      throw new Error(`transformation "${name}" is registered as both an agent and a worker`);
    }
    merged.set(name, def);
  }
  return merged;
}
