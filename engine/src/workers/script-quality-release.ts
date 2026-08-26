import type { WorkerDef, WorkerOutput } from "../runner.ts";
import { assessDialogueEvidence } from "../script-dialogue-evidence.ts";

export const SCRIPT_QUALITY_THRESHOLDS = {
  factual_fidelity: 0.97,
  comprehension: 0.95,
  hook_curiosity: 0.95,
  dialogue_naturalness: 0.93,
  character_chemistry: 0.93,
  escalation: 0.94,
  payoff: 0.95,
  non_template_feel: 0.90,
} as const;

type Dimension = keyof typeof SCRIPT_QUALITY_THRESHOLDS;
type QualityReport = { scores?: Partial<Record<Dimension, unknown>> };

export function assessScriptQuality(payload: unknown): {
  passed: boolean;
  average: number;
  failures: string[];
} {
  const report = payload && typeof payload === "object" ? payload as QualityReport : {};
  const scores = report.scores ?? {};
  const failures: string[] = [];
  const values: number[] = [];

  for (const [dimension, threshold] of Object.entries(SCRIPT_QUALITY_THRESHOLDS) as Array<[Dimension, number]>) {
    const score = scores[dimension];
    if (typeof score !== "number" || !Number.isFinite(score)) {
      failures.push(`${dimension}=missing (requires ${threshold.toFixed(2)})`);
      continue;
    }
    values.push(score);
    if (score < threshold) failures.push(`${dimension}=${score.toFixed(2)} (requires ${threshold.toFixed(2)})`);
  }

  const average = values.length === Object.keys(SCRIPT_QUALITY_THRESHOLDS).length
    ? values.reduce((sum, score) => sum + score, 0) / values.length
    : 0;
  if (average < 0.945) failures.push(`average=${average.toFixed(3)} (requires 0.945)`);
  return { passed: failures.length === 0, average, failures };
}

export function makeScriptQualityReleaseWorker(): WorkerDef {
  return {
    name: "script_quality_release",
    kind: "worker",
    version: "2",
    consumes: [
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "script_quality_report", range: "^1", as: "report" },
    ],
    produces: "script",
    produces_version: "1.4.0",
    async execute(inputs): Promise<WorkerOutput> {
      const result = assessScriptQuality(inputs["report"]?.payload);
      const evidence = assessDialogueEvidence(inputs["script"]?.payload);
      const failures = [
        ...result.failures,
        ...evidence.failures.map((failure) => `evidence ${failure}`),
      ];
      if (failures.length > 0) {
        throw new Error(`script quality release blocked: ${failures.join("; ")}`);
      }
      return { payload: inputs["script"]!.payload };
    },
  };
}
