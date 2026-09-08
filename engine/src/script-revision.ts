import type { ArtifactStore } from "./store.ts";
import type { RunLog, RunRecord } from "./runlog.ts";
import {
  watchabilityPolicyForDuration,
  type WatchabilityDimension,
} from "./watchability-policy.ts";

const SUCCESS = new Set(["ok", "cache_hit", "accepted_below_quality_bar"]);

type CriticPayload = {
  verdict?: unknown;
  abandon_recommended?: unknown;
  weakest_dimension?: unknown;
  summary?: unknown;
  scores?: Partial<Record<WatchabilityDimension, unknown>>;
};

export interface ScriptRevisionContextPayload {
  attempt: number;
  mode: "targeted_revision" | "structural_rebuild";
  previous_script: Record<string, unknown>;
  critic: {
    scores: Record<string, unknown>;
    summary: string;
    weakest_dimension: string | null;
    verdict: string | null;
    abandon_recommended: boolean;
  };
  release_failures: string[];
  directives: string[];
}

export interface ScriptRevisionContextBuild {
  payload: ScriptRevisionContextPayload;
  /** Previous script + the critique that evaluated it. */
  parents: string[];
}

function successful(records: RunRecord[], nodeId: string): RunRecord[] {
  return records.filter((r) => r.node_id === nodeId && r.output && SUCCESS.has(r.status));
}

function failuresFor(
  scores: Partial<Record<WatchabilityDimension, unknown>>,
  targetDurationSec?: unknown,
): string[] {
  const policy = watchabilityPolicyForDuration(targetDurationSec);
  const failures: string[] = [];
  const values: number[] = [];
  for (const [dimension, threshold] of Object.entries(policy.thresholds) as Array<[WatchabilityDimension, number]>) {
    const score = scores[dimension];
    if (typeof score !== "number" || !Number.isFinite(score)) {
      failures.push(`${dimension}=missing (requires ${threshold.toFixed(2)})`);
      continue;
    }
    values.push(score);
    if (score < threshold) failures.push(`${dimension}=${score.toFixed(2)} (requires ${threshold.toFixed(2)})`);
  }
  const rawAverage = values.length === Object.keys(policy.thresholds).length
    ? values.reduce((sum, score) => sum + score, 0) / values.length
    : 0;
  if (rawAverage < policy.averageThreshold) {
    failures.push(`average=${rawAverage.toFixed(3)} (requires ${policy.averageThreshold.toFixed(2)})`);
  }
  return failures;
}

const DIMENSION_DIRECTIVES: Partial<Record<WatchabilityDimension, string>> = {
  hook: "Rebuild scene 0 around the sharpest concrete consequence or unanswered question. Remove setup before the conflict is visible.",
  first_30_fidelity: "Repair the opening window so it delivers the package promise and intensifies it at the pace appropriate to this episode's duration; move neutral background context later.",
  package_fidelity: "Remove premise drift. The title/thumbnail click promise must remain the central question and the payoff must answer that exact promise.",
  suspense: "Strengthen proportional causal escalation: make at least one meaningful choice/stake/consequence tighten before the turn; use multiple escalation loops only when the runtime supports them.",
  watchability: "Compress exposition and repetition. Every beat must change the situation, sharpen a question, reveal a consequence, or pay something off; cut neutral connective prose.",
  entertainment: "Add specific observable choices, reversals, surprise or character behavior instead of generic narration. Prefer memorable concrete moments over explanation.",
  payoff: "Make the ending a concrete consequence that resolves or reframes the opening question. Do not substitute a lesson for the promised event-level payoff.",
  youtube_fit: "Simplify the story so a cold viewer can understand the conflict immediately and can describe the memorable turn in one sentence afterward.",
};

export function revisionDirectives(
  scores: Partial<Record<WatchabilityDimension, unknown>>,
  weakestDimension: string | null,
  summary: string,
  mode: ScriptRevisionContextPayload["mode"],
  targetDurationSec?: unknown,
): string[] {
  const policy = watchabilityPolicyForDuration(targetDurationSec);
  const failed = (Object.entries(policy.thresholds) as Array<[WatchabilityDimension, number]>)
    .filter(([dimension, threshold]) => {
      const score = scores[dimension];
      return typeof score !== "number" || !Number.isFinite(score) || score < threshold;
    })
    .map(([dimension]) => dimension);

  const ordered = [...new Set<WatchabilityDimension>([
    ...(weakestDimension && weakestDimension in policy.thresholds ? [weakestDimension as WatchabilityDimension] : []),
    ...failed,
  ])];
  const directives = ordered.flatMap((dimension) => DIMENSION_DIRECTIVES[dimension] ? [DIMENSION_DIRECTIVES[dimension]!] : []);
  if (summary.trim()) directives.unshift(`Directly repair the critic's diagnosed loss point: ${summary.trim().slice(0, 420)}`);
  directives.unshift(
    `Use the ${policy.profile} release profile for target duration ${policy.targetDurationSec ?? "unspecified"}s; ` +
    `active average floor ${policy.averageThreshold.toFixed(2)}.`,
  );
  if (mode === "structural_rebuild") {
    directives.unshift(
      "Do a structural rewrite, not a paraphrase: preserve the selected package, required payoff and valid facts, but replace weak causal beats/opening order where necessary.",
    );
  } else {
    directives.unshift(
      "Revise the prior draft rather than rerolling it: preserve beats that already satisfy the critic and materially change the failed dimensions only.",
    );
  }
  return directives.slice(0, 10);
}

/**
 * Build feedback for an external script regeneration. The first draft returns
 * null: it has no prior critique and therefore keeps the ordinary story/package
 * parentage. Later drafts explicitly depend on the prior script + report.
 */
export async function buildScriptRevisionContext(opts: {
  runId: string;
  nodeId: string | null | undefined;
  runLog: RunLog;
  store: ArtifactStore;
  targetDurationSec?: unknown;
}): Promise<ScriptRevisionContextBuild | null> {
  if (!opts.nodeId) return null;
  const records = (await opts.runLog.all()).filter((r) => r.run_id === opts.runId);
  const scripts = successful(records, opts.nodeId);
  const priorScriptRecord = scripts.at(-1);
  if (!priorScriptRecord?.output) return null;
  const previousScript = await opts.store.get<Record<string, unknown>>(priorScriptRecord.output);
  if (!previousScript || previousScript.schema_id !== "script") return null;

  // Run records are the authoritative per-production provenance when an
  // artifact is content-deduped. Match the critic execution by its ACTUAL
  // inputs rather than trusting the artifact envelope's first-writer parents.
  const reportRecord = [...successful(records, "watchability_report")]
    .reverse()
    .find((record) => record.inputs.includes(previousScript.artifact_id));
  if (!reportRecord?.output) return null;
  const reportArtifact = await opts.store.get(reportRecord.output);
  if (!reportArtifact || reportArtifact.schema_id !== "watchability_report") return null;

  const report = reportArtifact.payload && typeof reportArtifact.payload === "object"
    ? reportArtifact.payload as CriticPayload
    : {};
  const scores = report.scores ?? {};
  const weakest = typeof report.weakest_dimension === "string" ? report.weakest_dimension : null;
  const summary = typeof report.summary === "string" ? report.summary : "";
  const attempt = scripts.length + 1;
  const mode: ScriptRevisionContextPayload["mode"] =
    attempt >= 4 || report.abandon_recommended === true || report.verdict === "abandon"
      ? "structural_rebuild"
      : "targeted_revision";

  return {
    payload: {
      attempt,
      mode,
      previous_script: previousScript.payload as Record<string, unknown>,
      critic: {
        scores: scores as Record<string, unknown>,
        summary,
        weakest_dimension: weakest,
        verdict: typeof report.verdict === "string" ? report.verdict : null,
        abandon_recommended: report.abandon_recommended === true,
      },
      release_failures: failuresFor(scores, opts.targetDurationSec),
      directives: revisionDirectives(scores, weakest, summary, mode, opts.targetDurationSec),
    },
    parents: [previousScript.artifact_id, reportArtifact.artifact_id],
  };
}
