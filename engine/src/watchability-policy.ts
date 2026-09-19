/**
 * Release surface for the watchability critic.
 *
 * 2026-09-19: DEMOTED TO A CRASH GUARD. The critic is a model scoring another
 * model's output, and the two share training priors, so it plausibly rewards
 * tidy, well-organised prose of exactly the kind viewers skip. It has never
 * been correlated with any real YouTube metric. Tuning against it can lower
 * real retention while its scores rise, which means an editorial floor built
 * on it filters the catalogue on an axis we cannot justify -- and, because the
 * bias applies at the bottom of the range too, it is not trustworthy as a
 * quality gate in either direction.
 *
 * So the numeric surface now sits at the material-weakness floor: it catches
 * output that is genuinely broken (a missing or malformed dimension, a score
 * so low the script is unusable) and nothing else. An ordinary script passes
 * on the first attempt and is not regenerated. That is the point -- under the
 * old editorial floors a `revise` verdict burned two extra paid reasoning
 * calls per episode chasing a score we no longer treat as evidence.
 *
 * What is still a hard boundary, deliberately, because publishing is
 * unattended and public: an explicit critic abandonment, a materially weak
 * structural dimension, a malformed report, and the growth-package contract.
 *
 * The editorial floors are preserved below as PRE_FREEZE_EDITORIAL_THRESHOLDS,
 * not deleted. When retention data exists and the critic has been validated
 * against a metric it does NOT score (raw watch time -- correlating it against
 * its own dimensions risks rediscovering the shared-prior artifact), restoring
 * an editorial surface means promoting those values back, informed by which
 * dimensions actually predicted retention.
 */

/**
 * A dimension STRICTLY BELOW this is broken, not merely weak. Every comparison
 * against it uses `<`, so exactly 0.50 passes -- worth stating precisely now
 * that this constant is the live release gate rather than a floor beneath one.
 */
export const MATERIAL_WEAKNESS_FLOOR = 0.50;

/**
 * The editorial surface in force from 2026-09-08 until the 2026-09-19 freeze.
 * Retained as the starting point for a validated surface; NOT used for gating.
 */
export const PRE_FREEZE_EDITORIAL_THRESHOLDS = {
  hook: 0.80,
  first_30_fidelity: 0.80,
  package_fidelity: 0.75,
  suspense: 0.75,
  watchability: 0.75,
  entertainment: 0.70,
  payoff: 0.75,
  youtube_fit: 0.75,
} as const;
export const PRE_FREEZE_EDITORIAL_AVERAGE_THRESHOLD = 0.75;

/**
 * The live gate. Every dimension sits at the crash-guard floor: uniform, and
 * deliberately duration-independent, because "is this output broken" does not
 * depend on how long the episode is.
 */
export const WATCHABILITY_THRESHOLDS = {
  hook: MATERIAL_WEAKNESS_FLOOR,
  first_30_fidelity: MATERIAL_WEAKNESS_FLOOR,
  package_fidelity: MATERIAL_WEAKNESS_FLOOR,
  suspense: MATERIAL_WEAKNESS_FLOOR,
  watchability: MATERIAL_WEAKNESS_FLOOR,
  entertainment: MATERIAL_WEAKNESS_FLOOR,
  payoff: MATERIAL_WEAKNESS_FLOOR,
  youtube_fit: MATERIAL_WEAKNESS_FLOOR,
} as const;

export const WATCHABILITY_AVERAGE_THRESHOLD = MATERIAL_WEAKNESS_FLOOR;

/**
 * Bump this on ANY change to the numeric release surface above (per-dimension
 * floors, aggregate, material-weakness floor, or the duration-profile shape).
 * It is one component of the watchability evaluation fingerprint, so a policy
 * change correctly invalidates every cached canonical decision -- an old
 * approval must not carry forward under new floors.
 */
export const WATCHABILITY_POLICY_VERSION = "2026-09-19-crash-guard-v1";

/**
 * The duration profile is retained (the mode is still reported, and
 * script-revision uses the profile to shape revision directives), but while
 * the surface is a crash guard there is nothing duration-specific to relax:
 * compact and long form hold identical floors.
 */
export const COMPACT_WATCHABILITY_THRESHOLDS = { ...WATCHABILITY_THRESHOLDS } as const;
export const COMPACT_WATCHABILITY_AVERAGE_THRESHOLD = WATCHABILITY_AVERAGE_THRESHOLD;
export const COMPACT_MAX_DURATION_SEC = 90;
export const LONG_FORM_MIN_DURATION_SEC = 180;

/**
 * Real evaluations before the best failed draft is accepted for a final
 * evaluation. Operator-set to 3 on 2026-09-08 (from 6): two regenerations plus
 * the best-of-N final. The final schema-valid attempt may be accepted below
 * the editorial bar so the human editor, rather than a noisy critic, owns the
 * final visual and polish decision. Under the crash guard an ordinary script
 * passes first time, so this budget now only applies to broken output.
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
