/**
 * Thumbnail worker: thumbnail_brief -> thumbnail.
 *
 * Cartoon production is not allowed to silently ship a text-only gradient.
 * If custom artwork cannot be generated or composited, fail the node so the
 * normal runner retry/recovery path can try again instead of publishing weak
 * packaging that looks disconnected from the recurring cast.
 */

import type { BlobRef } from "../artifact.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface ThumbnailWorkerOptions { version?: string; }

interface ThumbnailBrief {
  mode?: "cartoon";
  text: string;
  emphasis?: string;
  art_prompt?: string;
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
    version: opts.version ?? "3",
    consumes: [{ schema_id: "thumbnail_brief", range: "^1", as: "brief" }],
    produces: "thumbnail",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const brief = inputs["brief"]!.payload as ThumbnailBrief;
      const renderer = ctx.media.renderer;
      if (!renderer) throw new Error("thumbnail worker needs a renderer; none was configured");

      const cartoon = brief.mode === "cartoon";
      const imagePrompt = brief.art_prompt?.trim() || brief.background_query?.trim();

      if (cartoon && !imagePrompt) {
        throw new Error("cartoon thumbnail brief has no art_prompt; refusing to publish a text-only thumbnail");
      }
      if (cartoon && !ctx.media.images) {
        throw new Error("cartoon thumbnail needs an image provider; refusing to publish a text-only thumbnail");
      }

      let background: Uint8Array | undefined;
      if (ctx.media.images && imagePrompt) {
        try {
          await ctx.progress({ detail: cartoon ? "generating recurring-cast thumbnail artwork" : `thumbnail artwork: ${imagePrompt.slice(0, 120)}` });
          const found = await ctx.media.images.generate({ prompt: imagePrompt, aspect: "16:9", count: 1 });
          background = found.images[0]?.bytes;
          if (!background) throw new Error("image provider returned no thumbnail image");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (cartoon) {
            throw new Error(`cartoon thumbnail artwork generation failed: ${message}`);
          }
          ctx.logger.warn(`thumbnail artwork generation failed (${message}) — falling back to renderer background`);
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

      if (cartoon && result.background !== "supplied") {
        throw new Error(
          "cartoon thumbnail compositor degraded to a gradient; refusing to publish without recurring-character artwork",
        );
      }

      const ref: BlobRef = await ctx.blobs.put(result.bytes, {
        role: "thumbnail",
        media_type: result.media_type,
      });

      if (result.background === "gradient" && background) {
        ctx.logger.warn("thumbnail artwork was generated but the renderer could not use it and fell back to a gradient");
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