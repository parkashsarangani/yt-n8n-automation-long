/**
 * Canonical long-form production release floors.
 *
 * Set deliberately by the operator on 2026-09-08 (revised from
 * hook 0.82 / first_30 0.80 / package 0.84 / suspense 0.75 / watchability 0.78 /
 * entertainment 0.72 / payoff 0.75 / youtube_fit 0.75). This is an intentional
 * product-policy change, not a temporary test bypass: three structurally-sound
 * 240s scripts were each rejected because one axis — usually a different one
 * each run, given the critic's ~+/-0.05 scoring variance — sat a few
 * hundredths under a floor that demanded a near-exceptional score before an
 * episode could even reach production. The critic stays a real quality gate;
 * it is no longer a near-perfect-score gate.
 */
export const WATCHABILITY_THRESHOLDS = {
  hook: 0.80,
  first_30_fidelity: 0.80,
  package_fidelity: 0.75,
  suspense: 0.75,
  watchability: 0.75,
  entertainment: 0.70,
  payoff: 0.75,
  youtube_fit: 0.75,
} as const;

// Operator-set on 2026-09-08 alongside the per-dimension floors above (from
// 0.79). The aggregate stays a genuine gate — below the mean of the individual
// floors — but no longer demands a near-exceptional overall score.
export const WATCHABILITY_AVERAGE_THRESHOLD = 0.75;

/**
 * Bump this on ANY change to the numeric release surface above (per-dimension
 * floors, aggregate, material-weakness floor, or the duration-profile shape).
 * It is one component of the watchability evaluation fingerprint, so a policy
 * change correctly invalidates every cached canonical decision — an old
 * approval must not carry forward under new floors.
 */
export const WATCHABILITY_POLICY_VERSION = "2026-09-10-binding-verdict-v3";
// Operator-set 2026-09-08 (from 0.55): a dimension this low still flips the
// verdict to ABANDON_TOPIC rather than REVISE_SCRIPT.
export const MATERIAL_WEAKNESS_FLOOR = 0.50;

/**
 * Compact production probes (<=90s) keep the concept of a duration-specific
 * surface: first-30 and suspense are relaxed by 0.10 from the long-form floor
 * because 30 seconds is already one third to one half of the whole episode.
 * Every other dimension inherits the canonical long-form floor. The compact
 * aggregate keeps its historical 0.02 relaxation below the long-form aggregate
 * (a compact probe must never be held to a stricter bar than long form).
 */
export const COMPACT_WATCHABILITY_THRESHOLDS = {
  ...WATCHABILITY_THRESHOLDS,
  first_30_fidelity: 0.70,
  suspense: 0.65,
} as const;
export const COMPACT_WATCHABILITY_AVERAGE_THRESHOLD = 0.73;
export const COMPACT_MAX_DURATION_SEC = 90;
export const LONG_FORM_MIN_DURATION_SEC = 180;

/**
 * Real evaluations before the best failed draft is accepted for a final
 * evaluation. Operator-set to 3 on 2026-09-08 (from 6): two regenerations plus
 * the best-of-N final. RFC 0009 never turns this bound into an unconditional
 * pass.
 */
export const MAX_ATTEMPTS_BEFORE_ACCEPTING = 3;

export type WatchabilityDimension = keyof typeof WATCHABILITY_THRESHOLDS;
export type WatchabilityThresholds = Record<WatchabilityDimension, number>;

export interface WatchabilityProfile {
  thresholds: WatchabilityThresholds;
  averageThreshold: number;
  mode: "compact" | "transition" | "long_form";
  targetDurationSec: number | null;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round((a + (b - a) * t) * 1000) / 1000;
}

/**
 * Duration-aware release surface. Missing/invalid duration keeps the existing
 * long-form contract. <=90s uses the compact probe profile; >=180s is exactly
 * the historical production profile; the gap interpolates smoothly.
 */
export function watchabilityProfile(targetDurationSec?: number | null): WatchabilityProfile {
  if (typeof targetDurationSec !== "number" || !Number.isFinite(targetDurationSec) || targetDurationSec <= 0) {
    return {
      thresholds: { ...WATCHABILITY_THRESHOLDS },
      averageThreshold: WATCHABILITY_AVERAGE_THRESHOLD,
      mode: "long_form",
      targetDurationSec: null,
    };
  }
  if (targetDurationSec <= COMPACT_MAX_DURATION_SEC) {
    return {
      thresholds: { ...COMPACT_WATCHABILITY_THRESHOLDS },
      averageThreshold: COMPACT_WATCHABILITY_AVERAGE_THRESHOLD,
      mode: "compact",
      targetDurationSec,
    };
  }
  if (targetDurationSec >= LONG_FORM_MIN_DURATION_SEC) {
    return {
      thresholds: { ...WATCHABILITY_THRESHOLDS },
      averageThreshold: WATCHABILITY_AVERAGE_THRESHOLD,
      mode: "long_form",
      targetDurationSec,
    };
  }

  const t = (targetDurationSec - COMPACT_MAX_DURATION_SEC) / (LONG_FORM_MIN_DURATION_SEC - COMPACT_MAX_DURATION_SEC);
  return {
    thresholds: {
      ...WATCHABILITY_THRESHOLDS,
      first_30_fidelity: lerp(COMPACT_WATCHABILITY_THRESHOLDS.first_30_fidelity, WATCHABILITY_THRESHOLDS.first_30_fidelity, t),
      suspense: lerp(COMPACT_WATCHABILITY_THRESHOLDS.suspense, WATCHABILITY_THRESHOLDS.suspense, t),
    },
    averageThreshold: lerp(COMPACT_WATCHABILITY_AVERAGE_THRESHOLD, WATCHABILITY_AVERAGE_THRESHOLD, t),
    mode: "transition",
    targetDurationSec,
  };
}

/**
 * Distance from the deterministic release surface. Zero means the numeric
 * thresholds all pass. Missing dimensions are deliberately expensive so a
 * malformed report can never look competitive in best-of-N selection.
 */
export function watchabilityReleaseDeficit(
  scores: Partial<Record<WatchabilityDimension, unknown>>,
  rawAverage: number,
  profile: WatchabilityProfile = watchabilityProfile(),
): number {
  let deficit = 0;
  for (const [dimension, threshold] of Object.entries(profile.thresholds) as Array<[WatchabilityDimension, number]>) {
    const score = scores[dimension];
    if (typeof score !== "number" || !Number.isFinite(score)) {
      deficit += threshold;
      continue;
    }
    deficit += Math.max(0, threshold - score);
  }
  deficit += Math.max(0, profile.averageThreshold - rawAverage);
  return deficit;
}
