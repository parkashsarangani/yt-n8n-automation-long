/**
 * Asset collector worker: visual_plan -> asset_manifest.
 *
 * Cartoon/template scenes are render instructions, not media-search requests.
 * Their render props (template_props for cartoon, template_data for the 7
 * motion-graphics templates) are validated at this boundary and passed through
 * without spending on an image provider. Legacy non-template scenes retain the
 * old media fallback ladder for historical/manual artifacts.
 */

import type { BlobRef } from "../artifact.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import type { Aspect } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface AssetWorkerOptions {
  aspect?: Aspect;
  concurrency?: number;
  housePrefix?: string;
  version?: string;
}

interface PlanScene {
  scene_index: number;
  search_terms: string[];
  visual_style: string;
  fallback_terms: string[];
  template_category?: string;
  template_data?: string;
  template_props?: Record<string, unknown>;
}

const DEFAULT_PREFIX = "";

export function buildPrompt(terms: string[], _style: string, _prefix = DEFAULT_PREFIX): string {
  return terms.join(", ");
}

function parseTemplateData(scene: PlanScene): Record<string, unknown> {
  if (scene.template_category === "cartoon") {
    return validateCartoonProps(scene);
  }

  if (!scene.template_data?.trim()) {
    throw new Error(
      `scene ${scene.scene_index}: template_category="${scene.template_category}" requires template_data`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(scene.template_data);
  } catch (err) {
    throw new Error(
      `scene ${scene.scene_index}: template_data is invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`scene ${scene.scene_index}: template_data must decode to a JSON object`);
  }

  return parsed as Record<string, unknown>;
}

/**
 * Cartoon scenes carry their render props as a native `template_props` object
 * (visual_plan@1.4.0+) rather than a hand-escaped JSON string in
 * `template_data`. Structured-output providers enforce object/array shape at
 * generation time, so this field can't arrive malformed the way a string
 * field could - the schema itself is the first line of defense here.
 */
function validateCartoonProps(scene: PlanScene): Record<string, unknown> {
  const data = scene.template_props as
    | {
        background?: unknown;
        characters?: Array<{ characterId?: unknown; x?: unknown; y?: unknown; scale?: unknown; isSpeaking?: unknown }>;
      }
    | undefined;

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`scene ${scene.scene_index}: template_category="cartoon" requires template_props`);
  }
  if (!data.background || typeof data.background !== "object") {
    throw new Error(`scene ${scene.scene_index}: cartoon template_props requires background`);
  }
  if (!Array.isArray(data.characters) || data.characters.length === 0) {
    throw new Error(`scene ${scene.scene_index}: cartoon template_props requires at least one character`);
  }
  if (data.characters.length > 4) {
    throw new Error(`scene ${scene.scene_index}: cartoon scene has ${data.characters.length} characters; maximum is 4`);
  }
  for (const [i, c] of data.characters.entries()) {
    if (!c || typeof c.characterId !== "string" || !c.characterId.trim()) {
      throw new Error(`scene ${scene.scene_index}: character ${i} has no characterId/rig`);
    }
    // typeof must be checked before Number(...): Number(null) and Number("")
    // both coerce to 0 (finite), which would silently accept a missing/blank
    // coordinate as "0" instead of rejecting it as the validation intends.
    if (typeof c.x !== "number" || !Number.isFinite(c.x) || typeof c.y !== "number" || !Number.isFinite(c.y)) {
      throw new Error(`scene ${scene.scene_index}: character ${i} needs numeric x/y staging coordinates`);
    }
    if (c.scale !== undefined) {
      const scale = Number(c.scale);
      if (!Number.isFinite(scale) || scale < 0.35 || scale > 2.5) {
        throw new Error(`scene ${scene.scene_index}: character ${i} scale ${String(c.scale)} is outside 0.35..2.5`);
      }
    }
  }
  const speakers = data.characters.filter((c) => c.isSpeaking === true).length;
  if (speakers > 1) {
    throw new Error(`scene ${scene.scene_index}: ${speakers} characters are marked isSpeaking; one dialogue line may have at most one active speaker`);
  }

  return data as Record<string, unknown>;
}

export function makeAssetWorker(opts: AssetWorkerOptions = {}): WorkerDef {
  const aspect: Aspect = opts.aspect ?? "16:9";
  const prefix = opts.housePrefix ?? DEFAULT_PREFIX;

  return {
    name: "asset_collector",
    kind: "worker",
    version: opts.version ?? "4",
    consumes: [{ schema_id: "visual_plan", range: "^1", as: "plan" }],
    produces: "asset_manifest",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const scenes = (inputs["plan"]!.payload as { scenes: PlanScene[] }).scenes;
      const ordered = [...scenes].sort((a, b) => a.scene_index - b.scene_index);
      const blobs: BlobRef[] = [];

      const results = await mapWithConcurrency(ordered, opts.concurrency ?? 4, async (scene) => {
        if (scene.template_category) {
          const templateData = parseTemplateData(scene);
          return {
            entry: {
              scene_index: scene.scene_index,
              source: "template" as const,
              template_category: scene.template_category,
              template_data: JSON.stringify(templateData),
            },
            blob: null,
          };
        }

        // Historical/manual non-template scene. The cartoon-first production
        // graph never reaches this branch, so an image provider is only needed
        // if such a legacy scene is actually present.
        const images = ctx.media.images;
        if (!images) {
          throw new Error(
            `scene ${scene.scene_index}: non-template visual needs an image provider; cartoon scenes should use template_category="cartoon"`,
          );
        }

        const attempts: Array<{ source: "primary" | "fallback"; terms: string[] }> = [
          { source: "primary", terms: scene.search_terms },
          { source: "fallback", terms: scene.fallback_terms },
        ];

        for (const attempt of attempts) {
          if (attempt.terms.length === 0) continue;
          const prompt = buildPrompt(attempt.terms, scene.visual_style, prefix);

          if (images.generateVideo) {
            try {
              const out = await images.generateVideo({ prompt, aspect });
              if (out) {
                const ref = await ctx.blobs.put(out.video.bytes, {
                  role: "video",
                  media_type: out.video.media_type,
                });
                return {
                  entry: {
                    scene_index: scene.scene_index,
                    video_uri: ref.uri,
                    source: attempt.source,
                    prompt,
                  },
                  blob: ref,
                };
              }
            } catch (err) {
              ctx.logger.warn(
                `[asset_collector] scene ${scene.scene_index} ${attempt.source} video attempt failed: ` +
                `${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

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
