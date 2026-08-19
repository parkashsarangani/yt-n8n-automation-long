/**
 * Worker registry.
 *
 * Agents load from disk as data (RFC 0003); workers are code and register here.
 * That asymmetry is intentional: reasoning should be cheap to add, side effects
 * should not be.
 */

import type { TransformationDef } from "../runner.ts";
import { makeVoiceWorker, type VoiceWorkerOptions, makeDialogueVoiceWorker, type DialogueVoiceWorkerOptions } from "./voice.ts";
import { makeAssetWorker, type AssetWorkerOptions } from "./assets.ts";
import { makeRenderWorker, type RenderWorkerOptions } from "./render.ts";
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
  makeThumbnailWorker,
  makePublishWorker,
  makeMeasureWorker,
  makeQaWorker,
  makeCastLoaderWorker,
};
export { buildPrompt } from "./assets.ts";

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
    // The default production graph is cartoon-first and always references
    // dialogue_voice. Register it even in lightweight test/smoke harnesses that
    // only supplied the historical single-voice option; the single-voice id is
    // a deterministic last-resort fallback when the cast has no matching voice.
    makeDialogueVoiceWorker(opts.dialogueVoice ?? { defaultVoiceId: opts.voice.voiceId }),
    makeAssetWorker(opts.assets ?? {}),
    makeRenderWorker(opts.render ?? {}),
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
