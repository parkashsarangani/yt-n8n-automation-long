/**
 * Thumbnail worker: thumbnail_brief -> thumbnail.
 *
 * A worker, not an agent: every creative decision was already made by the
 * thumbnail_designer. This fetches a background and composites — it does not
 * decide what the thumbnail says.
 *
 * Never fails the run. A thumbnail is worth having and not worth blocking a
 * publish over, so the failure ladder degrades instead of throwing:
 *
 *   stock background + text  ->  gradient background + text
 *
 * Which rung was reached is written into the artifact rather than logged and
 * forgotten, because a gradient thumbnail is a materially worse thumbnail and
 * the difference has to be measurable after the fact.
 */

import type { BlobRef } from "../artifact.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface ThumbnailWorkerOptions {
  version?: string;
}

interface ThumbnailBrief {
  text: string;
  background_query: string;
  accent: string;
  rationale: string;
  alternatives?: string[];
}

export function makeThumbnailWorker(opts: ThumbnailWorkerOptions = {}): WorkerDef {
  return {
    name: "thumbnail",
    kind: "worker",
    version: opts.version ?? "1",
    consumes: [{ schema_id: "thumbnail_brief", range: "^1", as: "brief" }],
    produces: "thumbnail",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const brief = inputs["brief"]!.payload as ThumbnailBrief;

      const renderer = ctx.media.renderer;
      if (!renderer) {
        throw new Error("thumbnail worker needs a renderer; none was configured");
      }

      // Rung 1: a real photograph behind the text.
      let background: Uint8Array | undefined;
      if (ctx.media.images) {
        try {
          await ctx.progress({ detail: `thumbnail background: ${brief.background_query}` });
          const found = await ctx.media.images.generate({
            prompt: brief.background_query,
            aspect: "16:9",
            count: 1,
          });
          background = found.images[0]?.bytes;
        } catch (err) {
          // Rung 2. Deliberately swallowed: the renderer draws a gradient, and
          // shipping a gradient thumbnail beats blocking the publish.
          ctx.logger.warn(
            `thumbnail background lookup failed (${
              err instanceof Error ? err.message : String(err)
            }) — falling back to a gradient`,
          );
        }
      }

      await ctx.progress({ detail: `compositing thumbnail: "${brief.text}"` });

      const result = await renderer.renderThumbnail({
        ...(background ? { image: background } : {}),
        text: brief.text,
        accent: brief.accent,
      });

      const ref: BlobRef = await ctx.blobs.put(result.bytes, {
        role: "thumbnail",
        media_type: result.media_type,
      });

      if (result.background === "gradient" && background) {
        // The bytes were fetched but the renderer could not use them. Worth a
        // line: it points at the renderer, not at the stock provider.
        ctx.logger.warn(
          "a background image was supplied but the renderer fell back to a gradient",
        );
      }

      return {
        payload: {
          thumbnail_uri: ref.uri,
          media_type: result.media_type,
          width: result.width,
          height: result.height,
          text: brief.text,
          background: result.background,
          background_query: brief.background_query,
          bytes: result.bytes.byteLength,
        },
        blobs: [ref],
      };
    },
  };
}
