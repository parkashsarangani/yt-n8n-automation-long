/** Audio-first render worker: approved script + voice -> YouTube-compatible MP4 shell. */
import type { Artifact, BlobRef } from "../artifact.ts";
import { buildVisualPlan, visualPrompt } from "../visual-plan.ts";
import { assertYouTubeProductionGeometry } from "../media/mp4.ts";
import type { RenderRequest, RenderScene, SceneVisual, VisualPlan } from "../provider.ts";
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

interface RenderedVideoPayload {
  visual_reference_id?: string;
  visual_plan?: VisualPlan;
}

interface VisualQaMetadata {
  artwork_text_policy: string;
  caption_overlap_guard: string;
  scene_boundaries: string;
  max_visual_hold_sec: number;
  human_review_required: boolean;
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
    version: opts.version ?? "14",
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
      const lessonTitle = (inputs["package"]?.payload as GrowthPackage | undefined)?.selected_title;
      // The plan is deliberately built after approved script + voice are bound.
      // It changes visuals at meaningful scene boundaries without asking a model
      // to invent a second, potentially divergent version of the narration.
      const visualPlan = buildVisualPlan(scenes, { lessonTitle, maxArtwork: 4 });
      const voiceDurations = ((inputs["voice"]!.payload as { clips?: VoiceClip[] }).clips ?? [])
        .map((clip) => clip.duration_sec)
        .filter((duration) => Number.isFinite(duration) && duration > 0);
      const visualQa: VisualQaMetadata = {
        artwork_text_policy: "artwork prompt prohibits text; renderer owns episode text",
        caption_overlap_guard: "opaque bottom caption band",
        scene_boundaries: "measured voice clip durations",
        max_visual_hold_sec: Math.max(...voiceDurations, 0),
        // Prompting cannot reliably detect malformed lettering or cropped
        // faces. Keep the review request explicit instead of claiming vision QA.
        human_review_required: true,
      };

      // Keep generated visual blobs on the render artifact so a manual render
      // retry can reuse successful artwork and never spend twice for the same
      // approved script/reference pair.
      const artwork: BlobRef[] = [];
      let background: Uint8Array | undefined;
      const priorPayload = ctx.priorArtifact?.payload as RenderedVideoPayload | undefined;
      const priorMatches = priorPayload?.visual_reference_id === visualPlan.reference.id;
      const priorByRole = new Map(
        (ctx.priorArtifact?.blobs ?? [])
          .filter((blob) => blob.role.startsWith("scene_artwork:"))
          .map((blob) => [blob.role, blob]),
      );
      const legacyBackground = ctx.priorArtifact?.blobs?.find(b => b.role === "episode_background");
      if (legacyBackground) {
        background = await ctx.blobs.get(legacyBackground.uri);
        artwork.push(legacyBackground);
      }

      const artworkScenes = new Map<number, Uint8Array>();
      for (const beat of visualPlan.beats.filter((candidate) => candidate.requires_artwork)) {
        const role = `scene_artwork:${beat.scene_index}`;
        const prior = priorMatches ? priorByRole.get(role) : undefined;
        if (prior) {
          const bytes = await ctx.blobs.get(prior.uri);
          artworkScenes.set(beat.scene_index, bytes);
          if (!background) background = bytes;
          artwork.push(prior);
          continue;
        }

        // A fake provider is useful with the fake renderer, but its bytes are
        // intentionally not image data. Do not feed those bytes to FFmpeg when
        // a real compositor is configured; the renderer's clean colour fallback
        // is more honest than a corrupt image input.
        const canGenerate = ctx.media.images &&
          (!ctx.media.images.id.startsWith("fake/") || ctx.media.renderer?.id.startsWith("fake/"));
        if (!canGenerate) continue;
        try {
          const found = await ctx.media.images!.generate({
            prompt: visualPrompt(visualPlan, beat),
            aspect: "16:9", count: 1,
          });
          await ctx.progress({ detail: `visual artwork for scene ${beat.scene_index}`, usage: found.usage });
          const image = found.images[0];
          if (!image?.bytes) throw new Error("image provider returned no visual artwork");
          const ref = await ctx.blobs.put(image.bytes, { role, media_type: image.media_type });
          artworkScenes.set(beat.scene_index, image.bytes);
          if (!background) background = image.bytes;
          artwork.push(ref);
        } catch (error) {
          ctx.logger.warn(`visual artwork unavailable for scene ${beat.scene_index}; using clean fallback: ${String(error)}`);
          await ctx.progress({ detail: `visual artwork fallback for scene ${beat.scene_index}` });
        }
      }

      const beatByScene = new Map(visualPlan.beats.map((beat) => [beat.scene_index, beat]));
      const plannedScenes: RenderScene[] = scenes.map((scene) => {
        const beat = beatByScene.get(scene.scene_index)!;
        const visual: SceneVisual = {
          kind: beat.kind,
          requires_artwork: beat.requires_artwork,
          viewer_understands: beat.viewer_understands,
          scene_reference: beat.scene_reference,
          ...(beat.overlay ? { overlay: beat.overlay } : {}),
          ...(artworkScenes.has(scene.scene_index) ? { image: artworkScenes.get(scene.scene_index)! } : {}),
        };
        return { ...scene, visual };
      });
      const request: ContinuationRenderRequest = {
        scenes: plannedScenes,
        ...(lessonTitle ? { lesson_title: lessonTitle } : {}),
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
          degraded_scenes: result.degraded_scenes ?? 0,
          visual_reference_id: visualPlan.reference.id,
          visual_plan: visualPlan,
          visual_qa: visualQa,
          visual_artwork_count: artworkScenes.size,
          visual_fallback_count: visualPlan.beats.filter((beat) => beat.requires_artwork && !artworkScenes.has(beat.scene_index)).length,
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
