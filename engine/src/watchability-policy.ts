export const WATCHABILITY_THRESHOLDS = {
  hook: 0.82,
  first_30_fidelity: 0.80,
  package_fidelity: 0.84,
  suspense: 0.75,
  watchability: 0.78,
  entertainment: 0.72,
  payoff: 0.75,
  youtube_fit: 0.75,
} as const;

export const WATCHABILITY_AVERAGE_THRESHOLD = 0.79;
export const MATERIAL_WEAKNESS_FLOOR = 0.55;

/**
 * Compact production probes need a different interpretation only for the
 * dimensions whose time horizon changes materially. The hook/package/payoff
 * bars stay identical to long form; first-30 and suspense are relaxed because
 * 30 seconds is already one third to one half of the whole episode.
 */
export const COMPACT_WATCHABILITY_THRESHOLDS = {
  ...WATCHABILITY_THRESHOLDS,
  first_30_fidelity: 0.70,
  suspense: 0.65,
} as const;
export const COMPACT_WATCHABILITY_AVERAGE_THRESHOLD = 0.77;
export const COMPACT_MAX_DURATION_SEC = 90;
export const LONG_FORM_MIN_DURATION_SEC = 180;

/**
 * Six real evaluations: five generated drafts plus one final evaluation of the
 * best failed draft. RFC 0009 never turns this bound into an unconditional pass.
 */
export const MAX_ATTEMPTS_BEFORE_ACCEPTING = 6;

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
