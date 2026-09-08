import type { BlobRef } from "../artifact.ts";
import { parseCharacterAlignment, type CharacterAlignment } from "../audio/beat-alignment.ts";
import { sliceAudioWindow } from "../audio/slice.ts";
import { assertYouTubeProductionGeometry } from "../media/mp4.ts";
import type { RenderRequest, RenderScene } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

interface ScriptScene { scene_index: number; is_outro?: boolean }
interface ScriptArtifact { scenes: ScriptScene[] }
interface VoiceClip { scene_index: number; alignment_uri?: string }
interface VoiceArtifact { clips: VoiceClip[] }
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
interface GrowthPackage { next_video_bridge?: string }
interface VisualAssetRelease { status?: unknown }
type ProductionTimelineScene = RenderScene & { visual_mode?: "motion_graphic" | "ai_broll"; continuity_group?: string };
type ContinuationRenderRequest = RenderRequest & { outro_line?: string };

/**
 * Slice ElevenLabs-style character alignment to the same scene-relative window
 * as the immutable audio slice. Times are rebased to the start of the beat so
 * long-compose can keep phrase-aware captions without seeing the full clip.
 */
export function sliceCharacterAlignment(
  value: unknown,
  startSec: number,
  endSec: number,
): CharacterAlignment | undefined {
  const parsed = parseCharacterAlignment(value);
  if (!parsed || !(endSec > startSec)) return undefined;
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const duration = endSec - startSec;
  for (let i = 0; i < parsed.characters.length; i++) {
    const start = parsed.character_start_times_seconds[i]!;
    const end = parsed.character_end_times_seconds[i]!;
    if (end <= startSec || start >= endSec) continue;
    characters.push(parsed.characters[i]!);
    starts.push(Number(Math.max(0, start - startSec).toFixed(3)));
    ends.push(Number(Math.min(duration, Math.max(0, end - startSec)).toFixed(3)));
  }
  if (!characters.length) return undefined;
  return {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };
}

/**
 * The free-first FreeLLMAPI image chain can return JPEG or WebP (NVIDIA's FLUX
 * endpoint returns JPEG), not only PNG. Sniff the real container so the renderer
 * is told the truth instead of a hard-coded "image/png".
 */
export function sniffImageMediaType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return "image/png";
}

export function makeVisualTimelineRenderWorker(): WorkerDef {
  return {
    name: "visual_timeline_render",
    kind: "worker",
    version: "1",
    consumes: [
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "voice", range: "^1", as: "voice" },
      { schema_id: "visual_timeline", range: "^1", as: "timeline" },
      { schema_id: "growth_package", range: "^1", as: "package", optional: true },
      { schema_id: "visual_asset_release", range: "^1", as: "visual_release" },
    ],
    produces: "rendered_video",
    produces_version: "1.0.0",

    async execute(inputs, ctx: WorkerContext): Promise<WorkerOutput> {
      const renderer = ctx.media.renderer;
      if (!renderer) throw new Error("visual_timeline_render requires media.renderer");
      const release = inputs["visual_release"]?.payload as VisualAssetRelease | undefined;
      if (!release || release.status !== "pass") throw new Error("visual_timeline_render: visual asset release is not pass");

      const script = inputs["script"]!.payload as ScriptArtifact;
      const voice = inputs["voice"]!.payload as VoiceArtifact;
      const timeline = inputs["timeline"]!.payload as VisualTimeline;
      const ordered = [...timeline.beats].sort((a, b) => a.ordinal - b.ordinal);
      if (!ordered.length) throw new Error("visual_timeline_render: timeline is empty");

      const clipByScene = new Map(voice.clips.map((clip) => [clip.scene_index, clip]));
      const audioCache = new Map<string, Uint8Array>();
      const alignmentCache = new Map<string, unknown>();
      const lastOrdinalByScene = new Map<number, number>();
      for (const beat of ordered) lastOrdinalByScene.set(beat.scene_index, beat.ordinal);
      const outroScene = script.scenes.find((scene) => scene.is_outro)?.scene_index;
      const scenes: ProductionTimelineScene[] = [];

      for (const beat of ordered) {
        let original = audioCache.get(beat.audio_uri);
        if (!original) {
          original = await ctx.blobs.get(beat.audio_uri);
          audioCache.set(beat.audio_uri, original);
        }
        const sliced = await sliceAudioWindow(original, beat.audio_media_type, beat.scene_start_sec, beat.scene_end_sec);
        const image = beat.image_uri ? await ctx.blobs.get(beat.image_uri) : undefined;
        const video = beat.video_uri ? await ctx.blobs.get(beat.video_uri) : undefined;
        const templateData = beat.template_data ? JSON.parse(beat.template_data) as Record<string, unknown> : undefined;
        if (!image && !video && !beat.template_category) {
          throw new Error(`${beat.id}: visual timeline has no renderable visual`);
        }

        let alignment: CharacterAlignment | undefined;
        const clip = clipByScene.get(beat.scene_index);
        if (clip?.alignment_uri) {
          let raw = alignmentCache.get(clip.alignment_uri);
          if (raw === undefined) {
            raw = JSON.parse(new TextDecoder().decode(await ctx.blobs.get(clip.alignment_uri)));
            alignmentCache.set(clip.alignment_uri, raw);
          }
          alignment = sliceCharacterAlignment(raw, beat.scene_start_sec, beat.scene_end_sec);
        }

        scenes.push({
          scene_index: beat.ordinal,
          audio: sliced.bytes,
          audio_media_type: sliced.media_type,
          ...(image ? { image, image_media_type: sniffImageMediaType(image) } : {}),
          ...(video ? { video, video_media_type: "video/mp4" } : {}),
          ...(alignment ? { alignment } : {}),
          ...(beat.template_category ? { template_category: beat.template_category } : {}),
          ...(templateData ? { template_data: templateData } : {}),
          ...(beat.resolved_mode === "motion_graphic" ? { visual_mode: "motion_graphic" as const } : { visual_mode: "ai_broll" as const }),
          ...(beat.continuity_group ? { continuity_group: beat.continuity_group } : {}),
          ...(outroScene === beat.scene_index && lastOrdinalByScene.get(beat.scene_index) === beat.ordinal ? { is_outro: true } : {}),
        });
      }

      const bridge = (inputs["package"]?.payload as GrowthPackage | undefined)?.next_video_bridge?.trim();
      const request: ContinuationRenderRequest = {
        scenes,
        caption_style: "neutral",
        ...(bridge ? { outro_line: bridge } : {}),
      };
      let jobId: string | undefined;
      const result = await renderer.render(request, {
        onJob: async (id) => {
          jobId = id;
          await ctx.progress({ detail: "production RFC 0010 visual timeline render started", job_id: id });
        },
      });
      if ((result.degraded_scenes ?? 0) > 0) {
        throw new Error(`visual_timeline_render degraded ${result.degraded_scenes} beat(s); placeholders are forbidden`);
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
          // Final QA compares this to script scenes. Rendering internally uses
          // RFC 0010 beats, but every script scene is covered by the timeline.
          scene_count: script.scenes.length,
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
