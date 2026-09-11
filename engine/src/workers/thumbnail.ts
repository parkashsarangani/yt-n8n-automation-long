/**
 * Thumbnail worker: thumbnail_brief -> thumbnail.
 *
 * Best-effort artwork: if a prompt is given and an image provider is
 * configured, generate real artwork; if generation fails or nothing was
 * asked for, fall back to the renderer's gradient background rather than
 * blocking the run. The stricter "must have real cast artwork or fail"
 * behavior existed only for the retired two-host character pipeline.
 *
 * In the audio-first graph this is the ONLY image the pipeline generates:
 * the episode itself is narration over a static shell, so the thumbnail is
 * a packaging concern, not part of the episode's visual content.
 */

import type { BlobRef } from "../artifact.ts";
import { episodeArtPrompt } from "../visual-identity.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface ThumbnailWorkerOptions { version?: string; }

interface ThumbnailBrief {
  text: string;
  emphasis?: string;
  art_prompt?: string;
  background_query?: string;
  accent: string;
  rationale: string;
  alternatives?: string[];
}

export function makeThumbnailWorker(opts: ThumbnailWorkerOptions = {}): WorkerDef {
  return {
    name: "thumbnail",
    kind: "worker",
    version: opts.version ?? "7",
    consumes: [{ schema_id: "thumbnail_brief", range: "^1", as: "brief" }, { schema_id: "rendered_video", range: "^1", as: "episode", optional: true }],
    produces: "thumbnail",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const brief = inputs["brief"]!.payload as ThumbnailBrief;
      const renderer = ctx.media.renderer;
      if (!renderer) throw new Error("thumbnail worker needs a renderer; none was configured");

      const imagePrompt = brief.art_prompt?.trim() || brief.background_query?.trim();

      let background: Uint8Array | undefined;
      const shared = inputs["episode"]?.blobs?.find(b => b.role === "episode_background");
      if (shared) background = await ctx.blobs.get(shared.uri);
      if (!background && !inputs["episode"] && ctx.media.images && imagePrompt) {
        try {
          await ctx.progress({ detail: `thumbnail artwork: ${imagePrompt.slice(0, 120)}` });
          const found = await ctx.media.images.generate({ prompt: episodeArtPrompt(imagePrompt), aspect: "16:9", count: 1 });
          await ctx.progress({ detail: "thumbnail image usage", usage: found.usage });
          const first = found.images[0];
          background = first?.bytes;
          if (!background) throw new Error("image provider returned no thumbnail image");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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

      if (result.background === "gradient" && background) {
        ctx.logger.warn("thumbnail artwork was generated but the renderer could not use it and fell back to a gradient");
      }

      const ref: BlobRef = await ctx.blobs.put(result.bytes, {
        role: "thumbnail",
        media_type: result.media_type,
      });

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
