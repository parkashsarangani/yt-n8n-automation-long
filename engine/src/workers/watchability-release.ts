/**
 * Watchability release worker (RFC 0008): the single script-level gate for
 * the illustrated-story pipeline. Replaces the six-node comprehension /
 * entertainment / factual-fidelity chain script-quality-release.ts gates for
 * the two-host dialogue format -- this format has no dialogue, no cast, and
 * "fuck technical correctness, I want YT-fit watchable results" (operator
 * decision) means factual_fidelity/comprehension have no place here at all.
 */

import type { WorkerDef, WorkerOutput } from "../runner.ts";

export const WATCHABILITY_THRESHOLDS = {
  hook: 0.80,
  suspense: 0.75,
  watchability: 0.78,
  entertainment: 0.72,
  payoff: 0.75,
  youtube_fit: 0.75,
} as const;

// Same escape hatch as script_quality_release, and the same reasoning:
// a deterministic gate with no retry loop of its own must not be able to
// block a run forever when the writer agent's own retries (see runner.ts)
// are already exhausted on the semantic side.
const MAX_ATTEMPTS_BEFORE_ACCEPTING = 3;

type Dimension = keyof typeof WATCHABILITY_THRESHOLDS;
type WatchabilityReport = { scores?: Partial<Record<Dimension, unknown>> };

export function assessWatchability(payload: unknown): {
  passed: boolean;
  average: number;
  failures: string[];
} {
  const report = payload && typeof payload === "object" ? payload as WatchabilityReport : {};
  const scores = report.scores ?? {};
  const failures: string[] = [];
  const values: number[] = [];

  for (const [dimension, threshold] of Object.entries(WATCHABILITY_THRESHOLDS) as Array<[Dimension, number]>) {
    const score = scores[dimension];
    if (typeof score !== "number" || !Number.isFinite(score)) {
      failures.push(`${dimension}=missing (requires ${threshold.toFixed(2)})`);
      continue;
    }
    values.push(score);
    if (score < threshold) failures.push(`${dimension}=${score.toFixed(2)} (requires ${threshold.toFixed(2)})`);
  }

  const average = values.length === Object.keys(WATCHABILITY_THRESHOLDS).length
    ? values.reduce((sum, score) => sum + score, 0) / values.length
    : 0;
  if (average < 0.78) failures.push(`average=${average.toFixed(3)} (requires 0.78)`);
  return { passed: failures.length === 0, average, failures };
}

export function makeWatchabilityReleaseWorker(): WorkerDef {
  return {
    name: "watchability_release",
    kind: "worker",
    version: "1",
    consumes: [
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "watchability_report", range: "^1", as: "report" },
    ],
    produces: "script",
    produces_version: "1.7.0",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const result = assessWatchability(inputs["report"]?.payload);
      if (!result.passed) {
        if (ctx.attemptNumber >= MAX_ATTEMPTS_BEFORE_ACCEPTING) {
          ctx.logger.warn(
            `[watchability_release] attempt ${ctx.attemptNumber}: accepting below the watchability bar rather than ` +
              `blocking indefinitely -- ${result.failures.join("; ")}`,
          );
        } else {
          throw new Error(
            `watchability release blocked (attempt ${ctx.attemptNumber}/${MAX_ATTEMPTS_BEFORE_ACCEPTING}): ` +
              result.failures.join("; "),
          );
        }
      }
      return { payload: inputs["script"]!.payload };
    },
  };
}
