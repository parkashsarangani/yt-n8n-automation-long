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
import { makeRenderWorker, makeCartoonRenderWorker, type RenderWorkerOptions } from "./render.ts";
import { makeThumbnailWorker, type ThumbnailWorkerOptions } from "./thumbnail.ts";
import { makePublishWorker, type PublishWorkerOptions } from "./publish.ts";
import { makeMeasureWorker, type MeasureWorkerOptions } from "./measure.ts";
import { makeQaWorker, type QaWorkerOptions } from "./qa.ts";
import { makeCastLoaderWorker } from "./cast.ts";

export {
  makeVoiceWorker,
  makeDialogueVoiceWorker,
  makeAssetWorker,
  makeRenderWorker,
  makeCartoonRenderWorker,
  makeThumbnailWorker,
  makePublishWorker,
  makeMeasureWorker,
  makeQaWorker,
  makeCastLoaderWorker,
};
export { buildPrompt } from "./assets.ts";

/**
 * Compatibility factory for focused unit tests that exercise the compiler
 * outside the production graph. The shipped graph still routes the final v15
 * worker, including creative_direction as a first-class dependency, taste
 * gates as hard production checks, renderer-facing performance signals, and
 * post-v13 doorway staging corrections.
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
  const workers: TransformationDef[] = [
    makeCastLoaderWorker(),
    makeVoiceWorker(opts.voice),
    makeDialogueVoiceWorker(opts.dialogueVoice ?? { defaultVoiceId: opts.voice.voiceId }),
    makeAssetWorker(opts.assets ?? {}),
    makeV15CartoonSceneCompilerWorker(),
    makeRenderWorker(opts.render ?? {}),
    makeCartoonRenderWorker(opts.render ?? {}),
    makeThumbnailWorker(opts.thumbnail ?? {}),
    makeMeasureWorker(opts.measure ?? {}),
    makeQaWorker(opts.qa ?? {}),
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
