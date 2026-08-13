/**
 * Asset collector worker: visual_plan -> asset_manifest.
 *
 * A worker, not an agent: the visual *decisions* were already made by the
 * visual_planner. This just turns terms into a prompt and fetches images.
 *
 * Implements the three-rung failure ladder proven in the long-form pipeline —
 * primary terms, then fallback terms, then a placeholder. A single scene
 * failing must never fail the whole video; instead it is recorded as degraded
 * so the quality gauge is measurable rather than invisible.
 */

import type { BlobRef } from "../artifact.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import type { Aspect } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface AssetWorkerOptions {
  aspect?: Aspect;
  /** Long-form fans out to 40-80 images; never unbounded. */
  concurrency?: number;
  housePrefix?: string;
  version?: string;
}

interface PlanScene {
  scene_index: number;
  search_terms: string[];
  visual_style: string;
  fallback_terms: string[];
}

const DEFAULT_PREFIX =
  "Cinematic still frame, photorealistic, dramatic lighting, shallow depth of field.";
const NEGATIVE = "No text, no words, no letters, no captions, no watermark, no logos, no UI elements.";

export function buildPrompt(terms: string[], style: string, prefix = DEFAULT_PREFIX): string {
  return `${prefix} ${terms.join(", ")}. ${style}. ${NEGATIVE}`;
}

export function makeAssetWorker(opts: AssetWorkerOptions = {}): WorkerDef {
  const aspect: Aspect = opts.aspect ?? "9:16";
  const prefix = opts.housePrefix ?? DEFAULT_PREFIX;

  return {
    name: "asset_collector",
    kind: "worker",
    version: opts.version ?? "1",
    consumes: [{ schema_id: "visual_plan", range: "^1", as: "plan" }],
    produces: "asset_manifest",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const images = ctx.media.images;
      if (!images) {
        throw new Error("asset_collector requires an image provider (media.images)");
      }

      const scenes = (inputs["plan"]!.payload as { scenes: PlanScene[] }).scenes;
      const ordered = [...scenes].sort((a, b) => a.scene_index - b.scene_index);
      const blobs: BlobRef[] = [];

      const results = await mapWithConcurrency(ordered, opts.concurrency ?? 4, async (scene) => {
        const attempts: Array<{ source: "primary" | "fallback"; terms: string[] }> = [
          { source: "primary", terms: scene.search_terms },
          { source: "fallback", terms: scene.fallback_terms },
        ];

        for (const attempt of attempts) {
          if (attempt.terms.length === 0) continue;
          const prompt = buildPrompt(attempt.terms, scene.visual_style, prefix);
          try {
            const out = await images.generate({ prompt, aspect, count: 1 });
            const first = out.images[0];
            if (!first) throw new Error("provider returned no image");
            const ref = await ctx.blobs.put(first.bytes, {
              role: "image",
              media_type: first.media_type,
            });
            return {
              entry: {
                scene_index: scene.scene_index,
                image_uri: ref.uri,
                source: attempt.source,
                prompt,
              },
              blob: ref,
            };
          } catch (err) {
            ctx.logger.warn(
              `[asset_collector] scene ${scene.scene_index} ${attempt.source} attempt failed: ` +
              `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Both rungs failed. Degrade, do not fail the run: downstream renders a
        // house-style placeholder for scenes with no image_uri.
        ctx.logger.warn(`[asset_collector] scene ${scene.scene_index} degraded to placeholder`);
        return {
          entry: {
            scene_index: scene.scene_index,
            source: "placeholder" as const,
            prompt: buildPrompt(scene.search_terms, scene.visual_style, prefix),
          },
          blob: null,
        };
      });

      for (const r of results) if (r.blob) blobs.push(r.blob);

      return {
        payload: {
          scenes: results.map((r) => r.entry),
          degraded_count: results.filter((r) => r.entry.source === "placeholder").length,
        },
        blobs,
      };
    },
  };
}
