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
  resolved_mode: VisualMode | null;
  status: "resolved" | "fallback" | "unavailable";
  semantic_verified: boolean;
  candidate_count?: number;
}

export interface VisualSmokeReport {
  pass: boolean;
  technical_failures: string[];
  sourcing_failures: string[];
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
}

const DEFAULT_REQUIRED_MODES: VisualMode[] = ["stock_video", "generated_image", "motion_graphic"];

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
  const unverifiedCount = resolved.filter((beat) => beat.status !== "unavailable" && !beat.semantic_verified).length;
  if (unverifiedCount > 0) sourcingFailures.push(`${unverifiedCount} resolved beat(s) were not semantically verified`);

  const fallbackCount = resolved.filter((beat) => beat.status === "fallback").length;
  const fallbackRatio = resolved.length ? fallbackCount / resolved.length : 0;
  if (fallbackRatio > 0.25) warnings.push(`fallback ratio ${fallbackRatio.toFixed(3)} > 0.25`);

  const candidateCounts = resolved.map((beat) => beat.candidate_count ?? 0);
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
    pass: technicalFailures.length === 0 && sourcingFailures.length === 0 && qualityFailures.length === 0 && coverageFailures.length === 0,
    technical_failures: technicalFailures,
    sourcing_failures: sourcingFailures,
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
  };
}
