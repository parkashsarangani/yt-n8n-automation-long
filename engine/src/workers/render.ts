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

import type { Artifact, BlobRef } from "../artifact.ts";
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
interface CastCharacter {
  character_id: string;
  name: string;
  color_palette?: string[];
}

// A small, caption-readable palette for a character whose cast entry has no
// color_palette. Picked once per character_id via a stable hash so the same
// character keeps the same color across every scene of the episode, without
// needing every cast fixture to supply one.
const FALLBACK_SPEAKER_COLORS = ["#7EC8E3", "#FFB86B", "#B8E986", "#FF8FA3", "#C9A6F5", "#FFE066"];

function stableHash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function speakerColorFor(character: CastCharacter): string {
  const supplied = character.color_palette?.find((c) => /^#[0-9A-Fa-f]{6}$/.test(c));
  if (supplied) return supplied;
  return FALLBACK_SPEAKER_COLORS[stableHash(character.character_id) % FALLBACK_SPEAKER_COLORS.length]!;
}

/**
 * Which cast member is speaking in this compiled cartoon scene, if any. The
 * active speaker is whichever compiled character carries isSpeaking: true -
 * the same field Character.tsx already uses for the on-screen emphasis
 * treatment, so caption color and rig emphasis always agree on who's talking.
 */
function resolveSpeaker(
  templateData: Record<string, unknown> | undefined,
  castByActorId: Map<string, CastCharacter>,
): { name: string; color: string } | undefined {
  if (!templateData || castByActorId.size === 0) return undefined;
  const characters = templateData["characters"];
  if (!Array.isArray(characters)) return undefined;
  const speaking = characters.find(
    (c): c is Record<string, unknown> =>
      Boolean(c) && typeof c === "object" && (c as Record<string, unknown>)["isSpeaking"] === true,
  );
  const actorId = speaking?.["actorId"];
  if (typeof actorId !== "string") return undefined;
  const character = castByActorId.get(actorId);
  if (!character) return undefined;
  return { name: character.name, color: speakerColorFor(character) };
}

async function buildScenes(
  inputs: Record<string, Artifact>,
  ctx: WorkerContext,
  castByActorId: Map<string, CastCharacter>,
): Promise<RenderScene[]> {
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
    const templateData = asset?.template_data
      ? (JSON.parse(asset.template_data) as Record<string, unknown>)
      : undefined;
    const speaker = resolveSpeaker(templateData, castByActorId);

    scenes.push({
      scene_index: scene.scene_index,
      audio,
      audio_media_type: "audio/mpeg",
      ...(video ? { video, video_media_type: "video/mp4" } : {}),
      ...(image ? { image, image_media_type: "image/png" } : {}),
      ...(alignment !== undefined ? { alignment } : {}),
      ...(scene.is_outro ? { is_outro: true } : {}),
      ...(asset?.template_category ? { template_category: asset.template_category } : {}),
      ...(templateData ? { template_data: templateData } : {}),
      ...(speaker ? { speaker_name: speaker.name, speaker_color: speaker.color } : {}),
    });
  }

  return scenes;
}

async function executeRender(
  inputs: Record<string, Artifact>,
  ctx: WorkerContext,
  opts: RenderWorkerOptions,
  castByActorId: Map<string, CastCharacter>,
): Promise<WorkerOutput> {
  const renderer = ctx.media.renderer;
  if (!renderer) {
    throw new Error("render worker requires a media renderer (media.renderer)");
  }

  const scenes = await buildScenes(inputs, ctx, castByActorId);

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
}

const NO_CAST = new Map<string, CastCharacter>();

/** script + voice + asset_manifest -> rendered_video. Shared by every graph, including manual.json, which has no cast_roster - captions render without a speaker color/name here. */
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
    execute: (inputs, ctx) => executeRender(inputs, ctx, opts, NO_CAST),
  };
}

/**
 * Cartoon-only variant: also consumes cast_roster so captions can carry the
 * active speaker's name/color, resolved from the same isSpeaking character
 * the on-screen rig emphasis already uses. Not wired into manual.json, which
 * has no cast_roster artifact - that graph keeps using plain "render".
 */
export function makeCartoonRenderWorker(opts: RenderWorkerOptions = {}): WorkerDef {
  return {
    name: "cartoon_render",
    kind: "worker",
    version: opts.version ?? "1",
    consumes: [
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "voice", range: "^1", as: "voice" },
      { schema_id: "asset_manifest", range: "^1", as: "assets" },
      { schema_id: "cast_roster", range: "^1", as: "cast" },
    ],
    produces: "rendered_video",
    execute: (inputs, ctx) => {
      const cast = (inputs["cast"]!.payload as { characters: CastCharacter[] }).characters;
      const castByActorId = new Map(cast.map((c) => [c.character_id, c]));
      return executeRender(inputs, ctx, opts, castByActorId);
    },
  };
}
