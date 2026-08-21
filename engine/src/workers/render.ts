/**
 * Render worker: script + voice + asset_manifest -> rendered_video.
 *
 * The first transformation with a long-running external job. Two consequences
 * that do not apply to any earlier worker:
 *
 *  - It reports progress. The job id is written to the run log the moment the
 *    renderer hands it over, so a crashed run leaves a trace of what it had
 *    started instead of silently re-rendering twenty minutes of video.
 *  - It joins three inputs by scene_index rather than trusting array order,
 *    because three separately-produced artifacts have no shared ordering
 *    guarantee.
 */

import type { BlobRef } from "../artifact.ts";
import { assertYouTubeProductionGeometry } from "../media/mp4.ts";
import type { RenderScene } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface RenderWorkerOptions {
  captionStyle?: string;
  version?: string;
  thumbnail?: { text?: string; accent?: string };
}

interface ScriptScene {
  scene_index: number;
  narration: string;
  is_outro?: boolean;
}
interface VoiceClip {
  scene_index: number;
  audio_uri: string;
  alignment_uri?: string;
  duration_sec: number;
}
interface AssetScene {
  scene_index: number;
  image_uri?: string;
  video_uri?: string;
  source: string;
  template_category?: string;
  /** JSON-encoded string in the artifact, parsed at read time. */
  template_data?: string;
}

export function makeRenderWorker(opts: RenderWorkerOptions = {}): WorkerDef {
  return {
    name: "render",
    kind: "worker",
    version: opts.version ?? "3",
    consumes: [
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "voice", range: "^1", as: "voice" },
      { schema_id: "asset_manifest", range: "^1", as: "assets" },
    ],
    produces: "rendered_video",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const renderer = ctx.media.renderer;
      if (!renderer) {
        throw new Error("render worker requires a media renderer (media.renderer)");
      }

      const script = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
      const clips = (inputs["voice"]!.payload as { clips: VoiceClip[] }).clips;
      const assets = (inputs["assets"]!.payload as { scenes: AssetScene[] }).scenes;

      const clipBy = new Map(clips.map((c) => [c.scene_index, c]));
      const assetBy = new Map(assets.map((a) => [a.scene_index, a]));

      const ordered = [...script].sort((a, b) => a.scene_index - b.scene_index);
      const scenes: RenderScene[] = [];

      for (const scene of ordered) {
        const clip = clipBy.get(scene.scene_index);
        if (!clip) {
          // Audio is not optional: a scene with no narration has no duration,
          // so the timeline cannot be built. Fail loudly.
          throw new Error(
            `render: no voice clip for scene ${scene.scene_index}; ` +
            `voice and script artifacts disagree`,
          );
        }
        const asset = assetBy.get(scene.scene_index);
        const audio = await ctx.blobs.get(clip.audio_uri);

        let alignment: unknown;
        if (clip.alignment_uri) {
          alignment = JSON.parse(new TextDecoder().decode(await ctx.blobs.get(clip.alignment_uri)));
        }

        // A missing image is expected, not exceptional: the asset worker
        // degrades to a placeholder rather than failing the video. Video and
        // image are mutually exclusive — the asset collector only ever sets
        // one per scene, video first when the stock source had real footage.
        const video = asset?.video_uri ? await ctx.blobs.get(asset.video_uri) : undefined;
        const image = !video && asset?.image_uri ? await ctx.blobs.get(asset.image_uri) : undefined;

        scenes.push({
          scene_index: scene.scene_index,
          audio,
          audio_media_type: "audio/mpeg",
          ...(video ? { video, video_media_type: "video/mp4" } : {}),
          ...(image ? { image, image_media_type: "image/png" } : {}),
          ...(alignment !== undefined ? { alignment } : {}),
          ...(scene.is_outro ? { is_outro: true } : {}),
          ...(asset?.template_category ? { template_category: asset.template_category } : {}),
          ...(asset?.template_data ? { template_data: JSON.parse(asset.template_data) } : {}),
        });
      }

      let jobId: string | undefined;
      const result = await renderer.render(
        {
          scenes,
          caption_style: opts.captionStyle ?? "neutral",
          ...(opts.thumbnail ? { thumbnail: opts.thumbnail } : {}),
        },
        {
          onJob: async (id) => {
            jobId = id;
            await ctx.progress({ detail: `render job started`, job_id: id });
          },
        },
      );

      if (renderer.id === "long-compose" && result.media_type === "video/mp4") {
        // The reviewed artifact is the production object a human approves.
        // Do not wait until upload to discover that long-compose regressed to
        // 720p; reject the rendered_video artifact before it can be stored.
        assertYouTubeProductionGeometry(result.video);
      }

      const blobs: BlobRef[] = [];
      const video = await ctx.blobs.put(result.video, {
        role: "video",
        media_type: result.media_type,
      });
      blobs.push(video);

      let thumbRef: BlobRef | null = null;
      if (result.thumbnail) {
        thumbRef = await ctx.blobs.put(result.thumbnail.bytes, {
          role: "thumbnail",
          media_type: result.thumbnail.media_type,
        });
        blobs.push(thumbRef);
      }

      const degraded =
        result.degraded_scenes ?? scenes.filter((s) => s.image === undefined && s.video === undefined).length;

      return {
        payload: {
          video_uri: video.uri,
          media_type: result.media_type,
          ...(thumbRef ? { thumbnail_uri: thumbRef.uri } : {}),
          scene_count: scenes.length,
          degraded_scenes: degraded,
          ...(result.duration_sec !== undefined ? { duration_sec: result.duration_sec } : {}),
          ...(result.render_time_sec !== undefined
            ? { render_time_sec: result.render_time_sec }
            : {}),
          renderer: renderer.id,
          ...(jobId ? { job_id: jobId } : {}),
        },
        blobs,
      };
    },
  };
}
