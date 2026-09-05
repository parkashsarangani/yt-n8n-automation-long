import type { WorkerDef, WorkerOutput } from "../runner.ts";
import type { VisualBeatPlan, VisualMode } from "../visual-routing.ts";

interface VoiceClip {
  scene_index: number;
  audio_uri: string;
  media_type?: string;
  duration_sec: number;
}
interface VoiceArtifact { clips: VoiceClip[] }

interface AssetBeat {
  id: string;
  scene_index: number;
  beat_index: number;
  start_sec: number;
  end_sec: number;
  status: "resolved" | "fallback" | "unavailable";
  resolved_mode: VisualMode | null;
  narration: string;
  viewer_takeaway: string;
  image_uri?: string;
  video_uri?: string;
  preview_uri?: string;
  template_category?: "explanation";
  template_data?: string;
  composition: string;
  camera_treatment: string;
  subject_placement: string;
  explanatory_pattern: string;
}
interface AssetArtifact { beats: AssetBeat[] }

export function makeVisualTimelineWorker(): WorkerDef {
  return {
    name: "visual_timeline",
    kind: "worker",
    version: "1",
    consumes: [
      { schema_id: "visual_beat_plan", range: "^1", as: "plan" },
      { schema_id: "visual_beat_assets", range: "^1", as: "assets" },
      { schema_id: "voice", range: "^1", as: "voice" },
    ],
    produces: "visual_timeline",
    produces_version: "1.0.0",

    async execute(inputs): Promise<WorkerOutput> {
      const plan = inputs["plan"]!.payload as VisualBeatPlan;
      const assets = inputs["assets"]!.payload as AssetArtifact;
      const voice = inputs["voice"]!.payload as VoiceArtifact;
      const planById = new Map(plan.beats.map((beat) => [beat.id, beat]));
      const clipByScene = new Map(voice.clips.map((clip) => [clip.scene_index, clip]));
      const orderedClips = [...voice.clips].sort((a, b) => a.scene_index - b.scene_index);
      const sceneOffset = new Map<number, number>();
      let cursor = 0;
      for (const clip of orderedClips) {
        sceneOffset.set(clip.scene_index, cursor);
        cursor += clip.duration_sec;
      }
      if (!(cursor > 0)) throw new Error("visual_timeline: voice artifact has no positive duration");

      const ordered = [...assets.beats].sort((a, b) => a.scene_index - b.scene_index || a.beat_index - b.beat_index);
      const output: Array<Record<string, unknown>> = [];
      const priorEndByScene = new Map<number, number>();

      for (let ordinal = 0; ordinal < ordered.length; ordinal++) {
        const asset = ordered[ordinal]!;
        if (asset.status === "unavailable" || !asset.resolved_mode) {
          throw new Error(`${asset.id}: visual resolver left the beat unavailable; benchmark refuses placeholder/filler rendering`);
        }
        const planBeat = planById.get(asset.id);
        if (!planBeat) throw new Error(`${asset.id}: selected asset has no matching VisualBeat contract`);
        const clip = clipByScene.get(asset.scene_index);
        const offset = sceneOffset.get(asset.scene_index);
        if (!clip || offset === undefined) throw new Error(`${asset.id}: no matching voice clip/offset`);
        if (!(asset.end_sec > asset.start_sec) || asset.start_sec < -0.01 || asset.end_sec > clip.duration_sec + 0.08) {
          throw new Error(`${asset.id}: measured scene timing ${asset.start_sec}-${asset.end_sec}s is outside voice duration ${clip.duration_sec}s`);
        }
        const previousEnd = priorEndByScene.get(asset.scene_index);
        if (previousEnd !== undefined && Math.abs(asset.start_sec - previousEnd) > 0.08) {
          throw new Error(`${asset.id}: audio-aligned visual beats have a ${asset.start_sec - previousEnd > 0 ? "gap" : "overlap"} of ${Math.abs(asset.start_sec - previousEnd).toFixed(3)}s`);
        }
        priorEndByScene.set(asset.scene_index, asset.end_sec);

        const absoluteStart = offset + asset.start_sec;
        const absoluteEnd = offset + asset.end_sec;
        const hasVisual = Boolean(asset.image_uri || asset.video_uri || (asset.template_category && asset.template_data));
        if (!hasVisual) throw new Error(`${asset.id}: resolved mode ${asset.resolved_mode} has no renderable visual payload`);

        output.push({
          id: asset.id,
          ordinal,
          scene_index: asset.scene_index,
          beat_index: asset.beat_index,
          scene_start_sec: Number(asset.start_sec.toFixed(3)),
          scene_end_sec: Number(asset.end_sec.toFixed(3)),
          absolute_start_sec: Number(absoluteStart.toFixed(3)),
          absolute_end_sec: Number(absoluteEnd.toFixed(3)),
          duration_sec: Number((absoluteEnd - absoluteStart).toFixed(3)),
          audio_uri: clip.audio_uri,
          audio_media_type: clip.media_type?.trim() || "audio/mpeg",
          resolved_mode: asset.resolved_mode,
          ...(asset.image_uri ? { image_uri: asset.image_uri } : {}),
          ...(asset.video_uri ? { video_uri: asset.video_uri } : {}),
          ...(asset.preview_uri ? { preview_uri: asset.preview_uri } : {}),
          ...(asset.template_category ? { template_category: asset.template_category } : {}),
          ...(asset.template_data ? { template_data: asset.template_data } : {}),
          narration: asset.narration,
          viewer_takeaway: asset.viewer_takeaway,
          continuity_group: planBeat.continuity.group,
          continuity_entities: planBeat.continuity.entities,
          composition: asset.composition,
          camera_treatment: asset.camera_treatment,
          subject_placement: asset.subject_placement,
          explanatory_pattern: asset.explanatory_pattern,
        });
      }

      // Every voice scene represented in the visual plan must cover the full
      // clip. This catches a Visual Director that dropped trailing narration.
      const plannedScenes = new Set(plan.beats.map((beat) => beat.scene_index));
      for (const sceneIndex of plannedScenes) {
        const clip = clipByScene.get(sceneIndex)!;
        const end = priorEndByScene.get(sceneIndex);
        if (end === undefined || Math.abs(end - clip.duration_sec) > 0.08) {
          throw new Error(`scene ${sceneIndex}: visual timeline ends at ${end ?? "missing"}s but voice lasts ${clip.duration_sec}s`);
        }
      }

      return { payload: { beats: output, total_duration_sec: Number(cursor.toFixed(3)) } };
    },
  };
}
