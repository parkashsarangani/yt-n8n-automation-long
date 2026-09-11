/** Audio-first render worker: approved script + voice -> YouTube-compatible MP4 shell. */
import type { Artifact, BlobRef } from "../artifact.ts";
import { episodeArtPrompt } from "../visual-identity.ts";
import { assertYouTubeProductionGeometry } from "../media/mp4.ts";
import type { RenderRequest, RenderScene } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface RenderWorkerOptions {
  captionStyle?: string;
  version?: string;
}

interface ScriptScene {
  point?: string;
  scene_index: number;
  narration: string;
  is_outro?: boolean;
}

interface VoiceClip {
  scene_index: number;
  audio_uri: string;
  media_type?: string;
  alignment_uri?: string;
  duration_sec: number;
}

interface GrowthPackage {
  selected_title?: string;
  next_video_bridge?: string;
}

type ContinuationRenderRequest = RenderRequest & { outro_line?: string };

async function buildScenes(inputs: Record<string, Artifact>, ctx: WorkerContext): Promise<RenderScene[]> {
  const script = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
  const clips = (inputs["voice"]!.payload as { clips: VoiceClip[] }).clips;
  const clipBy = new Map(clips.map((clip) => [clip.scene_index, clip]));
  if (clipBy.size !== clips.length) throw new Error("render: duplicate voice scene_index values");

  const scriptIndexes = new Set(script.map((scene) => scene.scene_index));
  for (const clip of clips) {
    if (!scriptIndexes.has(clip.scene_index)) {
      throw new Error(`render: voice contains scene ${clip.scene_index} that is absent from the approved script`);
    }
  }

  const scenes: RenderScene[] = [];
  for (const scene of [...script].sort((a, b) => a.scene_index - b.scene_index)) {
    const clip = clipBy.get(scene.scene_index);
    if (!clip) throw new Error(`render: no voice clip for scene ${scene.scene_index}; voice and script artifacts disagree`);
    if (!(clip.duration_sec > 0)) throw new Error(`render: voice clip ${scene.scene_index} has invalid duration`);

    const audio = await ctx.blobs.get(clip.audio_uri);
    let alignment: unknown;
    if (clip.alignment_uri) {
      alignment = JSON.parse(new TextDecoder().decode(await ctx.blobs.get(clip.alignment_uri)));
    }

    scenes.push({
      scene_index: scene.scene_index,
      narration: scene.narration,
      ...(scene.point ? { point: scene.point } : {}),
      audio,
      audio_media_type: clip.media_type?.trim() || "audio/mpeg",
      ...(alignment !== undefined ? { alignment } : {}),
      ...(scene.is_outro ? { is_outro: true } : {}),
    });
  }
  return scenes;
}

export function makeRenderWorker(opts: RenderWorkerOptions = {}): WorkerDef {
  return {
    name: "render",
    kind: "worker",
    version: opts.version ?? "12",
    consumes: [
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "voice", range: "^1", as: "voice" },
      { schema_id: "growth_package", range: "^1", as: "package", optional: true },
    ],
    produces: "rendered_video",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const renderer = ctx.media.renderer;
      if (!renderer) throw new Error("render worker requires a media renderer (media.renderer)");

      const scenes = await buildScenes(inputs, ctx);
      if (!scenes.length) throw new Error("render: approved script contains no scenes");
      const bridge = (inputs["package"]?.payload as GrowthPackage | undefined)?.next_video_bridge?.trim();
      // One text-free editorial image per episode, separate from click-oriented thumbnail artwork.
      // Keep it on the render artifact so a manual render retry can reuse it.
      const artwork: BlobRef[] = [];
      let background: Uint8Array | undefined;
      const prior = ctx.priorArtifact?.blobs?.find(b => b.role === "episode_background");
      if (prior) {
        background = await ctx.blobs.get(prior.uri);
        artwork.push(prior);
      } else if (ctx.media.images) {
        try {
          const found = await ctx.media.images.generate({
            prompt: episodeArtPrompt(scenes[0]?.narration ?? "listening with confidence"),
            aspect: "16:9", count: 1,
          });
          await ctx.progress({ detail: "episode background image usage", usage: found.usage });
          background = found.images[0]?.bytes;
          if (!background) throw new Error("image provider returned no episode background");
          artwork.push(await ctx.blobs.put(background, { role: "episode_background", media_type: found.images[0]!.media_type }));
        } catch (error) {
          ctx.logger.warn(`episode artwork unavailable; using plain background: ${String(error)}`);
          await ctx.progress({ detail: "episode artwork unavailable; plain background fallback" });
        }
      }
      const request: ContinuationRenderRequest = {
        scenes,
        ...((inputs["package"]?.payload as GrowthPackage | undefined)?.selected_title ? { lesson_title: (inputs["package"]!.payload as GrowthPackage).selected_title! } : {}),
        ...(background ? { background_image: background } : {}),
        caption_style: opts.captionStyle ?? "neutral",
        ...(bridge ? { outro_line: bridge } : {}),
      };

      let jobId: string | undefined;
      const result = await renderer.render(request, {
        onJob: async (id) => {
          jobId = id;
          await ctx.progress({ detail: "audio-first render job started", job_id: id });
        },
      });
      if (renderer.id === "long-compose" && result.media_type === "video/mp4") {
        assertYouTubeProductionGeometry(result.video);
      }

      const blobs: BlobRef[] = [...artwork];
      const video = await ctx.blobs.put(result.video, { role: "video", media_type: result.media_type });
      blobs.push(video);
      let thumbRef: BlobRef | null = null;
      if (result.thumbnail) {
        thumbRef = await ctx.blobs.put(result.thumbnail.bytes, {
          role: "thumbnail",
          media_type: result.thumbnail.media_type,
        });
        blobs.push(thumbRef);
      }

      return {
        payload: {
          video_uri: video.uri,
          media_type: result.media_type,
          ...(thumbRef ? { thumbnail_uri: thumbRef.uri } : {}),
          scene_count: scenes.length,
          degraded_scenes: 0,
          ...(result.duration_sec !== undefined ? { duration_sec: result.duration_sec } : {}),
          ...(result.render_time_sec !== undefined ? { render_time_sec: result.render_time_sec } : {}),
          renderer: renderer.id,
          ...(jobId ? { job_id: jobId } : {}),
        },
        blobs,
      };
    },
  };
}
