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
 * Six real evaluations: five generated drafts plus one final evaluation of the
 * best failed draft. RFC 0009 never turns this bound into an unconditional pass.
 */
export const MAX_ATTEMPTS_BEFORE_ACCEPTING = 6;

export type WatchabilityDimension = keyof typeof WATCHABILITY_THRESHOLDS;

/**
 * Distance from the deterministic release surface. Zero means the numeric
 * thresholds all pass. Missing dimensions are deliberately expensive so a
 * malformed report can never look competitive in best-of-N selection.
 */
export function watchabilityReleaseDeficit(
  scores: Partial<Record<WatchabilityDimension, unknown>>,
  rawAverage: number,
): number {
  let deficit = 0;
  for (const [dimension, threshold] of Object.entries(WATCHABILITY_THRESHOLDS) as Array<[WatchabilityDimension, number]>) {
    const score = scores[dimension];
    if (typeof score !== "number" || !Number.isFinite(score)) {
      deficit += threshold;
      continue;
    }
    deficit += Math.max(0, threshold - score);
  }
  deficit += Math.max(0, WATCHABILITY_AVERAGE_THRESHOLD - rawAverage);
  return deficit;
}
