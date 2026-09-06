import type { SemanticScene } from "./semantic-scene.ts";

export type VisualMode = "stock_video" | "generated_image" | "motion_graphic" | "generated_video";

/**
 * What a beat's pixels actually ARE, as opposed to which provider produced
 * them. `motion_graphic` used to mean both "an authored explanatory diagram"
 * and "some abstract shapes we drew because the beat was classified as
 * graphical"; a rendered benchmark showed only the second one ever shipped.
 * Naming the representation separately from the mode is what lets the report,
 * the logs and the QA gate tell those two apart.
 */
export type VisualRepresentation =
  | "stock_video"
  | "generated_image"
  | "generated_video"
  | "semantic_graphic"
  | "kinetic_text";

export interface VisualBeat {
  id: string;
  scene_index: number;
  beat_index: number;
  start_sec: number;
  end_sec: number;
  narration: string;
  context: { previous: string; next: string };
  intent: { purpose: string; information: string; emotion: string; importance: number };
  visual_contract: { required: string[]; forbidden: string[]; required_action: string; viewer_takeaway: string };
  routing: { preferred: VisualMode; fallback: VisualMode; image_style?: "realistic" | "illustration" | "not_applicable" };
  continuity: { group: string; entities: string[] };
  retention: {
    novelty_required: boolean;
    visual_change_strength: number;
    composition: string;
    camera_treatment?: string;
    subject_placement?: string;
    explanatory_pattern?: string;
  };
  asset_brief: {
    query: string;
    query_variants?: string[];
    generation_prompt: string;
    generation_variants?: string[];
    generated_video_prompt?: string;
    motion_graphic_brief: string;
    /**
     * Structured data a deterministic explanatory graphic is drawn from.
     * Optional at the schema level: a beat that omits it (or supplies one that
     * cannot be drawn literally) falls back to kinetic text instead of being
     * rendered as anonymous geometry.
     */
    semantic_scene?: SemanticScene;
  };
  hero_role?: string;
}

export interface VisualBeatPlan { beats: VisualBeat[] }
export interface VisualCapabilities { stock_video: boolean; generated_image: boolean; motion_graphic: boolean; generated_video: boolean }
export interface CandidateScores { semantic_match: number; action_match: number; visual_interest: number; continuity: number }
export interface ScoredCandidate<T> { value: T; scores: CandidateScores }

export interface VisualHistoryEntry {
  mode: VisualMode;
  duration_sec: number;
  composition: string;
  camera_treatment: string;
  subject_placement: string;
  explanatory_pattern: string;
}

export const VISUAL_ACCEPTANCE = Object.freeze({ semantic_match: 0.90, visual_interest: 0.80, action_match: 0.70, continuity: 0.70 });
const ABSTRACT_PURPOSES = new Set(["EXPLAIN","MAKE_SCALE_INTUITIVE","SHOW_CAUSE","SHOW_EFFECT","SHOW_PROCESS","CONTRAST"]);

export function beatDuration(beat: Pick<VisualBeat, "start_sec" | "end_sec">): number { return beat.end_sec - beat.start_sec; }

/**
 * A continuity group + stable entity IDs means the pixels are expected to
 * depict the same recurring thing, not merely the same narrative role. Generic
 * stock cannot carry a reference image into later providers, so it must not be
 * the preferred representation when a continuity-capable authored fallback is
 * already available. This is intentionally narrow: it does NOT broaden stock
 * search for unrelated beats or change the RFC's purpose-based router.
 */
export function hasRecurringNamedEntities(beat: Pick<VisualBeat, "continuity">): boolean {
  return beat.continuity.group.trim().length > 0 && beat.continuity.entities.some((entity) => entity.trim().length > 0);
}

/**
 * Deterministic pre-validation repair for the routing rules the Visual Director
 * gets wrong most often. This never invents content — it only re-points a beat
 * away from a mode the RFC forbids for its purpose, using the modes the agent
 * itself already authored briefs for. Repairs are logged; `validateVisualBeatPlan`
 * remains the hard backstop.
 */
export function repairVisualBeatPlan(plan: VisualBeatPlan): { plan: VisualBeatPlan; repairs: string[] } {
  const repairs: string[] = [];
  const beats = plan.beats.map((beat) => {
    let { preferred, fallback } = beat.routing;

    // Abstract explanation must not ship as generic stock footage.
    if (ABSTRACT_PURPOSES.has(beat.intent.purpose) && preferred === "stock_video") {
      const swapToFallback = fallback !== "stock_video";
      const target: VisualMode = swapToFallback
        ? fallback
        : beat.asset_brief.motion_graphic_brief.trim()
          ? "motion_graphic"
          : "generated_image";
      repairs.push(`${beat.id}: ${beat.intent.purpose} preferred stock_video -> ${target}`);
      if (swapToFallback) fallback = "stock_video";
      preferred = target;
    }

    // A recurring named hero/object should start from a continuity-capable
    // representation. Keep stock available as fallback evidence/B-roll, but do
    // not establish an anonymous stock actor that later generated beats cannot
    // plausibly preserve. This does not apply to anonymous establishing crowds.
    if (hasRecurringNamedEntities(beat) && preferred === "stock_video" && fallback !== "stock_video") {
      repairs.push(`${beat.id}: continuity group ${beat.continuity.group} with recurring entities may not prefer non-referenceable stock_video -> ${fallback}`);
      preferred = fallback;
      fallback = "stock_video";
    }

    // preferred and fallback must differ.
    if (preferred === fallback) {
      const alt: VisualMode = preferred === "motion_graphic" ? "generated_image" : "motion_graphic";
      repairs.push(`${beat.id}: fallback equalled preferred (${preferred}) -> fallback ${alt}`);
      fallback = alt;
    }

    return preferred === beat.routing.preferred && fallback === beat.routing.fallback
      ? beat
      : { ...beat, routing: { ...beat.routing, preferred, fallback } };
  });
  return { plan: { beats }, repairs };
}

export function validateVisualBeatPlan(plan: VisualBeatPlan): string[] {
  const errors: string[] = [], ids = new Set<string>(), byScene = new Map<number, VisualBeat[]>();
  for (const beat of plan.beats) {
    if (ids.has(beat.id)) errors.push(`${beat.id}: duplicate beat id`); ids.add(beat.id);
    // RFC 0010 s4: the Visual Director's start_sec/end_sec are *provisional*
    // reading-speed guesses; alignSceneBeats replaces them with measured
    // ElevenLabs timing. Only end_sec <= start_sec is malformed here.
    if (!(beatDuration(beat) > 0)) errors.push(`${beat.id}: end_sec must be greater than start_sec`);
    if (beat.routing.preferred === beat.routing.fallback) errors.push(`${beat.id}: preferred and fallback visual modes must differ`);
    if (beat.visual_contract.required.length === 0) errors.push(`${beat.id}: visual_contract.required must describe at least one observable requirement`);
    if (!beat.visual_contract.viewer_takeaway.trim()) errors.push(`${beat.id}: viewer_takeaway is empty`);
    const required = new Set(beat.visual_contract.required.map((v) => v.trim().toLowerCase()));
    for (const forbidden of beat.visual_contract.forbidden) if (required.has(forbidden.trim().toLowerCase())) errors.push(`${beat.id}: '${forbidden}' is both required and forbidden`);
    const queries = beat.asset_brief.query_variants ?? (beat.asset_brief.query ? [beat.asset_brief.query] : []);
    if (beat.routing.preferred === "stock_video" && queries.length === 0) errors.push(`${beat.id}: stock_video requires concrete query variants`);
    const imagePrompts = beat.asset_brief.generation_variants ?? (beat.asset_brief.generation_prompt ? [beat.asset_brief.generation_prompt] : []);
    if (beat.routing.preferred === "generated_image" && imagePrompts.length === 0) errors.push(`${beat.id}: generated_image requires generation variants`);
    if (beat.routing.preferred === "generated_video" && !(beat.asset_brief.generated_video_prompt ?? beat.asset_brief.generation_prompt).trim()) errors.push(`${beat.id}: generated_video requires a generated_video_prompt`);
    if (beat.routing.preferred === "motion_graphic" && !beat.asset_brief.motion_graphic_brief.trim()) errors.push(`${beat.id}: motion_graphic requires motion_graphic_brief`);
    if (ABSTRACT_PURPOSES.has(beat.intent.purpose) && beat.routing.preferred === "stock_video") errors.push(`${beat.id}: abstract explanatory purpose ${beat.intent.purpose} may not prefer generic stock_video`);
    const scene = byScene.get(beat.scene_index) ?? []; scene.push(beat); byScene.set(beat.scene_index, scene);
  }
  for (const [sceneIndex, sceneBeats] of byScene) {
    const ordered = [...sceneBeats].sort((a,b) => a.beat_index - b.beat_index);
    for (let i=0;i<ordered.length;i++) {
      const current = ordered[i]!;
      if (current.beat_index !== i) errors.push(`scene ${sceneIndex}: beat_index must be contiguous from 0`);
    }
  }
  return errors;
}

export function modeAvailable(mode: VisualMode, capabilities: VisualCapabilities): boolean { return capabilities[mode]; }

function historyEntries(recent: Array<VisualMode | VisualHistoryEntry>): VisualHistoryEntry[] {
  return recent.map((entry) => typeof entry === "string"
    ? { mode: entry, duration_sec: 5, composition: "unknown", camera_treatment: "unknown", subject_placement: "unknown", explanatory_pattern: "unknown" }
    : entry);
}

/** Last 20-30 seconds, not an arbitrary last-three-shots counter. */
export function rollingVisualHistory(recent: VisualHistoryEntry[], seconds = 25): VisualHistoryEntry[] {
  const out: VisualHistoryEntry[] = []; let total = 0;
  for (let i=recent.length-1;i>=0 && total<seconds;i--) { const entry=recent[i]!; out.unshift(entry); total += Math.max(0, entry.duration_sec); }
  return out;
}

function recentModeFrequency(mode: VisualMode, recent: Array<VisualMode | VisualHistoryEntry>): number {
  const window = rollingVisualHistory(historyEntries(recent), 25);
  if (window.length === 0) return 0;
  return window.filter((entry) => entry.mode === mode).length / window.length;
}

export function noveltyConflict(beat: VisualBeat, mode: VisualMode, recent: Array<VisualMode | VisualHistoryEntry>): boolean {
  if (!beat.retention.novelty_required) return false;
  const window = rollingVisualHistory(historyEntries(recent), 25);
  if (window.length < 2) return false;
  const sameMode = window.filter((e) => e.mode === mode).length / window.length;
  const sameComposition = window.filter((e) => e.composition === beat.retention.composition).length / window.length;
  const camera = beat.retention.camera_treatment ?? "unknown";
  const placement = beat.retention.subject_placement ?? "unknown";
  const pattern = beat.retention.explanatory_pattern ?? "unknown";
  const sameCamera = camera !== "unknown" && window.filter((e) => e.camera_treatment === camera).length / window.length >= 0.60;
  const samePlacement = placement !== "unknown" && window.filter((e) => e.subject_placement === placement).length / window.length >= 0.60;
  const samePattern = pattern !== "unknown" && window.filter((e) => e.explanatory_pattern === pattern).length / window.length >= 0.60;
  return (sameMode >= 0.70 && sameComposition >= 0.50) || sameCamera || samePlacement || samePattern;
}

export function selectVisualMode(beat: VisualBeat, recent: Array<VisualMode | VisualHistoryEntry>, capabilities: VisualCapabilities): VisualMode | null {
  let preferred=beat.routing.preferred, fallback=beat.routing.fallback;

  // Backstop for plans that bypassed repairVisualBeatPlan. Do not establish a
  // stable recurring entity with anonymous stock when the authored fallback can
  // preserve an identity/reference. Stock remains available if the authored
  // continuity-capable mode itself is unavailable.
  if (hasRecurringNamedEntities(beat) && preferred === "stock_video" && fallback !== "stock_video" && modeAvailable(fallback, capabilities)) {
    const priorPreferred = preferred;
    preferred = fallback;
    fallback = priorPreferred;
  }

  const preferredAvailable=modeAvailable(preferred,capabilities), fallbackAvailable=modeAvailable(fallback,capabilities);
  if (!preferredAvailable) return fallbackAvailable ? fallback : null;
  if (noveltyConflict(beat, preferred, recent) && fallbackAvailable) {
    // Visual-grammar repetition can make a preferred mode stale even when that
    // mode is not numerically dominant. Conversely, a genuinely fresh fallback
    // is itself a material novelty break and must not be vetoed merely because
    // the beat carries composition/camera metadata inherited from the preferred
    // treatment. Once the fallback is common, evaluate its grammar normally.
    const fallbackIsFresh = recentModeFrequency(fallback, recent) < 0.50;
    if (fallbackIsFresh || !noveltyConflict(beat, fallback, recent)) return fallback;
  }
  return preferred;
}

export function historyEntryForBeat(beat: VisualBeat, mode: VisualMode, durationSec = beatDuration(beat)): VisualHistoryEntry {
  return { mode, duration_sec: durationSec, composition: beat.retention.composition, camera_treatment: beat.retention.camera_treatment ?? "unknown", subject_placement: beat.retention.subject_placement ?? "unknown", explanatory_pattern: beat.retention.explanatory_pattern ?? "unknown" };
}

export function repeatedVisualPatterns(beats: VisualBeat[]): number {
  let repeated=0;
  for (let i=2;i<beats.length;i++) { const a=beats[i-2]!,b=beats[i-1]!,c=beats[i]!; if (a.routing.preferred===b.routing.preferred&&b.routing.preferred===c.routing.preferred&&a.retention.composition===b.retention.composition&&b.retention.composition===c.retention.composition) repeated++; }
  return repeated;
}
export function candidateAccepted(scores: CandidateScores): boolean { return scores.semantic_match>=VISUAL_ACCEPTANCE.semantic_match&&scores.visual_interest>=VISUAL_ACCEPTANCE.visual_interest&&scores.action_match>=VISUAL_ACCEPTANCE.action_match&&scores.continuity>=VISUAL_ACCEPTANCE.continuity; }
export function weightedVisualScore(scores: CandidateScores): number { return scores.semantic_match*.45+scores.action_match*.20+scores.visual_interest*.20+scores.continuity*.15; }
export function chooseVisualCandidate<T>(candidates: ScoredCandidate<T>[]): ScoredCandidate<T>|null { const accepted=candidates.filter((c)=>candidateAccepted(c.scores)); accepted.sort((a,b)=>weightedVisualScore(b.scores)-weightedVisualScore(a.scores)); return accepted[0]??null; }
