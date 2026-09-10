/**
 * Watchability release worker (RFC 0008 + RFC 0009).
 *
 * RFC 0009 removes the old "accept after three" escape hatch. A fully
 * unattended growth system must be able to abandon a weak idea instead of
 * spending voice/image/render budget just because several drafts were tried.
 */
import type { WorkerDef, WorkerOutput } from "../runner.ts";
import {
  MATERIAL_WEAKNESS_FLOOR,
  MAX_ATTEMPTS_BEFORE_ACCEPTING,
  WATCHABILITY_AVERAGE_THRESHOLD,
  WATCHABILITY_THRESHOLDS,
  watchabilityProfile,
  watchabilityReleaseDeficit,
  type WatchabilityDimension,
} from "../watchability-policy.ts";
import {
  PACKAGE_CONTRACT_MARKER,
  validateGrowthPackageSelection,
} from "../growth-package-contract.ts";

export {
  MATERIAL_WEAKNESS_FLOOR,
  MAX_ATTEMPTS_BEFORE_ACCEPTING,
  WATCHABILITY_AVERAGE_THRESHOLD,
  WATCHABILITY_THRESHOLDS,
} from "../watchability-policy.ts";
export { validateGrowthPackageSelection } from "../growth-package-contract.ts";

type Dimension = WatchabilityDimension;
type WatchabilityReport = {
  target_duration_sec?: unknown;
  verdict?: unknown;
  abandon_recommended?: unknown;
  abandon_reason?: unknown;
  scores?: Partial<Record<Dimension, unknown>>;
};
type GrowthPackage = { next_video_bridge?: unknown };
type IntentPayload = { target_duration_sec?: unknown };
type ScriptScene = { scene_index?: unknown; point?: unknown; narration?: unknown; is_outro?: unknown; [key: string]: unknown };
type ScriptPayload = { scenes?: unknown; word_count?: unknown; [key: string]: unknown };

function wordCount(scenes: ScriptScene[]): number {
  return scenes.reduce((total, scene) => {
    const narration = typeof scene.narration === "string" ? scene.narration.trim() : "";
    return total + (narration ? narration.split(/\s+/).length : 0);
  }, 0);
}

function targetDuration(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as IntentPayload).target_duration_sec;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function enforceContinuationBridge(scriptPayload: unknown, packagePayload: unknown): unknown {
  if (!scriptPayload || typeof scriptPayload !== "object") return scriptPayload;
  const bridge = packagePayload && typeof packagePayload === "object" && typeof (packagePayload as GrowthPackage).next_video_bridge === "string"
    ? ((packagePayload as GrowthPackage).next_video_bridge as string).trim()
    : "";
  if (!bridge) return scriptPayload;

  const script = scriptPayload as ScriptPayload;
  if (!Array.isArray(script.scenes)) return scriptPayload;
  const scenes = script.scenes.map((raw) => raw && typeof raw === "object" ? { ...(raw as ScriptScene) } : raw) as ScriptScene[];
  const outroIndexes = scenes.flatMap((scene, index) => scene?.is_outro === true ? [index] : []);
  if (outroIndexes.length > 1) throw new Error("script continuation contract failed: multiple outro scenes");

  if (outroIndexes.length === 1) {
    scenes[outroIndexes[0]!]!.narration = bridge;
  } else {
    const maxIndex = scenes.reduce((max, scene) => typeof scene.scene_index === "number" ? Math.max(max, scene.scene_index) : max, -1);
    scenes.push({ scene_index: maxIndex + 1, point: "session continuation", narration: bridge, is_outro: true });
  }
  return { ...script, scenes, word_count: wordCount(scenes) };
}

/**
 * `average` is the service's best-of-N selection score. Passing drafts retain
 * their real arithmetic mean. Failed drafts stay strictly below the active
 * duration-aware average floor and are ordered by distance from that release
 * surface. New 2.1 reports carry their evaluation duration so callers such as
 * unattended best-of-N do not need to look the intent artifact up again. Old
 * 2.0 reports without that field retain the historical long-form profile.
 */
export function assessWatchability(payload: unknown, targetDurationSec?: number | null): {
  passed: boolean;
  average: number;
  rawAverage: number;
  releaseDeficit: number;
  failures: string[];
  abandonRecommended: boolean;
  abandonReason: string;
  profile: ReturnType<typeof watchabilityProfile>;
} {
  const report = payload && typeof payload === "object" ? payload as WatchabilityReport : {};
  const scores = report.scores ?? {};
  const reportedDuration = typeof report.target_duration_sec === "number" && Number.isFinite(report.target_duration_sec)
    ? report.target_duration_sec
    : null;
  const effectiveDuration = targetDurationSec ?? reportedDuration;
  const profile = watchabilityProfile(effectiveDuration);
  const failures: string[] = [];
  const values: number[] = [];
  let materiallyWeak = false;
  for (const [dimension, threshold] of Object.entries(profile.thresholds) as Array<[Dimension, number]>) {
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
  const rawAverage = values.length === Object.keys(profile.thresholds).length
    ? values.reduce((sum, score) => sum + score, 0) / values.length
    : 0;
  if (rawAverage < profile.averageThreshold) {
    failures.push(`average=${rawAverage.toFixed(3)} (requires ${profile.averageThreshold.toFixed(2)})`);
  }
  const criticSaysAbandon = report.verdict === "abandon" || report.abandon_recommended === true;
  const structuralWeakness = [scores.package_fidelity, scores.first_30_fidelity, scores.youtube_fit]
    .some((v) => typeof v === "number" && Number.isFinite(v) && v < MATERIAL_WEAKNESS_FLOOR);
  const abandonRecommended = criticSaysAbandon || (materiallyWeak && structuralWeakness);
  const abandonReason = typeof report.abandon_reason === "string" && report.abandon_reason.trim()
    ? report.abandon_reason.trim()
    : abandonRecommended ? "package/first-30/youtube-fit is materially below the viable floor" : "";
  const passed = failures.length === 0 && report.verdict !== "abandon";
  const releaseDeficit = watchabilityReleaseDeficit(scores, rawAverage, profile);
  const failedCeiling = profile.averageThreshold - 0.001;
  const average = passed
    ? rawAverage
    : Math.max(0, Math.min(failedCeiling, failedCeiling - releaseDeficit + rawAverage * 0.00001));
  return { passed, average, rawAverage, releaseDeficit, failures, abandonRecommended, abandonReason, profile };
}

export function makeWatchabilityReleaseWorker(): WorkerDef {
  return {
    name: "watchability_release",
    kind: "worker",
    version: "6",
    consumes: [
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "watchability_report", range: "^2", as: "report" },
      { schema_id: "growth_package", range: "^1", as: "package", optional: true },
      { schema_id: "intent", range: "^2", as: "intent", optional: true },
    ],
    produces: "script",
    produces_version: "1.7.0",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const durationSec = targetDuration(inputs["intent"]?.payload);
      const result = assessWatchability(inputs["report"]?.payload, durationSec);
      if (!result.passed) {
        const disposition = result.abandonRecommended ? `ABANDON_TOPIC: ${result.abandonReason}` : "REVISE_SCRIPT";
        throw new Error(
          `watchability release blocked (${disposition}; attempt ${ctx.attemptNumber}; profile ${result.profile.mode}` +
          `${durationSec ? ` ${durationSec}s` : ""}): ${result.failures.join("; ")}`,
        );
      }
      const packageErrors = validateGrowthPackageSelection(inputs["package"]?.payload);
      if (packageErrors.length > 0) {
        throw new Error(`watchability release blocked (${PACKAGE_CONTRACT_MARKER}): ${packageErrors.join("; ")}`);
      }

      // Manual-script mode is a promise to use the operator's exact words.
      // Evaluate the script against the same production watchability/package
      // gates, but never inject/replace an outro behind the operator's back.
      const script = inputs["script"]!;
      const isOperatorAuthored = script.produced_by?.transformation === "human";
      return {
        payload: isOperatorAuthored
          ? script.payload
          : enforceContinuationBridge(script.payload, inputs["package"]?.payload),
      };
    },
  };
}
