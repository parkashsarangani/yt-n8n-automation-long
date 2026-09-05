export type VisualMode = "stock_video" | "generated_image" | "motion_graphic" | "generated_video";

export interface VisualBeat {
  id: string;
  scene_index: number;
  beat_index: number;
  start_sec: number;
  end_sec: number;
  narration: string;
  context: { previous: string; next: string };
  intent: {
    purpose: string;
    information: string;
    emotion: string;
    importance: number;
  };
  visual_contract: {
    required: string[];
    forbidden: string[];
    required_action: string;
    viewer_takeaway: string;
  };
  routing: { preferred: VisualMode; fallback: VisualMode };
  continuity: { group: string; entities: string[] };
  retention: {
    novelty_required: boolean;
    visual_change_strength: number;
    composition: string;
  };
  asset_brief: {
    query: string;
    generation_prompt: string;
    motion_graphic_brief: string;
  };
  hero_role?: string;
}

export interface VisualBeatPlan {
  beats: VisualBeat[];
}

export interface VisualCapabilities {
  stock_video: boolean;
  generated_image: boolean;
  motion_graphic: boolean;
  generated_video: boolean;
}

export interface CandidateScores {
  semantic_match: number;
  action_match: number;
  visual_interest: number;
  continuity: number;
}

export interface ScoredCandidate<T> {
  value: T;
  scores: CandidateScores;
}

export const VISUAL_ACCEPTANCE = Object.freeze({
  semantic_match: 0.90,
  visual_interest: 0.80,
  action_match: 0.70,
  continuity: 0.70,
});

const ABSTRACT_PURPOSES = new Set([
  "EXPLAIN",
  "MAKE_SCALE_INTUITIVE",
  "SHOW_CAUSE",
  "SHOW_EFFECT",
  "SHOW_PROCESS",
  "CONTRAST",
]);

export function beatDuration(beat: Pick<VisualBeat, "start_sec" | "end_sec">): number {
  return beat.end_sec - beat.start_sec;
}

/**
 * Deterministic safety validation around the agent-authored plan. The worker
 * may reject routing, availability, timing, or repetition; it must not invent
 * a different semantic interpretation of the narration.
 */
export function validateVisualBeatPlan(plan: VisualBeatPlan): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const byScene = new Map<number, VisualBeat[]>();

  for (const beat of plan.beats) {
    if (ids.has(beat.id)) errors.push(`${beat.id}: duplicate beat id`);
    ids.add(beat.id);

    const duration = beatDuration(beat);
    if (!(duration > 0)) errors.push(`${beat.id}: end_sec must be greater than start_sec`);
    if (duration < 1.5 || duration > 8) {
      errors.push(`${beat.id}: duration ${duration.toFixed(2)}s is outside the hard 1.5-8s safety range`);
    }
    if (beat.routing.preferred === beat.routing.fallback) {
      errors.push(`${beat.id}: preferred and fallback visual modes must differ`);
    }
    if (beat.visual_contract.required.length === 0) {
      errors.push(`${beat.id}: visual_contract.required must describe at least one observable requirement`);
    }
    if (!beat.visual_contract.viewer_takeaway.trim()) {
      errors.push(`${beat.id}: viewer_takeaway is empty`);
    }
    const required = new Set(beat.visual_contract.required.map((v) => v.trim().toLowerCase()));
    for (const forbidden of beat.visual_contract.forbidden) {
      if (required.has(forbidden.trim().toLowerCase())) {
        errors.push(`${beat.id}: '${forbidden}' is both required and forbidden`);
      }
    }
    if (beat.routing.preferred === "stock_video" && !beat.asset_brief.query.trim()) {
      errors.push(`${beat.id}: stock_video requires a concrete asset query`);
    }
    if (beat.routing.preferred === "generated_image" && !beat.asset_brief.generation_prompt.trim()) {
      errors.push(`${beat.id}: generated_image requires generation_prompt`);
    }
    if (beat.routing.preferred === "motion_graphic" && !beat.asset_brief.motion_graphic_brief.trim()) {
      errors.push(`${beat.id}: motion_graphic requires motion_graphic_brief`);
    }
    if (ABSTRACT_PURPOSES.has(beat.intent.purpose) && beat.routing.preferred === "stock_video") {
      errors.push(`${beat.id}: abstract explanatory purpose ${beat.intent.purpose} may not prefer generic stock_video`);
    }

    const scene = byScene.get(beat.scene_index) ?? [];
    scene.push(beat);
    byScene.set(beat.scene_index, scene);
  }

  for (const [sceneIndex, sceneBeats] of byScene) {
    const ordered = [...sceneBeats].sort((a, b) => a.beat_index - b.beat_index);
    for (let i = 0; i < ordered.length; i++) {
      const current = ordered[i]!;
      if (current.beat_index !== i) {
        errors.push(`scene ${sceneIndex}: beat_index must be contiguous from 0`);
      }
      if (i === 0 && Math.abs(current.start_sec) > 0.05) {
        errors.push(`scene ${sceneIndex}: first beat must begin at 0s`);
      }
      if (i > 0) {
        const previous = ordered[i - 1]!;
        const delta = current.start_sec - previous.end_sec;
        if (Math.abs(delta) > 0.08) {
          errors.push(`scene ${sceneIndex}: ${previous.id}->${current.id} has ${delta > 0 ? "gap" : "overlap"} ${Math.abs(delta).toFixed(2)}s`);
        }
      }
    }
  }

  return errors;
}

export function modeAvailable(mode: VisualMode, capabilities: VisualCapabilities): boolean {
  return capabilities[mode];
}

/**
 * Select only between agent-declared routes. Unsupported modes fail closed to
 * the declared fallback; workers never substitute an unrelated third mode.
 */
export function selectVisualMode(
  beat: VisualBeat,
  recentModes: VisualMode[],
  capabilities: VisualCapabilities,
): VisualMode | null {
  const preferred = beat.routing.preferred;
  const fallback = beat.routing.fallback;
  const preferredAvailable = modeAvailable(preferred, capabilities);
  const fallbackAvailable = modeAvailable(fallback, capabilities);

  if (!preferredAvailable) return fallbackAvailable ? fallback : null;

  if (beat.retention.novelty_required && fallbackAvailable) {
    const lastThree = recentModes.slice(-3);
    if (lastThree.length === 3 && lastThree.every((mode) => mode === preferred)) {
      return fallback;
    }
  }

  return preferred;
}

export function repeatedVisualPatterns(beats: VisualBeat[]): number {
  let repeated = 0;
  for (let i = 2; i < beats.length; i++) {
    const a = beats[i - 2]!;
    const b = beats[i - 1]!;
    const c = beats[i]!;
    if (
      a.routing.preferred === b.routing.preferred &&
      b.routing.preferred === c.routing.preferred &&
      a.retention.composition === b.retention.composition &&
      b.retention.composition === c.retention.composition
    ) repeated += 1;
  }
  return repeated;
}

export function candidateAccepted(scores: CandidateScores): boolean {
  return (
    scores.semantic_match >= VISUAL_ACCEPTANCE.semantic_match &&
    scores.visual_interest >= VISUAL_ACCEPTANCE.visual_interest &&
    scores.action_match >= VISUAL_ACCEPTANCE.action_match &&
    scores.continuity >= VISUAL_ACCEPTANCE.continuity
  );
}

/**
 * A semantically weak candidate can never win on aesthetics. Sort only the
 * candidates that satisfy every hard floor, then use a relevance-heavy score.
 */
export function chooseVisualCandidate<T>(candidates: ScoredCandidate<T>[]): ScoredCandidate<T> | null {
  const accepted = candidates.filter((candidate) => candidateAccepted(candidate.scores));
  accepted.sort((a, b) => weightedScore(b.scores) - weightedScore(a.scores));
  return accepted[0] ?? null;
}

function weightedScore(scores: CandidateScores): number {
  return (
    scores.semantic_match * 0.45 +
    scores.action_match * 0.20 +
    scores.visual_interest * 0.20 +
    scores.continuity * 0.15
  );
}
