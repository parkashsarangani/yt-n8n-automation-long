/**
 * Publish worker: rendered_video + story -> published_episode.
 *
 * Reads the target's `requirements()` rather than knowing anything about a
 * specific platform — this is the seam that keeps YouTube a plugin. Swapping in
 * a podcast or blog target changes the constructor argument and nothing else.
 *
 * Validation is up-front and fatal. Publishing is the one irreversible step in
 * the graph, so a title that will not fit stops the run *before* upload rather
 * than being quietly truncated into something the story never meant.
 */

import type { PublishMetadata, PublishTarget } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface PublishWorkerOptions {
  target: PublishTarget;
  privacy?: "public" | "unlisted" | "private";
  madeForKids?: boolean;
  version?: string;
}

interface StoryPayload {
  title: string;
  payoff: string;
  seo_description?: string;
  tags?: string[];
}

interface ThumbnailArtifact {
  thumbnail_uri: string;
  media_type: "image/png" | "image/jpeg";
  bytes?: number;
}

interface RenderedVideo {
  video_uri: string;
  media_type: string;
  thumbnail_uri?: string;
  duration_sec?: number;
}

export function makePublishWorker(opts: PublishWorkerOptions): WorkerDef {
  const target = opts.target;

  return {
    name: "publish",
    kind: "worker",
    version: opts.version ?? "1",
    consumes: [
      { schema_id: "rendered_video", range: "^1", as: "video" },
      { schema_id: "story", range: "^1", as: "story" },
      { schema_id: "thumbnail", range: "^1", as: "thumbnail" },
    ],
    produces: "published_episode",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const video = inputs["video"]!.payload as RenderedVideo;
      const story = inputs["story"]!.payload as StoryPayload;
      const reqs = target.requirements();

      const metadata: PublishMetadata = {
        title: story.title,
        // Falls back to the payoff so a description is never empty, even on a
        // story artifact written before seo_description existed (story@1.0.0).
        description: story.seo_description ?? story.payoff,
        tags: story.tags ?? [],
        privacy: opts.privacy ?? "private",
        made_for_kids: opts.madeForKids ?? false,
      };

      assertFits(metadata, video, reqs, target.id);

      const bytes = await ctx.blobs.get(video.video_uri);

      // The designed thumbnail wins over whatever the video render happened to
      // emit: it was reasoned about, and the render's is a by-product.
      const designed = inputs["thumbnail"]?.payload as ThumbnailArtifact | undefined;
      const thumbSource = designed?.thumbnail_uri
        ? { uri: designed.thumbnail_uri, media_type: designed.media_type }
        : video.thumbnail_uri
          ? { uri: video.thumbnail_uri, media_type: "image/png" }
          : null;

      const thumbnail =
        thumbSource && reqs.supports_custom_thumbnail
          ? {
              bytes: await ctx.blobs.get(thumbSource.uri),
              media_type: thumbSource.media_type,
            }
          : undefined;

      await ctx.progress({ detail: `publishing to ${target.id}` });

      const result = await target.publish(
        {
          video: bytes,
          media_type: video.media_type,
          ...(thumbnail ? { thumbnail } : {}),
          metadata,
          ...(video.duration_sec !== undefined ? { duration_sec: video.duration_sec } : {}),
        },
        { onProgress: (detail) => ctx.progress({ detail }) },
      );

      if (thumbnail && !result.thumbnail_set) {
        // Visible, not silent: an auto-selected frame instead of the designed
        // thumbnail materially changes click-through.
        ctx.logger.warn(
          `[publish] ${target.id} did not accept the custom thumbnail for ${result.external_id}`,
        );
      }

      return {
        payload: {
          target: target.id,
          external_id: result.external_id,
          url: result.url,
          title: metadata.title,
          published_at: new Date().toISOString(),
          synthetic_media_disclosed: result.synthetic_media_disclosed,
          thumbnail_set: result.thumbnail_set,
          privacy: metadata.privacy,
        },
      };
    },
  };
}

function assertFits(
  metadata: PublishMetadata,
  video: RenderedVideo,
  reqs: ReturnType<PublishTarget["requirements"]>,
  targetId: string,
): void {
  const problems: string[] = [];

  if (metadata.title.length > reqs.max_title_chars) {
    problems.push(
      `title is ${metadata.title.length} chars, ${targetId} allows ${reqs.max_title_chars}`,
    );
  }
  if (
    reqs.max_description_chars !== undefined &&
    (metadata.description?.length ?? 0) > reqs.max_description_chars
  ) {
    problems.push(
      `description is ${metadata.description!.length} chars, ` +
        `${targetId} allows ${reqs.max_description_chars}`,
    );
  }
  if (reqs.max_tags !== undefined && (metadata.tags?.length ?? 0) > reqs.max_tags) {
    problems.push(`${metadata.tags!.length} tags, ${targetId} allows ${reqs.max_tags}`);
  }
  if (
    reqs.max_duration_sec !== undefined &&
    video.duration_sec !== undefined &&
    video.duration_sec > reqs.max_duration_sec
  ) {
    problems.push(
      `video is ${video.duration_sec}s, ${targetId} allows ${reqs.max_duration_sec}s`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`publish to ${targetId} rejected before upload: ${problems.join("; ")}`);
  }
}
