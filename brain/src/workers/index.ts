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

export { makeVoiceWorker, makeAssetWorker };
export { buildPrompt } from "./assets.ts";

export interface WorkerSetOptions {
  voice: VoiceWorkerOptions;
  assets?: AssetWorkerOptions;
}

export function defaultWorkers(opts: WorkerSetOptions): Map<string, TransformationDef> {
  const workers: TransformationDef[] = [
    makeVoiceWorker(opts.voice),
    makeAssetWorker(opts.assets ?? {}),
  ];
  return new Map(workers.map((w) => [w.name, w]));
}

/** Agents (from disk) plus workers (from code), as one lookup for the executor. */
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
