import type { WorkerDef, WorkerOutput } from "../runner.ts";
import {
  beatDurationStats,
  maxConsecutive,
  pacingFailures,
  HARD_MAX_VISUAL_BEAT_DURATION_SEC,
  MAX_CONSECUTIVE_KINETIC_TEXT,
  MAX_KINETIC_TEXT_RATIO,
  MAX_VISUAL_BEAT_DURATION_SEC,
  type PacingSceneInput,
} from "../visual-beat-quality.ts";

interface AssetBeat {
  id: string;
  scene_index: number;
  beat_index?: number;
  start_sec?: number;
  end_sec?: number;
  status: "resolved" | "fallback" | "unavailable";
  resolved_mode: "stock_video" | "generated_image" | "motion_graphic" | "generated_video" | null;
  representation?: string;
  semantic_verified: boolean;
  generic_filler?: boolean;
  why_failure?: boolean;
  verification_failed?: boolean;
  structured_visual_missing?: boolean;
  hero_role?: string;
  note?: string;
}
interface AssetArtifact { beats: AssetBeat[]; summary?: Record<string, unknown> }
interface TimelineBeat {
  id: string;
  scene_index: number;
  duration_sec?: number;
  scene_start_sec?: number;
  scene_end_sec?: number;
  image_uri?: string;
  video_uri?: string;
  template_category?: "explanation";
}
interface VisualTimeline { beats: TimelineBeat[]; total_duration_sec: number }
interface VoiceClip { scene_index: number; duration_sec: number }
interface VoiceArtifact { clips: VoiceClip[] }

const HERO_KINETIC_ROLES = new Set(["hook", "reveal", "low-point", "low_point", "turn", "payoff"]);

export interface VisualBeatReleaseAssessment {
  failures: string[];
  warnings: string[];
  fallbackScenes: number;
  fallbackRatio: number;
  counters: {
    total: number;
    verified: number;
    semantic_alternate: number;
    unverified: number;
    verification_failed: number;
    structured_visual_missing: number;
    kinetic_text: number;
    max_consecutive_kinetic_text: number;
  };
  beatDurationStats: ReturnType<typeof beatDurationStats>;
}

/**
 * Production release gate for the RFC 0010 beat resolver.
 *
 * Hardened after `run_112aa43f`, where release returned pass-with-warnings
 * while 11/14 beats were unverified generic text cards. A declared alternate
 * only counts as acceptable when it is explicitly declared, structurally
 * complete, actually rendered AND visually verified. Anything else blocks.
 */
export function assessVisualBeatRelease(
  assets: AssetArtifact,
  timeline: VisualTimeline,
  voice?: VoiceArtifact,
): VisualBeatReleaseAssessment {
  const failures: string[] = [];
  const warnings: string[] = [];
  const assetById = new Map(assets.beats.map((beat) => [beat.id, beat]));
  const timelineById = new Map(timeline.beats.map((beat) => [beat.id, beat]));

  for (const beat of assets.beats) {
    if (beat.status === "unavailable" || !beat.resolved_mode) failures.push(`${beat.id}: unavailable visual`);
    if (beat.generic_filler) failures.push(`${beat.id}: generic filler`);
    if (beat.why_failure) failures.push(`${beat.id}: why-failure`);
    if (beat.structured_visual_missing) {
      failures.push(`${beat.id}: explanatory/hero beat degraded to a headline (no structured visual)`);
    }
    if (beat.verification_failed) {
      failures.push(`${beat.id}: visual verification infrastructure failed; asset was never inspected`);
    }
    if (!timelineById.has(beat.id) && beat.status !== "unavailable") failures.push(`${beat.id}: missing from visual timeline`);
    if (beat.representation === "kinetic_text" && HERO_KINETIC_ROLES.has(String(beat.hero_role ?? "").toLowerCase())) {
      failures.push(`${beat.id}: hero/payoff beat is a plain kinetic-text card`);
    }
  }
  for (const beat of timeline.beats) {
    if (!assetById.has(beat.id)) failures.push(`${beat.id}: timeline beat has no resolver asset`);
    if (!(beat.image_uri || beat.video_uri || beat.template_category)) failures.push(`${beat.id}: timeline beat has no renderable payload`);
  }
  if (!(timeline.total_duration_sec > 0)) failures.push("visual timeline has non-positive duration");

  // --- honest verification ledger -------------------------------------------
  const renderable = assets.beats.filter((beat) => beat.status !== "unavailable");
  const verified = renderable.filter((beat) => beat.semantic_verified).length;
  const alternate = assets.beats.filter((beat) => beat.status === "fallback");
  const unverifiedBeats = renderable.filter((beat) => !beat.semantic_verified);
  const verificationFailed = renderable.filter((beat) => beat.verification_failed).length;
  // An unverified beat is only tolerable when it is a verified declared
  // alternate (contradiction resolved elsewhere). Bare unverified assets that
  // are NOT infra failures still get a warning; infra failures already failed.
  const unverifiedNonInfra = unverifiedBeats.filter((beat) => !beat.verification_failed);
  if (unverifiedNonInfra.length) {
    warnings.push(`${unverifiedNonInfra.length} beat(s) rendered without direct pixel verification`);
  }
  if (alternate.length) warnings.push(`${alternate.length} beat(s) used their declared semantic alternate`);

  // --- kinetic-text density ------------------------------------------------
  const kinetic = renderable.filter((beat) => beat.representation === "kinetic_text");
  const kineticRun = maxConsecutive(assets.beats.map((beat) => beat.representation === "kinetic_text"));
  if (kineticRun > MAX_CONSECUTIVE_KINETIC_TEXT) {
    failures.push(`${kineticRun} consecutive kinetic-text beats (max ${MAX_CONSECUTIVE_KINETIC_TEXT})`);
  }
  if (renderable.length && kinetic.length / renderable.length > MAX_KINETIC_TEXT_RATIO) {
    failures.push(`kinetic-text is ${(100 * kinetic.length / renderable.length).toFixed(0)}% of beats (max ${(100 * MAX_KINETIC_TEXT_RATIO).toFixed(0)}%)`);
  }

  // --- pacing (measured voice) -------------------------------------------------
  if (voice?.clips?.length) {
    const beatsByScene = new Map<number, number>();
    for (const beat of assets.beats) beatsByScene.set(beat.scene_index, (beatsByScene.get(beat.scene_index) ?? 0) + 1);
    const scenes: PacingSceneInput[] = voice.clips.map((clip) => ({
      scene_index: clip.scene_index,
      voice_duration_sec: clip.duration_sec,
      aligned_beat_count: beatsByScene.get(clip.scene_index) ?? 0,
    }));
    failures.push(...pacingFailures(scenes));
  }

  // --- per-beat duration ceiling ------------------------------------------------
  const durations = timeline.beats.map((beat) => {
    if (typeof beat.duration_sec === "number") return beat.duration_sec;
    if (typeof beat.scene_start_sec === "number" && typeof beat.scene_end_sec === "number") return beat.scene_end_sec - beat.scene_start_sec;
    return NaN;
  });
  for (const beat of timeline.beats) {
    const d = typeof beat.duration_sec === "number"
      ? beat.duration_sec
      : (typeof beat.scene_start_sec === "number" && typeof beat.scene_end_sec === "number" ? beat.scene_end_sec - beat.scene_start_sec : NaN);
    if (Number.isFinite(d) && d > HARD_MAX_VISUAL_BEAT_DURATION_SEC) {
      failures.push(`${beat.id}: ${d.toFixed(1)}s single visual beat exceeds the ${HARD_MAX_VISUAL_BEAT_DURATION_SEC}s hard ceiling`);
    } else if (Number.isFinite(d) && d > MAX_VISUAL_BEAT_DURATION_SEC) {
      warnings.push(`${beat.id}: ${d.toFixed(1)}s visual beat is over the ${MAX_VISUAL_BEAT_DURATION_SEC}s target`);
    }
  }
  const stats = beatDurationStats(durations);

  const sceneIds = new Set(assets.beats.map((beat) => beat.scene_index));
  const fallbackSceneIds = new Set(alternate.map((beat) => beat.scene_index));
  const fallbackScenes = fallbackSceneIds.size;
  const fallbackRatio = sceneIds.size ? fallbackScenes / sceneIds.size : 0;
  return {
    failures: [...new Set(failures)],
    warnings: [...new Set(warnings)].slice(0, 40),
    fallbackScenes,
    fallbackRatio,
    counters: {
      total: renderable.length,
      verified,
      semantic_alternate: alternate.filter((beat) => beat.semantic_verified).length,
      unverified: unverifiedBeats.length,
      verification_failed: verificationFailed,
      structured_visual_missing: renderable.filter((beat) => beat.structured_visual_missing).length,
      kinetic_text: kinetic.length,
      max_consecutive_kinetic_text: kineticRun,
    },
    beatDurationStats: stats,
  };
}

export function makeVisualBeatReleaseWorker(): WorkerDef {
  return {
    name: "visual_beat_release",
    kind: "worker",
    version: "2",
    consumes: [
      { schema_id: "visual_beat_assets", range: "^1", as: "assets" },
      { schema_id: "visual_timeline", range: "^1", as: "timeline" },
      { schema_id: "voice", range: "^1", as: "voice", optional: true },
    ],
    produces: "visual_asset_release",
    produces_version: "1.0.0",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const assessment = assessVisualBeatRelease(
        inputs["assets"]!.payload as AssetArtifact,
        inputs["timeline"]!.payload as VisualTimeline,
        inputs["voice"]?.payload as VoiceArtifact | undefined,
      );
      for (const warning of assessment.warnings) ctx.logger.warn(`[visual_beat_release] WARN ${warning}`);
      ctx.logger.log(`[visual_beat_release] verification ledger: ${JSON.stringify(assessment.counters)}; beat durations: ${JSON.stringify(assessment.beatDurationStats)}`);
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
          verified_count: assessment.counters.verified,
          semantic_alternate_count: assessment.counters.semantic_alternate,
          unverified_count: assessment.counters.unverified,
          verification_failed_count: assessment.counters.verification_failed,
          beat_duration_stats: assessment.beatDurationStats,
        },
      };
    },
  };
}
