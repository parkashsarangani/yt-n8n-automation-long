/**
 * Thumbnail worker: thumbnail_brief -> thumbnail.
 *
 * Creative decisions stay in the thumbnail designer agent. This worker turns
 * its art prompt into pixels, then asks long-compose to add deterministic,
 * readable typography. AI image generation must never be responsible for the
 * actual words shown on the thumbnail.
 *
 * Failure degrades to the renderer's house background rather than blocking a
 * publish. The artifact records which rung actually shipped so weak packaging
 * can be measured instead of hidden.
 */

import type { BlobRef } from "../artifact.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface ThumbnailWorkerOptions {
  version?: string;
}

interface ThumbnailBrief {
  mode?: "cartoon";
  text: string;
  emphasis?: string;
  /** Cartoon-first complete artwork prompt. */
  art_prompt?: string;
  /** Legacy v1.0/v1.1 stock-search field. */
  background_query?: string;
  accent: string;
  rationale: string;
  visual_hook?: string;
  character_ids?: string[];
  preferred_text_side?: "left" | "right";
  alternatives?: string[];
}

export function makeThumbnailWorker(opts: ThumbnailWorkerOptions = {}): WorkerDef {
  return {
    name: "thumbnail",
    kind: "worker",
    version: opts.version ?? "2",
    consumes: [{ schema_id: "thumbnail_brief", range: "^1", as: "brief" }],
    produces: "thumbnail",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const brief = inputs["brief"]!.payload as ThumbnailBrief;

      const renderer = ctx.media.renderer;
      if (!renderer) {
        throw new Error("thumbnail worker needs a renderer; none was configured");
      }

      // v1.2 cartoon briefs provide a complete art prompt. Older artifacts can
      // still flow through their background_query so historical runs remain
      // reproducible/readable during the migration.
      const imagePrompt = brief.art_prompt?.trim() || brief.background_query?.trim();

      let background: Uint8Array | undefined;
      if (ctx.media.images && imagePrompt) {
        try {
          await ctx.progress({
            detail: brief.mode === "cartoon"
              ? `generating cartoon thumbnail artwork`
              : `thumbnail artwork: ${imagePrompt.slice(0, 120)}`,
          });
          const found = await ctx.media.images.generate({
            prompt: imagePrompt,
            aspect: "16:9",
            count: 1,
          });
          background = found.images[0]?.bytes;
          if (!background) throw new Error("image provider returned no thumbnail image");
        } catch (err) {
          // A missing custom image is measurable degradation, but should not
          // discard an otherwise publishable episode. long-compose will use
          // its deterministic house background and still render the real text.
          ctx.logger.warn(
            `thumbnail artwork generation failed (${
              err instanceof Error ? err.message : String(err)
            }) — falling back to renderer background`,
          );
        }
      } else if (!imagePrompt) {
        ctx.logger.warn("thumbnail brief contained no usable artwork prompt — using renderer background");
      }

      await ctx.progress({ detail: `compositing thumbnail: "${brief.text}"` });

      const result = await renderer.renderThumbnail({
        ...(background ? { image: background } : {}),
        text: brief.text,
        ...(brief.emphasis ? { emphasis: brief.emphasis } : {}),
        accent: brief.accent,
      });

      const ref: BlobRef = await ctx.blobs.put(result.bytes, {
        role: "thumbnail",
        media_type: result.media_type,
      });

      if (result.background === "gradient" && background) {
        ctx.logger.warn(
          "thumbnail artwork was generated but the renderer could not use it and fell back to a gradient",
        );
      }

      return {
        payload: {
          thumbnail_uri: ref.uri,
          media_type: result.media_type,
          width: result.width,
          height: result.height,
          text: brief.text,
          ...(brief.emphasis ? { emphasis: brief.emphasis } : {}),
          background: result.background,
          ...(imagePrompt ? { background_query: imagePrompt.slice(0, 120) } : {}),
          bytes: result.bytes.byteLength,
        },
        blobs: [ref],
      };
    },
  };
}
