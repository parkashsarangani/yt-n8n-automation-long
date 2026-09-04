import type { WorkerDef, WorkerOutput } from "../runner.ts";

const MAX_FALLBACK_RATIO = 0.1;
const VISUAL_REVIEW_WARN_FLOOR = 0.68;
const VISUAL_REVIEW_FAIL_FLOOR = 0.55;
const CRITICAL_VISUAL_SCORES = ["opening_visual_strength", "payoff_visual_strength", "continuity", "ai_artifacts"] as const;

type Scene = { source?: unknown; hero_shot_ids?: unknown };
type VisualReview = {
  status?: unknown;
  remaining_flagged_shots?: unknown;
  scores?: unknown;
  reason?: unknown;
};
type AssetPayload = {
  scenes?: unknown;
  degraded_count?: unknown;
  visual_review?: unknown;
};

export interface VisualAssetAssessment {
  failures: string[];
  warnings: string[];
  blankScenes: number;
  fallbackScenes: number;
  fallbackRatio: number;
  remainingHeroShots: string[];
  criticalFailures: string[];
}

function finiteScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Pre-render version of the visual-only checks that final QA performs later.
 * It deliberately does not replace final QA; it only prevents spending a long
 * CPU render on an asset manifest that is already guaranteed to fail there.
 */
export function assessVisualAssetRelease(payload: unknown): VisualAssetAssessment {
  const p = payload && typeof payload === "object" ? payload as AssetPayload : {};
  const scenes = Array.isArray(p.scenes) ? p.scenes.filter((s): s is Scene => Boolean(s) && typeof s === "object") : [];
  const sceneCount = scenes.length;
  const blankScenes = scenes.filter((scene) => scene.source === "placeholder").length;
  const degraded = typeof p.degraded_count === "number" && Number.isFinite(p.degraded_count)
    ? Math.max(0, Math.floor(p.degraded_count))
    : blankScenes;
  const fallbackScenes = Math.max(0, degraded - blankScenes);
  const fallbackRatio = sceneCount > 0 ? fallbackScenes / sceneCount : 0;
  const failures: string[] = [];
  const warnings: string[] = [];

  if (blankScenes > 0) failures.push(`${blankScenes} scene(s) are blank placeholders`);
  if (fallbackScenes > 0) {
    const message = `${fallbackScenes}/${sceneCount} scene(s) contain fallback imagery (${Math.round(fallbackRatio * 100)}%)`;
    if (fallbackRatio > MAX_FALLBACK_RATIO) failures.push(`${message}; maximum is ${Math.round(MAX_FALLBACK_RATIO * 100)}%`);
    else warnings.push(message);
  }

  const heroIds = new Set(
    scenes.flatMap((scene) => Array.isArray(scene.hero_shot_ids)
      ? scene.hero_shot_ids.filter((id): id is string => typeof id === "string")
      : []),
  );
  const review = p.visual_review && typeof p.visual_review === "object" ? p.visual_review as VisualReview : null;
  const remaining = review && Array.isArray(review.remaining_flagged_shots)
    ? review.remaining_flagged_shots.filter((id): id is string => typeof id === "string")
    : [];
  const remainingHeroShots = remaining.filter((id) => heroIds.has(id));
  if (remainingHeroShots.length > 0) {
    failures.push(`hero shot(s) remain flagged after targeted regeneration: ${remainingHeroShots.join(", ")}`);
  }

  const scores = review?.scores && typeof review.scores === "object"
    ? review.scores as Record<string, unknown>
    : {};
  const criticalFailures = CRITICAL_VISUAL_SCORES.flatMap((key) => {
    const value = scores[key];
    return finiteScore(value) && value < VISUAL_REVIEW_FAIL_FLOOR ? [`${key}=${value.toFixed(2)}`] : [];
  });
  if (criticalFailures.length > 0) {
    failures.push(`critical visual-review score below ${VISUAL_REVIEW_FAIL_FLOOR.toFixed(2)}: ${criticalFailures.join(", ")}`);
  }

  if (review?.status === "unavailable") {
    warnings.push(typeof review.reason === "string" && review.reason.trim()
      ? review.reason.trim()
      : "episode-level visual review unavailable");
  } else {
    const nonHeroRemaining = remaining.filter((id) => !heroIds.has(id));
    if (nonHeroRemaining.length > 0) warnings.push(`${nonHeroRemaining.length} non-hero shot(s) remain flagged: ${nonHeroRemaining.join(", ")}`);
    const numeric = Object.values(scores).filter(finiteScore);
    const minScore = numeric.length ? Math.min(...numeric) : null;
    if (review?.status === "warn" || (minScore !== null && minScore < VISUAL_REVIEW_WARN_FLOOR)) {
      warnings.push(typeof review?.reason === "string" && review.reason.trim()
        ? review.reason.trim()
        : `visual review minimum score ${minScore?.toFixed(2)} below ${VISUAL_REVIEW_WARN_FLOOR.toFixed(2)}`);
    }
  }

  return { failures, warnings, blankScenes, fallbackScenes, fallbackRatio, remainingHeroShots, criticalFailures };
}

export function makeVisualAssetReleaseWorker(): WorkerDef {
  return {
    name: "visual_asset_release",
    kind: "worker",
    version: "1",
    consumes: [{ schema_id: "asset_manifest", range: ">=1 <3", as: "assets" }],
    produces: "visual_asset_release",
    produces_version: "1.0.0",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const assessment = assessVisualAssetRelease(inputs["assets"]!.payload);
      for (const warning of assessment.warnings) ctx.logger.warn(`[visual_asset_release] WARN ${warning}`);
      if (assessment.failures.length > 0) {
        throw new Error(`visual asset release blocked before render: ${assessment.failures.join("; ")}`);
      }
      return {
        payload: {
          status: "pass",
          blank_scenes: assessment.blankScenes,
          fallback_scenes: assessment.fallbackScenes,
          fallback_ratio: assessment.fallbackRatio,
          remaining_hero_shots: assessment.remainingHeroShots,
          critical_failures: assessment.criticalFailures,
          warnings: assessment.warnings,
        },
      };
    },
  };
}
