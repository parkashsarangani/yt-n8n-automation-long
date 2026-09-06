export type VisualMode = "stock_video" | "generated_image" | "motion_graphic" | "generated_video";

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

export function validateVisualBeatPlan(plan: VisualBeatPlan): string[] {
  const errors: string[] = [], ids = new Set<string>(), byScene = new Map<number, VisualBeat[]>();
  for (const beat of plan.beats) {
    if (ids.has(beat.id)) errors.push(`${beat.id}: duplicate beat id`); ids.add(beat.id);
    const duration = beatDuration(beat);
    if (!(duration > 0)) errors.push(`${beat.id}: end_sec must be greater than start_sec`);
    if (duration < 1.5 || duration > 8) errors.push(`${beat.id}: duration ${duration.toFixed(2)}s is outside the hard 1.5-8s safety range`);
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
      if (i===0 && Math.abs(current.start_sec)>0.05) errors.push(`scene ${sceneIndex}: first beat must begin at 0s`);
      if (i>0) { const previous=ordered[i-1]!; const delta=current.start_sec-previous.end_sec; if (Math.abs(delta)>0.08) errors.push(`scene ${sceneIndex}: ${previous.id}->${current.id} has ${delta>0?"gap":"overlap"} ${Math.abs(delta).toFixed(2)}s`); }
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

export function noveltyConflict(beat: VisualBeat, mode: VisualMode, recent: Array<VisualMode | VisualHistoryEntry>): boolean {
  if (!beat.retention.novelty_required) return false;
  const window = rollingVisualHistory(historyEntries(recent), 25);
  if (window.length < 2) return false;
  const sameMode = window.filter((e) => e.mode === mode).length / window.length;
  // A genuinely different representation is itself a material novelty break.
  // Do not reject an agent-declared fallback merely because the beat carries
  // composition/camera metadata resembling the preceding mode. Grammar-level
  // repetition matters only once the proposed mode is already common enough
  // in the rolling window to be part of the pattern we are trying to break.
  if (sameMode < 0.50) return false;
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
  const preferred=beat.routing.preferred, fallback=beat.routing.fallback;
  const preferredAvailable=modeAvailable(preferred,capabilities), fallbackAvailable=modeAvailable(fallback,capabilities);
  if (!preferredAvailable) return fallbackAvailable ? fallback : null;
  if (noveltyConflict(beat, preferred, recent) && fallbackAvailable && !noveltyConflict(beat, fallback, recent)) return fallback;
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
