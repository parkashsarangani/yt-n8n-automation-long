/**
 * Worker registry.
 *
 * Agents load from disk as data (RFC 0003); workers are code and register here.
 * That asymmetry is intentional: reasoning should be cheap to add, side effects
 * should not be.
 */

import type { TransformationDef, WorkerDef } from "../runner.ts";
import { makeVoiceWorker, type VoiceWorkerOptions, makeDialogueVoiceWorker, type DialogueVoiceWorkerOptions } from "./voice.ts";
import { makeAssetWorker, type AssetWorkerOptions } from "./assets.ts";
import { makeCartoonSceneCompilerWorker as makeV15CartoonSceneCompilerWorker } from "./cartoon-scenes-v15.ts";
import { makeCartoonSceneCompilerWorker as makeV16CartoonSceneCompilerWorker } from "./cartoon-scenes-v16.ts";
import { makeSemanticVisualAssetsWorker } from "./semantic-visual-assets.ts";
import { makeHybridVisualAssetsWorker } from "./hybrid-visual-assets.ts";
import { makeRenderWorker, makeCartoonRenderWorker, type RenderWorkerOptions } from "./render.ts";
import { makeThumbnailWorker, type ThumbnailWorkerOptions } from "./thumbnail.ts";
import { makePublishWorker, type PublishWorkerOptions } from "./publish.ts";
import { makeMeasureWorker, type MeasureWorkerOptions } from "./measure.ts";
import { makeQaWorker, type QaWorkerOptions } from "./qa.ts";
import { makeCastLoaderWorker } from "./cast.ts";
import { makeScriptQualityReleaseWorker } from "./script-quality-release.ts";
import { makeExplanationPlanReleaseWorker } from "./explanation-plan-release.ts";

export {
  makeVoiceWorker,
  makeDialogueVoiceWorker,
  makeAssetWorker,
  makeSemanticVisualAssetsWorker,
  makeHybridVisualAssetsWorker,
  makeRenderWorker,
  makeCartoonRenderWorker,
  makeThumbnailWorker,
  makePublishWorker,
  makeMeasureWorker,
  makeQaWorker,
  makeCastLoaderWorker,
  makeScriptQualityReleaseWorker,
  makeExplanationPlanReleaseWorker,
};
export { buildPrompt } from "./assets.ts";

/**
 * Compatibility factory for focused unit tests that exercise the compiler
 * outside the production graph. The shipped graph routes the explanation-first
 * v16 worker; semantic representation is added after voice generation by
 * semantic_visual_assets so phrase timing can use real TTS alignment.
 */
export function makeCartoonSceneCompilerWorker(): WorkerDef {
  const worker = makeV15CartoonSceneCompilerWorker();
  return {
    ...worker,
    consumes: worker.consumes.filter((input) => input.as !== "creative_direction"),
  };
}

export interface WorkerSetOptions {
  voice: VoiceWorkerOptions;
  dialogueVoice?: DialogueVoiceWorkerOptions;
  assets?: AssetWorkerOptions;
  render?: RenderWorkerOptions;
  thumbnail?: ThumbnailWorkerOptions;
  measure?: MeasureWorkerOptions;
  qa?: QaWorkerOptions;
  publish?: PublishWorkerOptions;
}

export function defaultWorkers(opts: WorkerSetOptions): Map<string, TransformationDef> {
  // hybrid_visual_assets predates semantic_visual_assets and its standalone
  // factory still declares 1.7.0 for backwards-compatible focused tests.
  // Production registration upgrades only the declared output version; the
  // payload shape is identical, and 1.8.0's producer allowlist explicitly
  // includes hybrid_visual_assets. This prevents the semantic 1.8 artifact
  // from being version-downgraded again on the final hybrid stage.
  const productionHybrid: TransformationDef = {
    ...makeHybridVisualAssetsWorker(),
    produces_version: "1.8.0",
  };

  const workers: TransformationDef[] = [
    makeCastLoaderWorker(),
    makeScriptQualityReleaseWorker(),
    makeExplanationPlanReleaseWorker(),
    makeVoiceWorker(opts.voice),
    makeDialogueVoiceWorker(opts.dialogueVoice ?? { defaultVoiceId: opts.voice.voiceId }),
    makeAssetWorker(opts.assets ?? {}),
    makeV16CartoonSceneCompilerWorker(),
    makeSemanticVisualAssetsWorker(),
    productionHybrid,
    makeRenderWorker(opts.render ?? {}),
    makeCartoonRenderWorker(opts.render ?? {}),
    makeThumbnailWorker(opts.thumbnail ?? {}),
    makeMeasureWorker(opts.measure ?? {}),
    makeQaWorker({ ...(opts.qa ?? {}), name: "qa", enforceDialogueQuality: false }),
    makeQaWorker({ ...(opts.qa ?? {}), name: "retention_qa", enforceDialogueQuality: true }),
    ...(opts.publish ? [makePublishWorker(opts.publish)] : []),
  ];
  return new Map(workers.map((w) => [w.name, w]));
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
