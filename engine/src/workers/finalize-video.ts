/**
 * Finalize-video worker: passes the draft render through unchanged.
 *
 * This node only ever actually runs when no edited cut was supplied. When the
 * editor-watch poller finds the editor's returned file, it stores it directly
 * as THIS node's preset output (see GraphExecutor.runNode's presetOutputs
 * handling) -- the executor skips calling this worker entirely in that case.
 * So the only job here is: draft in, identical rendered_video artifact out.
 */
import type { Artifact, BlobRef } from "../artifact.ts";
import type { WorkerDef, WorkerOutput } from "../runner.ts";

export interface FinalizeVideoWorkerOptions {
  version?: string;
}

export function makeFinalizeVideoWorker(opts: FinalizeVideoWorkerOptions = {}): WorkerDef {
  return {
    name: "finalize_video",
    kind: "worker",
    version: opts.version ?? "1",
    consumes: [
      { schema_id: "editor_handoff", range: "^1", as: "editor_review" },
      { schema_id: "rendered_video", range: "^1", as: "render" },
    ],
    produces: "rendered_video",
    async execute(inputs: Record<string, Artifact>): Promise<WorkerOutput> {
      const render = inputs["render"]!;
      return {
        payload: render.payload,
        blobs: (render.blobs ?? []) as BlobRef[],
      };
    },
  };
}
