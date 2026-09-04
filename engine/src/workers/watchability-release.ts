/**
 * Watchability release worker (RFC 0008 + RFC 0009).
 *
 * RFC 0009 removes the old "accept after three" escape hatch. A fully
 * unattended growth system must be able to abandon a weak idea instead of
 * spending voice/image/render budget just because several drafts were tried.
 */
import type { WorkerDef, WorkerOutput } from "../runner.ts";

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
type Dimension = keyof typeof WATCHABILITY_THRESHOLDS;
type WatchabilityReport = { verdict?: unknown; abandon_recommended?: unknown; abandon_reason?: unknown; scores?: Partial<Record<Dimension, unknown>> };

/**
 * `average` is intentionally selection-safe, not merely a raw arithmetic mean.
 * The unattended service compares attempted scripts using this value before
 * image generation. A draft that failed ANY release threshold must never rank
 * above a later draft that actually passed just because its other dimensions
 * were unusually high. Rejected drafts are therefore capped immediately below
 * the aggregate release threshold. `rawAverage` preserves the diagnostic mean.
 */
export function assessWatchability(payload: unknown): {
  passed: boolean;
  average: number;
  rawAverage: number;
  failures: string[];
  abandonRecommended: boolean;
  abandonReason: string;
} {
  const report = payload && typeof payload === "object" ? payload as WatchabilityReport : {};
  const scores = report.scores ?? {};
  const failures: string[] = [];
  const values: number[] = [];
  let materiallyWeak = false;
  for (const [dimension, threshold] of Object.entries(WATCHABILITY_THRESHOLDS) as Array<[Dimension, number]>) {
    const score = scores[dimension];
    if (typeof score !== "number" || !Number.isFinite(score)) {
      failures.push(`${dimension}=missing (requires ${threshold.toFixed(2)})`);
      materiallyWeak = true;
      continue;
    }
    values.push(score);
    if (score < threshold) failures.push(`${dimension}=${score.toFixed(2)} (requires ${threshold.toFixed(2)})`);
    if (score < MATERIAL_WEAKNESS_FLOOR) materiallyWeak = true;
  }
  const rawAverage = values.length === Object.keys(WATCHABILITY_THRESHOLDS).length
    ? values.reduce((sum, score) => sum + score, 0) / values.length
    : 0;
  if (rawAverage < WATCHABILITY_AVERAGE_THRESHOLD) {
    failures.push(`average=${rawAverage.toFixed(3)} (requires ${WATCHABILITY_AVERAGE_THRESHOLD.toFixed(2)})`);
  }
  const criticSaysAbandon = report.verdict === "abandon" || report.abandon_recommended === true;
  const structuralWeakness = [scores.package_fidelity, scores.first_30_fidelity, scores.youtube_fit]
    .some((v) => typeof v === "number" && Number.isFinite(v) && v < MATERIAL_WEAKNESS_FLOOR);
  const abandonRecommended = criticSaysAbandon || (materiallyWeak && structuralWeakness);
  const abandonReason = typeof report.abandon_reason === "string" && report.abandon_reason.trim()
    ? report.abandon_reason.trim()
    : abandonRecommended ? "package/first-30/youtube-fit is materially below the viable floor" : "";
  const passed = failures.length === 0 && report.verdict !== "abandon";
  const average = passed
    ? rawAverage
    : Math.min(rawAverage, WATCHABILITY_AVERAGE_THRESHOLD - 0.001);
  return { passed, average, rawAverage, failures, abandonRecommended, abandonReason };
}

export function makeWatchabilityReleaseWorker(): WorkerDef {
  return {
    name: "watchability_release",
    kind: "worker",
    version: "2",
    consumes: [
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "watchability_report", range: "^2", as: "report" },
    ],
    produces: "script",
    produces_version: "1.7.0",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const result = assessWatchability(inputs["report"]?.payload);
      if (!result.passed) {
        const disposition = result.abandonRecommended ? `ABANDON_TOPIC: ${result.abandonReason}` : "REVISE_SCRIPT";
        throw new Error(`watchability release blocked (${disposition}; attempt ${ctx.attemptNumber}): ${result.failures.join("; ")}`);
      }
      return { payload: inputs["script"]!.payload };
    },
  };
}
