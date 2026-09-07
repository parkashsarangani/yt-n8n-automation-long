import type { WorkerDef, WorkerOutput } from "../runner.ts";

interface AssetBeat {
  id: string;
  scene_index: number;
  status: "resolved" | "fallback" | "unavailable";
  resolved_mode: "stock_video" | "generated_image" | "motion_graphic" | "generated_video" | null;
  semantic_verified: boolean;
  generic_filler?: boolean;
  why_failure?: boolean;
  note?: string;
}
interface AssetArtifact { beats: AssetBeat[] }
interface TimelineBeat {
  id: string;
  scene_index: number;
  image_uri?: string;
  video_uri?: string;
  template_category?: "explanation";
}
interface VisualTimeline { beats: TimelineBeat[]; total_duration_sec: number }

export interface VisualBeatReleaseAssessment {
  failures: string[];
  warnings: string[];
  fallbackScenes: number;
  fallbackRatio: number;
}

/**
 * Production release gate for the RFC 0010 beat resolver.
 *
 * A declared alternate is not degradation: it is an authored semantic fallback.
 * Therefore alternates are reported, not failed. What blocks rendering is an
 * unavailable beat, generic filler, an explicit why-failure, a timeline/asset
 * mismatch, or a beat with no renderable payload.
 */
export function assessVisualBeatRelease(
  assets: AssetArtifact,
  timeline: VisualTimeline,
): VisualBeatReleaseAssessment {
  const failures: string[] = [];
  const warnings: string[] = [];
  const assetById = new Map(assets.beats.map((beat) => [beat.id, beat]));
  const timelineById = new Map(timeline.beats.map((beat) => [beat.id, beat]));

  for (const beat of assets.beats) {
    if (beat.status === "unavailable" || !beat.resolved_mode) failures.push(`${beat.id}: unavailable visual`);
    if (beat.generic_filler) failures.push(`${beat.id}: generic filler`);
    if (beat.why_failure) failures.push(`${beat.id}: why-failure`);
    if (!timelineById.has(beat.id) && beat.status !== "unavailable") failures.push(`${beat.id}: missing from visual timeline`);
  }
  for (const beat of timeline.beats) {
    if (!assetById.has(beat.id)) failures.push(`${beat.id}: timeline beat has no resolver asset`);
    if (!(beat.image_uri || beat.video_uri || beat.template_category)) failures.push(`${beat.id}: timeline beat has no renderable payload`);
  }
  if (!(timeline.total_duration_sec > 0)) failures.push("visual timeline has non-positive duration");

  const unverified = assets.beats.filter((beat) => !beat.semantic_verified && beat.status !== "unavailable");
  if (unverified.length) {
    warnings.push(`${unverified.length} beat(s) were admitted without direct pixel verification (proxy/QA-unavailable path)`);
  }
  const alternate = assets.beats.filter((beat) => beat.status === "fallback");
  if (alternate.length) warnings.push(`${alternate.length} beat(s) used their declared semantic alternate`);

  const sceneIds = new Set(assets.beats.map((beat) => beat.scene_index));
  const fallbackSceneIds = new Set(alternate.map((beat) => beat.scene_index));
  const fallbackScenes = fallbackSceneIds.size;
  const fallbackRatio = sceneIds.size ? fallbackScenes / sceneIds.size : 0;
  return {
    failures: [...new Set(failures)],
    warnings: [...new Set(warnings)].slice(0, 30),
    fallbackScenes,
    fallbackRatio,
  };
}

export function makeVisualBeatReleaseWorker(): WorkerDef {
  return {
    name: "visual_beat_release",
    kind: "worker",
    version: "1",
    consumes: [
      { schema_id: "visual_beat_assets", range: "^1", as: "assets" },
      { schema_id: "visual_timeline", range: "^1", as: "timeline" },
    ],
    produces: "visual_asset_release",
    produces_version: "1.0.0",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const assessment = assessVisualBeatRelease(
        inputs["assets"]!.payload as AssetArtifact,
        inputs["timeline"]!.payload as VisualTimeline,
      );
      for (const warning of assessment.warnings) ctx.logger.warn(`[visual_beat_release] WARN ${warning}`);
      if (assessment.failures.length) {
        throw new Error(`visual beat release blocked before render: ${assessment.failures.join("; ")}`);
      }
      return {
        payload: {
          status: "pass",
          blank_scenes: 0,
          fallback_scenes: assessment.fallbackScenes,
          fallback_ratio: assessment.fallbackRatio,
          remaining_hero_shots: [],
          critical_failures: [],
          warnings: assessment.warnings.map((warning) => warning.slice(0, 1600)),
        },
      };
    },
  };
}
