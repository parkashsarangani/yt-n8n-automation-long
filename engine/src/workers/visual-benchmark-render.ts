import type { BlobRef } from "../artifact.ts";
import { sliceAudioWindow } from "../audio/slice.ts";
import { assertYouTubeProductionGeometry } from "../media/mp4.ts";
import type { RenderScene } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

interface TimelineBeat {
  id: string;
  ordinal: number;
  scene_index: number;
  scene_start_sec: number;
  scene_end_sec: number;
  duration_sec: number;
  audio_uri: string;
  audio_media_type: string;
  resolved_mode: "stock_video" | "generated_image" | "motion_graphic" | "generated_video";
  image_uri?: string;
  video_uri?: string;
  template_category?: "explanation";
  template_data?: string;
  continuity_group: string;
}
interface VisualTimeline { beats: TimelineBeat[]; total_duration_sec: number }

type BenchmarkScene = RenderScene & { visual_mode?: "motion_graphic" | "ai_broll"; continuity_group?: string };

export function makeVisualBenchmarkRenderWorker(): WorkerDef {
  return {
    name: "visual_benchmark_render",
    kind: "worker",
    version: "1",
    consumes: [{ schema_id: "visual_timeline", range: "^1", as: "timeline" }],
    produces: "rendered_video",
    produces_version: "1.0.0",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const renderer = ctx.media.renderer;
      if (!renderer) throw new Error("visual_benchmark_render requires media.renderer");
      const timeline = inputs["timeline"]!.payload as VisualTimeline;
      const ordered = [...timeline.beats].sort((a, b) => a.ordinal - b.ordinal);
      const scenes: BenchmarkScene[] = [];

      // The same original scene audio is reused by adjacent beats. Cache bytes;
      // every slice is derived from immutable voice data and never rewrites it.
      const audioCache = new Map<string, Uint8Array>();
      for (const beat of ordered) {
        let original = audioCache.get(beat.audio_uri);
        if (!original) {
          original = await ctx.blobs.get(beat.audio_uri);
          audioCache.set(beat.audio_uri, original);
        }
        const sliced = await sliceAudioWindow(
          original,
          beat.audio_media_type,
          beat.scene_start_sec,
          beat.scene_end_sec,
        );
        const image = beat.image_uri ? await ctx.blobs.get(beat.image_uri) : undefined;
        const video = beat.video_uri ? await ctx.blobs.get(beat.video_uri) : undefined;
        const templateData = beat.template_data
          ? JSON.parse(beat.template_data) as Record<string, unknown>
          : undefined;
        if (!image && !video && !beat.template_category) {
          throw new Error(`${beat.id}: timeline has no renderable visual`);
        }
        scenes.push({
          scene_index: beat.ordinal,
          audio: sliced.bytes,
          audio_media_type: sliced.media_type,
          ...(image ? { image, image_media_type: "image/png" } : {}),
          ...(video ? { video, video_media_type: "video/mp4" } : {}),
          ...(beat.template_category ? { template_category: beat.template_category } : {}),
          ...(templateData ? { template_data: templateData } : {}),
          ...(beat.resolved_mode === "motion_graphic" ? { visual_mode: "motion_graphic" as const } : {}),
          ...(beat.resolved_mode === "generated_image" || beat.resolved_mode === "generated_video" || beat.resolved_mode === "stock_video"
            ? { visual_mode: "ai_broll" as const }
            : {}),
          ...(beat.continuity_group ? { continuity_group: beat.continuity_group } : {}),
        });
      }

      let jobId: string | undefined;
      const result = await renderer.render(
        { scenes, caption_style: "neutral" },
        { onJob: async (id) => { jobId = id; await ctx.progress({ detail: "RFC 0010 comparison render started", job_id: id }); } },
      );
      if ((result.degraded_scenes ?? 0) > 0) {
        throw new Error(`visual benchmark renderer degraded ${result.degraded_scenes} scene(s); placeholders are forbidden`);
      }
      if (renderer.id === "long-compose" && result.media_type === "video/mp4") {
        assertYouTubeProductionGeometry(result.video);
      }
      const videoRef = await ctx.blobs.put(result.video, { role: "video", media_type: result.media_type });
      const blobs: BlobRef[] = [videoRef];
      return {
        payload: {
          video_uri: videoRef.uri,
          media_type: result.media_type,
          scene_count: scenes.length,
          degraded_scenes: 0,
          duration_sec: result.duration_sec ?? timeline.total_duration_sec,
          ...(result.render_time_sec !== undefined ? { render_time_sec: result.render_time_sec } : {}),
          renderer: renderer.id,
          ...(jobId ? { job_id: jobId } : {}),
        },
        blobs,
      };
    },
  };
}
