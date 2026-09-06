import type { VisualMode } from "./visual-routing.ts";

export interface VisualSmokeRenderedBeat {
  id: string;
  qa_available: boolean;
  semantic_match: number;
  action_match: number;
  visual_interest: number;
  continuity: number;
  generic_filler: boolean;
  why_failure: boolean;
  repetitive: boolean;
  continuity_required: boolean;
  reason: string;
}

export interface VisualSmokeResolvedBeat {
  id: string;
  requested_mode?: VisualMode;
  resolved_mode: VisualMode | null;
  status: "resolved" | "fallback" | "unavailable";
  semantic_verified: boolean;
  candidate_count?: number;
  source_provider?: string;
  source_id?: string;
  source_url?: string;
  source_in_sec?: number;
  source_out_sec?: number;
  semantic_match?: number;
  action_match?: number;
  visual_interest?: number;
  continuity?: number;
  generic_filler?: boolean;
  why_failure?: boolean;
  note?: string;
}

export interface VisualSmokeReport {
  pass: boolean;
  technical_failures: string[];
  sourcing_failures: string[];
  efficiency_failures: string[];
  quality_failures: string[];
  coverage_failures: string[];
  warnings: string[];
  summary: {
    beat_count: number;
    qa_unavailable_count: number;
    unresolved_count: number;
    fallback_count: number;
    fallback_ratio: number;
    mean_candidate_count: number;
    operational_budget_failures: number;
    operational_budget_ratio: number;
    min_semantic_match: number;
    min_visual_interest: number;
    why_failures: number;
    repetitive_count: number;
    repetitive_ratio: number;
    continuity_errors: number;
    generic_filler_count: number;
    generic_filler_ratio: number;
    resolved_modes: Record<VisualMode, number>;
  };
  beats: VisualSmokeRenderedBeat[];
  resolved_beats: VisualSmokeResolvedBeat[];
}

const DEFAULT_REQUIRED_MODES: VisualMode[] = ["stock_video", "generated_image", "motion_graphic"];

/**
 * Development-health budgets, not RFC quality floors.
 *
 * Stock candidate_count is the number of real source windows frame-scored by
 * the resolver. One query can inspect at most 5 sources x 5 windows, so 75 is
 * equivalent to allowing roughly three full query strategies before stock
 * should give way to the declared fallback. Other modes map directly to the
 * RFC's bounded 3-5 image / <=3 premium-video candidate pools.
 */
const CANDIDATE_BUDGET: Record<VisualMode, number> = {
  stock_video: 75,
  generated_image: 5,
  motion_graphic: 1,
  generated_video: 3,
};

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function evaluateVisualSmoke(
  rendered: VisualSmokeRenderedBeat[],
  resolved: VisualSmokeResolvedBeat[],
  requiredModes: VisualMode[] = DEFAULT_REQUIRED_MODES,
): VisualSmokeReport {
  const technicalFailures: string[] = [];
  const sourcingFailures: string[] = [];
  const efficiencyFailures: string[] = [];
  const qualityFailures: string[] = [];
  const coverageFailures: string[] = [];
  const warnings: string[] = [];

  const beatCount = rendered.length;
  const qaUnavailableCount = rendered.filter((beat) => !beat.qa_available).length;
  if (qaUnavailableCount > 0) {
    technicalFailures.push(`rendered-frame QA unavailable for ${qaUnavailableCount}/${beatCount} beat(s)`);
  }

  const unresolvedCount = resolved.filter((beat) => beat.status === "unavailable" || !beat.resolved_mode).length;
  if (unresolvedCount > 0) sourcingFailures.push(`${unresolvedCount} beat(s) could not obtain an acceptable live visual candidate`);

  // Stock/generated media are frame-gated before admission. Motion graphics are
  // deterministic instructions and are intentionally verified after rendering,
  // so semantic_verified=false at the asset stage is not a sourcing failure for
  // that mode.
  const unverifiedMedia = resolved.filter((beat) =>
    beat.status !== "unavailable" &&
    beat.resolved_mode !== null &&
    beat.resolved_mode !== "motion_graphic" &&
    !beat.semantic_verified,
  );
  if (unverifiedMedia.length > 0) {
    sourcingFailures.push(`${unverifiedMedia.length} resolved media beat(s) were not semantically verified before admission`);
  }

  const admittedGenericStock = resolved.filter((beat) => beat.resolved_mode === "stock_video" && beat.generic_filler);
  if (admittedGenericStock.length > 0) {
    sourcingFailures.push(`${admittedGenericStock.length} generic stock beat(s) were admitted despite the candidate gate`);
  }

  const fallbackCount = resolved.filter((beat) => beat.status === "fallback").length;
  const fallbackRatio = resolved.length ? fallbackCount / resolved.length : 0;
  // A smoke run that depends on fallback for more than a quarter of beats is
  // operationally unhealthy even when the eventual pixels pass: the Director's
  // primary routing is not reliably sourcing what it asks for.
  if (fallbackRatio > 0.25) {
    efficiencyFailures.push(`fallback ratio ${fallbackRatio.toFixed(3)} > 0.25`);
  }

  const candidateCounts = resolved.map((beat) => beat.candidate_count ?? 0);
  const budgetFailures: string[] = [];
  for (const beat of resolved) {
    if (!beat.resolved_mode || beat.status === "unavailable") continue;
    const count = beat.candidate_count;
    if (count === undefined) {
      budgetFailures.push(`${beat.id} (${beat.resolved_mode}) did not report candidate_count`);
      continue;
    }
    const budget = CANDIDATE_BUDGET[beat.resolved_mode];
    if (count > budget) {
      budgetFailures.push(`${beat.id} ${beat.resolved_mode} evaluated ${count} candidates/windows > budget ${budget}`);
    }
    if (beat.resolved_mode === "generated_image" && count > 3) {
      warnings.push(`${beat.id} generated-image pool used ${count} candidates; 3 is preferred when quality permits`);
    }
  }
  efficiencyFailures.push(...budgetFailures);
  const budgetEligible = resolved.filter((beat) => beat.resolved_mode && beat.status !== "unavailable").length;
  const operationalBudgetRatio = budgetEligible
    ? (budgetEligible - budgetFailures.length) / budgetEligible
    : 0;

  const modeCounts: Record<VisualMode, number> = {
    stock_video: 0,
    generated_image: 0,
    motion_graphic: 0,
    generated_video: 0,
  };
  for (const beat of resolved) if (beat.resolved_mode) modeCounts[beat.resolved_mode] += 1;
  for (const mode of requiredModes) {
    if (modeCounts[mode] === 0) coverageFailures.push(`fixture did not exercise resolved mode ${mode}`);
  }

  const available = rendered.filter((beat) => beat.qa_available);
  const semantics = available.map((beat) => beat.semantic_match);
  const interests = available.map((beat) => beat.visual_interest);
  const minSemantic = semantics.length ? Math.min(...semantics) : 0;
  const minInterest = interests.length ? Math.min(...interests) : 0;
  const whyFailures = available.filter((beat) => beat.why_failure).length;
  const repetitiveCount = available.filter((beat) => beat.repetitive).length;
  const fillerCount = available.filter((beat) => beat.generic_filler).length;
  const continuityErrors = available.filter((beat) => beat.continuity_required && beat.continuity < 0.70).length;
  const repetitiveRatio = available.length ? repetitiveCount / available.length : 0;
  const fillerRatio = available.length ? fillerCount / available.length : 0;

  if (available.length === rendered.length && rendered.length > 0) {
    if (minSemantic < 0.90) qualityFailures.push(`semantic match floor ${minSemantic.toFixed(3)} < 0.90`);
    if (minInterest < 0.80) qualityFailures.push(`visual interest floor ${minInterest.toFixed(3)} < 0.80`);
    if (whyFailures !== 0) qualityFailures.push(`why-am-I-seeing-this failures ${whyFailures} > 0`);
    if (repetitiveRatio > 0.10) qualityFailures.push(`repetitive visual ratio ${repetitiveRatio.toFixed(3)} > 0.10`);
    if (continuityErrors !== 0) qualityFailures.push(`continuity errors ${continuityErrors} > 0`);
    if (fillerRatio > 0.05) qualityFailures.push(`generic filler ratio ${fillerRatio.toFixed(3)} > 0.05`);
  }

  return {
    pass:
      technicalFailures.length === 0 &&
      sourcingFailures.length === 0 &&
      efficiencyFailures.length === 0 &&
      qualityFailures.length === 0 &&
      coverageFailures.length === 0,
    technical_failures: technicalFailures,
    sourcing_failures: sourcingFailures,
    efficiency_failures: efficiencyFailures,
    quality_failures: qualityFailures,
    coverage_failures: coverageFailures,
    warnings,
    summary: {
      beat_count: beatCount,
      qa_unavailable_count: qaUnavailableCount,
      unresolved_count: unresolvedCount,
      fallback_count: fallbackCount,
      fallback_ratio: fallbackRatio,
      mean_candidate_count: mean(candidateCounts),
      operational_budget_failures: budgetFailures.length,
      operational_budget_ratio: operationalBudgetRatio,
      min_semantic_match: minSemantic,
      min_visual_interest: minInterest,
      why_failures: whyFailures,
      repetitive_count: repetitiveCount,
      repetitive_ratio: repetitiveRatio,
      continuity_errors: continuityErrors,
      generic_filler_count: fillerCount,
      generic_filler_ratio: fillerRatio,
      resolved_modes: modeCounts,
    },
    beats: rendered,
    resolved_beats: resolved,
  };
}
