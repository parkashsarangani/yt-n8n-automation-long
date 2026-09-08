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
 * A compact production probe is not a second content architecture. It uses the
 * same quality dimensions, but two duration-sensitive dimensions are calibrated
 * proportionally because 30 seconds is half of a 60-second episode and a long-
 * form multi-loop suspense arc cannot physically fit. All click-promise, hook,
 * payoff and YouTube-fit floors remain identical to long-form.
 */
export const COMPACT_WATCHABILITY_THRESHOLDS = {
  ...WATCHABILITY_THRESHOLDS,
  first_30_fidelity: 0.70,
  suspense: 0.68,
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

export interface WatchabilityPolicy {
  profile: "compact" | "transition" | "long_form";
  targetDurationSec: number | null;
  thresholds: WatchabilityThresholds;
  averageThreshold: number;
}

function finiteDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * One policy surface for critic prompts, revision feedback, release and best-of-N
 * selection. Missing duration intentionally resolves to the established long-
 * form contract so old artifacts/tests never become easier by accident.
 */
export function watchabilityPolicyForDuration(targetDurationSec: unknown): WatchabilityPolicy {
  const duration = finiteDuration(targetDurationSec);
  if (duration === null || duration >= LONG_FORM_MIN_DURATION_SEC) {
    return {
      profile: "long_form",
      targetDurationSec: duration,
      thresholds: { ...WATCHABILITY_THRESHOLDS },
      averageThreshold: WATCHABILITY_AVERAGE_THRESHOLD,
    };
  }
  if (duration <= COMPACT_MAX_DURATION_SEC) {
    return {
      profile: "compact",
      targetDurationSec: duration,
      thresholds: { ...COMPACT_WATCHABILITY_THRESHOLDS },
      averageThreshold: COMPACT_WATCHABILITY_AVERAGE_THRESHOLD,
    };
  }

  const t = (duration - COMPACT_MAX_DURATION_SEC) / (LONG_FORM_MIN_DURATION_SEC - COMPACT_MAX_DURATION_SEC);
  const thresholds = { ...WATCHABILITY_THRESHOLDS } as WatchabilityThresholds;
  thresholds.first_30_fidelity = rounded(lerp(
    COMPACT_WATCHABILITY_THRESHOLDS.first_30_fidelity,
    WATCHABILITY_THRESHOLDS.first_30_fidelity,
    t,
  ));
  thresholds.suspense = rounded(lerp(
    COMPACT_WATCHABILITY_THRESHOLDS.suspense,
    WATCHABILITY_THRESHOLDS.suspense,
    t,
  ));
  return {
    profile: "transition",
    targetDurationSec: duration,
    thresholds,
    averageThreshold: rounded(lerp(COMPACT_WATCHABILITY_AVERAGE_THRESHOLD, WATCHABILITY_AVERAGE_THRESHOLD, t)),
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
  targetDurationSec?: unknown,
): number {
  const policy = watchabilityPolicyForDuration(targetDurationSec);
  let deficit = 0;
  for (const [dimension, threshold] of Object.entries(policy.thresholds) as Array<[WatchabilityDimension, number]>) {
    const score = scores[dimension];
    if (typeof score !== "number" || !Number.isFinite(score)) {
      deficit += threshold;
      continue;
    }
    deficit += Math.max(0, threshold - score);
  }
  deficit += Math.max(0, policy.averageThreshold - rawAverage);
  return deficit;
}
