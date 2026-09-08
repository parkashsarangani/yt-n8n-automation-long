/**
 * Shared deterministic quality rules for the RFC 0010 production visual stack.
 *
 * The first full end-to-end run (`run_112aa43f`) exposed a degradation path:
 * the Visual Director declared `preferred == fallback == generated_image` with
 * an empty `motion_graphic_brief` on every beat, the resolver "repaired" that
 * by inventing a `motion_graphic` fallback, free image quota was exhausted
 * after three beats, and the remaining eleven silently became generic kinetic
 * text cards — the exact meaningless-card failure RFC 0010 was meant to end.
 *
 * These predicates are the deterministic backstop shared by the director
 * validator, the beat resolver and the release gate so that:
 *  - a beat that must *explain* something (a cause, an effect, a process, a
 *    reveal, a payoff, a comparison) can never be satisfied by a headline
 *    restating the narration;
 *  - a declared alternate is a genuine, brief-backed alternate representation,
 *    never a duplicate of the preferred mode;
 *  - visual beats stay dense enough for the measured narration.
 */

export type VisualMode = "stock_video" | "generated_image" | "motion_graphic" | "generated_video";

export interface RoutingLike {
  preferred: VisualMode;
  fallback: VisualMode;
}

export interface AssetBriefLike {
  query_variants?: string[];
  query?: string;
  generation_prompt?: string;
  generation_variants?: string[];
  generated_video_prompt?: string;
  motion_graphic_brief?: string;
  semantic_scene?: { kind?: string; caption?: string } | undefined;
}

export interface QualityBeatLike {
  id?: unknown;
  intent?: { purpose?: unknown; importance?: unknown } | undefined;
  visual_contract?: { required_action?: unknown; required?: unknown } | undefined;
  retention?: { explanatory_pattern?: unknown } | undefined;
  routing?: RoutingLike | undefined;
  asset_brief?: AssetBriefLike | undefined;
  hero_role?: unknown;
}

/** After voice alignment a single ordinary visual beat may not exceed this. */
export const MAX_VISUAL_BEAT_DURATION_SEC = 10;
/** A beat this long is a hard release failure even if it is a held hero shot. */
export const HARD_MAX_VISUAL_BEAT_DURATION_SEC = 14;
/** No more than this many kinetic-text beats in a row. */
export const MAX_CONSECUTIVE_KINETIC_TEXT = 1;
/** Kinetic-text-only beats may not exceed this fraction of the episode's beats. */
export const MAX_KINETIC_TEXT_RATIO = 0.34;

/**
 * Intents whose whole job is to make an abstract relationship legible. A still
 * photo can accompany these, but a title card cannot *be* the explanation.
 */
const EXPLANATORY_PURPOSES = new Set([
  "EXPLAIN",
  "MAKE_SCALE_INTUITIVE",
  "SHOW_CAUSE",
  "SHOW_EFFECT",
  "SHOW_PROCESS",
  "CONTRAST",
  "REVEAL",
  "PAYOFF",
]);

const EXPLANATORY_PATTERNS = new Set([
  "comparison",
  "timeline",
  "counter",
  "cause_effect",
  "process",
  "reveal",
]);

/** semantic_scene kinds that actually draw a structured diagram. */
const STRUCTURED_SCENE_KINDS = new Set([
  "scale_comparison",
  "timeline",
  "process",
  "before_after",
  "quantity",
]);

const HERO_ROLES = new Set(["hook", "reveal", "low-point", "low_point", "turn", "payoff"]);

function purposeOf(beat: QualityBeatLike): string {
  return typeof beat.intent?.purpose === "string" ? beat.intent.purpose : "";
}
function patternOf(beat: QualityBeatLike): string {
  return typeof beat.retention?.explanatory_pattern === "string" ? beat.retention.explanatory_pattern : "";
}
function heroRoleOf(beat: QualityBeatLike): string {
  return typeof beat.hero_role === "string" ? beat.hero_role.trim().toLowerCase() : "";
}
function requiredActionOf(beat: QualityBeatLike): string {
  return typeof beat.visual_contract?.required_action === "string" ? beat.visual_contract.required_action.trim() : "";
}

/**
 * True when a headline restating the narration cannot satisfy this beat: it
 * either has an explanatory intent/pattern, is a hero/payoff/low-point beat,
 * or its required_action names multiple entities/states that must be shown in
 * relation to each other.
 */
export function beatRequiresStructuredVisual(beat: QualityBeatLike): boolean {
  if (EXPLANATORY_PURPOSES.has(purposeOf(beat))) return true;
  if (EXPLANATORY_PATTERNS.has(patternOf(beat))) return true;
  if (HERO_ROLES.has(heroRoleOf(beat)) && heroRoleOf(beat) !== "hook") return true;
  // A required_action that describes more than one moving part ("one branch...
  // and another...", "X while Y", "A then B") is a relationship, not a caption.
  const action = requiredActionOf(beat).toLowerCase();
  if (action && /(\band another\b|\bwhile\b|\bwhereas\b|\bversus\b|\bvs\.?\b|\bbranch\b|\bcompared\b|\bthen\b.*\bthen\b|\btwo (?:branches|sides|outcomes|paths))/.test(action)) {
    return true;
  }
  return false;
}

/** A structured, drawable semantic scene (not kinetic phrase / none / absent). */
export function hasStructuredSemanticScene(brief: AssetBriefLike | undefined): boolean {
  const kind = brief?.semantic_scene?.kind;
  return typeof kind === "string" && STRUCTURED_SCENE_KINDS.has(kind);
}

function briefPresentForMode(mode: VisualMode, brief: AssetBriefLike | undefined): boolean {
  if (!brief) return false;
  switch (mode) {
    case "motion_graphic":
      return Boolean(brief.motion_graphic_brief && brief.motion_graphic_brief.trim());
    case "generated_image": {
      const prompts = brief.generation_variants?.length ? brief.generation_variants : (brief.generation_prompt ? [brief.generation_prompt] : []);
      return prompts.some((p) => p && p.trim().length >= 10);
    }
    case "stock_video": {
      const q = brief.query_variants?.length ? brief.query_variants : (brief.query ? [brief.query] : []);
      return q.some((v) => v && v.trim().length >= 2);
    }
    case "generated_video":
      return Boolean((brief.generated_video_prompt ?? brief.generation_prompt ?? "").trim());
  }
}

/**
 * Deterministic fallback-contract validation for a single director beat.
 * Returns human-readable errors; the director validator marks them HARD so a
 * bad routing contract costs a retry instead of shipping.
 */
export function fallbackContractErrors(beat: QualityBeatLike): string[] {
  const errors: string[] = [];
  const id = typeof beat.id === "string" ? beat.id : "beat";
  const routing = beat.routing;
  if (!routing) return [`${id}: routing is missing`];

  if (routing.preferred === routing.fallback) {
    errors.push(`${id}: routing.preferred and routing.fallback are both '${routing.preferred}'; declare a genuine alternate representation`);
  }

  for (const [slot, mode] of [["preferred", routing.preferred], ["fallback", routing.fallback]] as const) {
    if (!briefPresentForMode(mode, beat.asset_brief)) {
      errors.push(`${id}: routing.${slot} is '${mode}' but asset_brief has no usable brief for that mode`);
    }
  }

  const needsStructured = beatRequiresStructuredVisual(beat);
  if (needsStructured) {
    // motion_graphic on an explanatory/hero beat must carry a structured scene,
    // never a bare kinetic phrase — kinetic text is not an explanation.
    for (const [slot, mode] of [["preferred", routing.preferred], ["fallback", routing.fallback]] as const) {
      if (mode === "motion_graphic" && !hasStructuredSemanticScene(beat.asset_brief)) {
        errors.push(
          `${id}: routing.${slot} is 'motion_graphic' for an explanatory/hero beat but asset_brief.semantic_scene is not a structured diagram ` +
          `(need one of scale_comparison|timeline|process|before_after|quantity) — a headline restating the narration is not acceptable here`,
        );
      }
    }
    // The beat must have at least one non-degenerate representation available:
    // a real generated_image / stock_video / generated_video, or a structured
    // motion_graphic. It may not be motion_graphic⇄motion_graphic-ish where the
    // only real content is a phrase.
    const hasConcrete = [routing.preferred, routing.fallback].some(
      (m) => m !== "motion_graphic" && briefPresentForMode(m, beat.asset_brief),
    );
    const hasStructuredMotion = [routing.preferred, routing.fallback].includes("motion_graphic") && hasStructuredSemanticScene(beat.asset_brief);
    if (!hasConcrete && !hasStructuredMotion) {
      errors.push(`${id}: an explanatory/hero beat has no concrete or structured-diagram representation to render`);
    }
  }
  return errors;
}

export interface PacingSceneInput {
  scene_index: number;
  voice_duration_sec: number;
  aligned_beat_count: number;
}

export function requiredMinBeats(voiceDurationSec: number): number {
  if (!(voiceDurationSec > 0)) return 1;
  return Math.max(1, Math.ceil(voiceDurationSec / MAX_VISUAL_BEAT_DURATION_SEC));
}

export function pacingFailures(scenes: PacingSceneInput[]): string[] {
  const out: string[] = [];
  for (const scene of scenes) {
    const need = requiredMinBeats(scene.voice_duration_sec);
    if (scene.aligned_beat_count < need) {
      out.push(
        `scene ${scene.scene_index}: ${scene.voice_duration_sec.toFixed(1)}s of narration needs at least ${need} visual beat(s) ` +
        `(<=${MAX_VISUAL_BEAT_DURATION_SEC}s each) but the plan has ${scene.aligned_beat_count}`,
      );
    }
  }
  return out;
}

export interface BeatDurationStats {
  count: number;
  min_sec: number;
  median_sec: number;
  mean_sec: number;
  max_sec: number;
  over_10s: number;
  over_15s: number;
}

/** Longest run of `true` in a boolean sequence. */
export function maxConsecutive(flags: boolean[]): number {
  let best = 0;
  let run = 0;
  for (const flag of flags) {
    run = flag ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

export function beatDurationStats(durations: number[]): BeatDurationStats {
  const d = durations.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!d.length) return { count: 0, min_sec: 0, median_sec: 0, mean_sec: 0, max_sec: 0, over_10s: 0, over_15s: 0 };
  const sum = d.reduce((a, b) => a + b, 0);
  const mid = Math.floor(d.length / 2);
  const median = d.length % 2 ? d[mid]! : (d[mid - 1]! + d[mid]!) / 2;
  const round = (n: number) => Number(n.toFixed(2));
  return {
    count: d.length,
    min_sec: round(d[0]!),
    median_sec: round(median),
    mean_sec: round(sum / d.length),
    max_sec: round(d[d.length - 1]!),
    over_10s: d.filter((n) => n > MAX_VISUAL_BEAT_DURATION_SEC).length,
    over_15s: d.filter((n) => n > 15).length,
  };
}
