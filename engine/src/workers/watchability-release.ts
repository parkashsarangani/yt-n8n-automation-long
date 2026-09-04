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
/**
 * Compatibility bound consumed by the inherited pre-image best-of-N service
 * sequencing from main. Despite the historical constant name, RFC 0009 NEVER
 * accepts a below-bar script unconditionally. Setting this one beyond the
 * service's five automatic retry rounds lets it draft serious alternatives
 * before terminating/advancing the topic, while preserving main's rule that
 * script selection finishes before image generation can start.
 */
export const MAX_ATTEMPTS_BEFORE_ACCEPTING = 6;
type Dimension = keyof typeof WATCHABILITY_THRESHOLDS;
type PackageFamily = "curiosity" | "conflict" | "reversal";
type WatchabilityReport = { verdict?: unknown; abandon_recommended?: unknown; abandon_reason?: unknown; scores?: Partial<Record<Dimension, unknown>> };
type GrowthVariant = { family?: unknown; title?: unknown; thumbnail_concept?: unknown };
type GrowthPackage = {
  selected_title?: unknown;
  selected_title_family?: unknown;
  selected_thumbnail_concept?: unknown;
  selected_thumbnail_family?: unknown;
  next_video_bridge?: unknown;
  variants?: unknown;
};
type ScriptScene = { scene_index?: unknown; point?: unknown; narration?: unknown; is_outro?: unknown; [key: string]: unknown };
type ScriptPayload = { scenes?: unknown; word_count?: unknown; [key: string]: unknown };

function isFamily(value: unknown): value is PackageFamily {
  return value === "curiosity" || value === "conflict" || value === "reversal";
}

export function validateGrowthPackageSelection(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as GrowthPackage;
  const variants = Array.isArray(p.variants) ? p.variants.filter((v): v is GrowthVariant => Boolean(v) && typeof v === "object") : [];
  const errors: string[] = [];
  const families = variants.map((v) => v.family).filter(isFamily);
  for (const family of ["curiosity", "conflict", "reversal"] as const) {
    if (families.filter((v) => v === family).length !== 1) errors.push(`expected exactly one ${family} variant`);
  }

  const titleFamily = isFamily(p.selected_title_family)
    ? p.selected_title_family
    : variants.find((v) => v.title === p.selected_title)?.family;
  const thumbnailFamily = isFamily(p.selected_thumbnail_family)
    ? p.selected_thumbnail_family
    : variants.find((v) => v.thumbnail_concept === p.selected_thumbnail_concept)?.family;

  if (!isFamily(titleFamily)) errors.push("selected title has no resolvable package family");
  else {
    const variant = variants.find((v) => v.family === titleFamily);
    if (!variant || variant.title !== p.selected_title) errors.push(`selected title does not exactly match the ${titleFamily} variant`);
  }
  if (!isFamily(thumbnailFamily)) errors.push("selected thumbnail has no resolvable package family");
  else {
    const variant = variants.find((v) => v.family === thumbnailFamily);
    if (!variant || variant.thumbnail_concept !== p.selected_thumbnail_concept) errors.push(`selected thumbnail does not exactly match the ${thumbnailFamily} variant`);
  }
  return errors;
}

function wordCount(scenes: ScriptScene[]): number {
  return scenes.reduce((total, scene) => {
    const narration = typeof scene.narration === "string" ? scene.narration.trim() : "";
    return total + (narration ? narration.split(/\s+/).length : 0);
  }, 0);
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
    version: "3",
    consumes: [
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "watchability_report", range: "^2", as: "report" },
      { schema_id: "growth_package", range: "^1", as: "package", optional: true },
    ],
    produces: "script",
    produces_version: "1.7.0",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const result = assessWatchability(inputs["report"]?.payload);
      if (!result.passed) {
        const disposition = result.abandonRecommended ? `ABANDON_TOPIC: ${result.abandonReason}` : "REVISE_SCRIPT";
        throw new Error(`watchability release blocked (${disposition}; attempt ${ctx.attemptNumber}): ${result.failures.join("; ")}`);
      }
      const packageErrors = validateGrowthPackageSelection(inputs["package"]?.payload);
      if (packageErrors.length > 0) {
        throw new Error(`watchability release blocked (PACKAGE_CONTRACT): ${packageErrors.join("; ")}`);
      }
      return { payload: enforceContinuationBridge(inputs["script"]!.payload, inputs["package"]?.payload) };
    },
  };
}
