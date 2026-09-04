/** Render worker: script + voice + asset_manifest -> rendered_video. */
import type { Artifact, BlobRef } from "../artifact.ts";
import { assertYouTubeProductionGeometry } from "../media/mp4.ts";
import type { RenderRequest, RenderScene } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export interface RenderWorkerOptions { captionStyle?: string; version?: string; thumbnail?: { text?: string; accent?: string } }
interface ScriptScene { scene_index: number; narration: string; is_outro?: boolean }
interface VoiceClip { scene_index: number; audio_uri: string; alignment_uri?: string; duration_sec: number }
interface AssetScene {
  scene_index: number; image_uri?: string; image_uris?: string[]; video_uri?: string; source: string;
  template_category?: string; template_data?: string; visual_mode?: "motion_graphic" | "ai_broll";
  continuity_group?: string; shot_types?: string[];
}
interface GrowthPackage { next_video_bridge?: string }
type HybridRenderScene = RenderScene & { images?: Uint8Array[]; visual_mode?: "motion_graphic" | "ai_broll"; continuity_group?: string; shot_types?: string[] };
type ContinuationRenderRequest = RenderRequest & { outro_line?: string };

async function buildScenes(inputs: Record<string, Artifact>, ctx: WorkerContext): Promise<HybridRenderScene[]> {
  const script = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
  const clips = (inputs["voice"]!.payload as { clips: VoiceClip[] }).clips;
  const assets = (inputs["assets"]!.payload as { scenes: AssetScene[] }).scenes;
  const clipBy = new Map(clips.map((c) => [c.scene_index, c]));
  const assetBy = new Map(assets.map((a) => [a.scene_index, a]));
  const scenes: HybridRenderScene[] = [];
  for (const scene of [...script].sort((a, b) => a.scene_index - b.scene_index)) {
    const clip = clipBy.get(scene.scene_index);
    if (!clip) throw new Error(`render: no voice clip for scene ${scene.scene_index}; voice and script artifacts disagree`);
    const asset = assetBy.get(scene.scene_index);
    const audio = await ctx.blobs.get(clip.audio_uri);
    let alignment: unknown;
    if (clip.alignment_uri) alignment = JSON.parse(new TextDecoder().decode(await ctx.blobs.get(clip.alignment_uri)));
    const video = asset?.video_uri ? await ctx.blobs.get(asset.video_uri) : undefined;
    const imageUris = !video ? (asset?.image_uris?.length ? asset.image_uris : asset?.image_uri ? [asset.image_uri] : []) : [];
    const images: Uint8Array[] = [];
    for (const uri of imageUris) images.push(await ctx.blobs.get(uri));
    const image = images[0];
    const templateData = asset?.template_data ? JSON.parse(asset.template_data) as Record<string, unknown> : undefined;
    scenes.push({
      scene_index: scene.scene_index,
      audio,
      audio_media_type: "audio/mpeg",
      ...(video ? { video, video_media_type: "video/mp4" } : {}),
      ...(image ? { image, image_media_type: "image/png" } : {}),
      ...(images.length > 1 ? { images } : {}),
      ...(alignment !== undefined ? { alignment } : {}),
      ...(scene.is_outro ? { is_outro: true } : {}),
      ...(asset?.template_category ? { template_category: asset.template_category } : {}),
      ...(templateData ? { template_data: templateData } : {}),
      ...(asset?.visual_mode ? { visual_mode: asset.visual_mode } : {}),
      ...(asset?.continuity_group ? { continuity_group: asset.continuity_group } : {}),
      ...(asset?.shot_types ? { shot_types: asset.shot_types } : {}),
    });
  }
  return scenes;
}

export function makeRenderWorker(opts: RenderWorkerOptions = {}): WorkerDef {
  return {
    name: "render", kind: "worker", version: opts.version ?? "6",
    consumes: [
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "voice", range: "^1", as: "voice" },
      { schema_id: "asset_manifest", range: ">=1 <3", as: "assets" },
      // RFC 0009 decision 11. Manual/legacy graphs have no growth package, so
      // this is deliberately optional; the illustrated growth graph wires it.
      { schema_id: "growth_package", range: "^1", as: "package", optional: true },
    ],
    produces: "rendered_video",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const renderer = ctx.media.renderer;
      if (!renderer) throw new Error("render worker requires a media renderer (media.renderer)");
      const scenes = await buildScenes(inputs, ctx);
      const bridge = (inputs["package"]?.payload as GrowthPackage | undefined)?.next_video_bridge?.trim();
      // The continuation line is episode data, not renderer configuration.
      // Passing it per request guarantees the package that won this run is the
      // one whose session-continuation promise reaches the compositor.
      const request: ContinuationRenderRequest = {
        scenes,
        caption_style: opts.captionStyle ?? "neutral",
        ...(bridge ? { outro_line: bridge } : {}),
        ...(opts.thumbnail ? { thumbnail: opts.thumbnail } : {}),
      };
      let jobId: string | undefined;
      const result = await renderer.render(request, {
        onJob: async (id) => { jobId = id; await ctx.progress({ detail: "render job started", job_id: id }); },
      });
      if (renderer.id === "long-compose" && result.media_type === "video/mp4") assertYouTubeProductionGeometry(result.video);
      const blobs: BlobRef[] = [];
      const video = await ctx.blobs.put(result.video, { role: "video", media_type: result.media_type });
      blobs.push(video);
      let thumbRef: BlobRef | null = null;
      if (result.thumbnail) {
        thumbRef = await ctx.blobs.put(result.thumbnail.bytes, { role: "thumbnail", media_type: result.thumbnail.media_type });
        blobs.push(thumbRef);
      }
      const degraded = result.degraded_scenes ?? scenes.filter((s) => s.image === undefined && s.video === undefined && s.template_category === undefined).length;
      return { payload: {
        video_uri: video.uri,
        media_type: result.media_type,
        ...(thumbRef ? { thumbnail_uri: thumbRef.uri } : {}),
        scene_count: scenes.length,
        degraded_scenes: degraded,
        ...(result.duration_sec !== undefined ? { duration_sec: result.duration_sec } : {}),
        ...(result.render_time_sec !== undefined ? { render_time_sec: result.render_time_sec } : {}),
        renderer: renderer.id,
        ...(jobId ? { job_id: jobId } : {}),
      }, blobs };
    },
  };
}
