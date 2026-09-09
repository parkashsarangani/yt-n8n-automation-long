/** Shared deterministic quality rules for RFC 0010 visual beats. */

export type VisualMode = "stock_video" | "generated_image" | "motion_graphic" | "generated_video";

export interface RoutingLike { preferred: VisualMode; fallback: VisualMode }
export interface AssetBriefLike {
  query_variants?: string[]; query?: string; generation_prompt?: string; generation_variants?: string[];
  generated_video_prompt?: string; motion_graphic_brief?: string;
  semantic_scene?: { kind?: string; caption?: string; nodes?: Array<{id?: string; label?: string}>; edges?: Array<{from?: string; to?: string}> } | undefined;
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

export const MAX_VISUAL_BEAT_DURATION_SEC = 10;
export const HARD_MAX_VISUAL_BEAT_DURATION_SEC = 14;
export const MAX_CONSECUTIVE_KINETIC_TEXT = 1;
export const MAX_KINETIC_TEXT_RATIO = 0.34;

const EXPLANATORY_PURPOSES = new Set(["EXPLAIN","MAKE_SCALE_INTUITIVE","SHOW_CAUSE","SHOW_EFFECT","SHOW_PROCESS","CONTRAST","REVEAL","PAYOFF"]);
const EXPLANATORY_PATTERNS = new Set(["comparison","timeline","counter","cause_effect","process","reveal"]);
const STRUCTURED_SCENE_KINDS = new Set([
  "scale_comparison","timeline","process","cause_chain","branching","comparison","before_after","relationship_graph","sequence","quantity",
]);
const HERO_ROLES = new Set(["hook","reveal","low-point","low_point","turn","payoff"]);

function purposeOf(beat: QualityBeatLike): string { return typeof beat.intent?.purpose === "string" ? beat.intent.purpose : ""; }
function patternOf(beat: QualityBeatLike): string { return typeof beat.retention?.explanatory_pattern === "string" ? beat.retention.explanatory_pattern : ""; }
function heroRoleOf(beat: QualityBeatLike): string { return typeof beat.hero_role === "string" ? beat.hero_role.trim().toLowerCase() : ""; }
function requiredActionOf(beat: QualityBeatLike): string { return typeof beat.visual_contract?.required_action === "string" ? beat.visual_contract.required_action.trim() : ""; }

export function beatRequiresStructuredVisual(beat: QualityBeatLike): boolean {
  if (EXPLANATORY_PURPOSES.has(purposeOf(beat))) return true;
  if (EXPLANATORY_PATTERNS.has(patternOf(beat))) return true;
  if (HERO_ROLES.has(heroRoleOf(beat)) && heroRoleOf(beat) !== "hook") return true;
  const action = requiredActionOf(beat).toLowerCase();
  return Boolean(action && /(\band another\b|\bwhile\b|\bwhereas\b|\bversus\b|\bvs\.?\b|\bbranch\b|\bcompared\b|\btwo (?:branches|sides|outcomes|paths)|\bcauses?\b|\bleads? to\b)/.test(action));
}

export function hasStructuredSemanticScene(brief: AssetBriefLike | undefined): boolean {
  const kind = brief?.semantic_scene?.kind;
  return typeof kind === "string" && STRUCTURED_SCENE_KINDS.has(kind);
}

function briefPresentForMode(mode: VisualMode, brief: AssetBriefLike | undefined): boolean {
  if (!brief) return false;
  switch (mode) {
    case "motion_graphic": return Boolean(brief.motion_graphic_brief?.trim());
    case "generated_image": return (brief.generation_variants?.length ? brief.generation_variants : (brief.generation_prompt ? [brief.generation_prompt] : [])).some((p) => Boolean(p?.trim().length && p.trim().length >= 10));
    case "stock_video": return (brief.query_variants?.length ? brief.query_variants : (brief.query ? [brief.query] : [])).some((q) => Boolean(q?.trim().length && q.trim().length >= 2));
    case "generated_video": return Boolean((brief.generated_video_prompt ?? brief.generation_prompt ?? "").trim());
  }
}

/** Catch obvious semantic-kind mismatches without pretending to replace the director. */
export function representationContractErrors(beat: QualityBeatLike): string[] {
  const id = typeof beat.id === "string" ? beat.id : "beat";
  const scene = beat.asset_brief?.semantic_scene;
  const kind = typeof scene?.kind === "string" ? scene.kind : "";
  if (!kind || kind === "kinetic_phrase" || kind === "none") return [];
  const action = requiredActionOf(beat).toLowerCase();
  const info = `${action} ${patternOf(beat).toLowerCase()} ${purposeOf(beat).toLowerCase()}`;
  const errors: string[] = [];

  const divergent = /(\bbranch\b|\btwo (?:branches|outcomes|paths)\b|\bone .*\banother\b|\beither\b.*\bor\b|\brepeat(?:ed)? dose\b.*\bmiss(?:ed)? patient\b)/.test(info);
  const comparison = /(\bversus\b|\bvs\.?\b|\bcompared?\b|\bcontrast\b|\bside by side\b)/.test(info);
  const transform = /(\bbefore\b.*\bafter\b|\bfrom\b.*\bto\b|\btransformation\b|\bcorrected\b|\breveal(?:ed)? true\b)/.test(info);
  const causal = /(\bcause\b|\bleads? to\b|\bresults? in\b|\btherefore\b|\bconsequence\b)/.test(info);

  if (divergent && kind !== "branching") errors.push(`${id}: required_action describes divergent outcomes; semantic_scene.kind must be 'branching', not '${kind}'`);
  else if (comparison && !["comparison","scale_comparison","before_after"].includes(kind)) errors.push(`${id}: comparison semantics require comparison/scale_comparison/before_after, not '${kind}'`);
  else if (transform && !["before_after","branching"].includes(kind) && heroRoleOf(beat) === "payoff") errors.push(`${id}: payoff describes a visible state change/reveal; use before_after or branching instead of '${kind}'`);
  else if (causal && kind === "timeline") errors.push(`${id}: causal semantics cannot be represented as chronology-only timeline; use cause_chain or branching`);

  if (kind === "branching") {
    const edges = scene?.edges ?? [];
    const out = new Map<string, number>();
    for (const edge of edges) if (edge?.from) out.set(edge.from, (out.get(edge.from) ?? 0) + 1);
    if (![...out.values()].some((count) => count >= 2)) errors.push(`${id}: branching scene must contain a visible source with two or more outgoing edges`);
  }
  return errors;
}

export function fallbackContractErrors(beat: QualityBeatLike): string[] {
  const errors: string[] = [];
  const id = typeof beat.id === "string" ? beat.id : "beat";
  const routing = beat.routing;
  if (!routing) return [`${id}: routing is missing`];
  if (routing.preferred === routing.fallback) errors.push(`${id}: routing.preferred and routing.fallback are both '${routing.preferred}'; declare a genuine alternate representation`);
  for (const [slot, mode] of [["preferred", routing.preferred], ["fallback", routing.fallback]] as const) {
    if (!briefPresentForMode(mode, beat.asset_brief)) errors.push(`${id}: routing.${slot} is '${mode}' but asset_brief has no usable brief for that mode`);
  }
  if (beatRequiresStructuredVisual(beat)) {
    for (const [slot, mode] of [["preferred", routing.preferred], ["fallback", routing.fallback]] as const) {
      if (mode === "motion_graphic" && !hasStructuredSemanticScene(beat.asset_brief)) {
        errors.push(`${id}: routing.${slot} is 'motion_graphic' for an explanatory/hero beat but semantic_scene is not a structured diagram`);
      }
    }
    const hasConcrete = [routing.preferred, routing.fallback].some((mode) => mode !== "motion_graphic" && briefPresentForMode(mode, beat.asset_brief));
    const hasStructuredMotion = [routing.preferred, routing.fallback].includes("motion_graphic") && hasStructuredSemanticScene(beat.asset_brief);
    if (!hasConcrete && !hasStructuredMotion) errors.push(`${id}: explanatory/hero beat has no concrete or structured-diagram representation`);
  }
  errors.push(...representationContractErrors(beat));
  return errors;
}

export interface PacingSceneInput { scene_index: number; voice_duration_sec: number; aligned_beat_count: number }
export function requiredMinBeats(voiceDurationSec: number): number { return voiceDurationSec > 0 ? Math.max(1, Math.ceil(voiceDurationSec / MAX_VISUAL_BEAT_DURATION_SEC)) : 1; }
export function pacingFailures(scenes: PacingSceneInput[]): string[] {
  const out: string[] = [];
  for (const scene of scenes) {
    const need = requiredMinBeats(scene.voice_duration_sec);
    if (scene.aligned_beat_count < need) out.push(`scene ${scene.scene_index}: ${scene.voice_duration_sec.toFixed(1)}s of narration needs at least ${need} visual beat(s) (<=${MAX_VISUAL_BEAT_DURATION_SEC}s each) but the plan has ${scene.aligned_beat_count}`);
  }
  return out;
}

export interface BeatDurationStats { count: number; min_sec: number; median_sec: number; mean_sec: number; max_sec: number; over_10s: number; over_15s: number }
export function maxConsecutive(flags: boolean[]): number {
  let best = 0, run = 0;
  for (const flag of flags) { run = flag ? run + 1 : 0; if (run > best) best = run; }
  return best;
}
export function beatDurationStats(durations: number[]): BeatDurationStats {
  const d = durations.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!d.length) return { count:0,min_sec:0,median_sec:0,mean_sec:0,max_sec:0,over_10s:0,over_15s:0 };
  const sum = d.reduce((a,b) => a+b, 0), mid = Math.floor(d.length/2);
  const median = d.length % 2 ? d[mid]! : (d[mid-1]! + d[mid]!) / 2;
  const round = (n:number) => Number(n.toFixed(2));
  return { count:d.length,min_sec:round(d[0]!),median_sec:round(median),mean_sec:round(sum/d.length),max_sec:round(d[d.length-1]!),over_10s:d.filter((n)=>n>MAX_VISUAL_BEAT_DURATION_SEC).length,over_15s:d.filter((n)=>n>15).length };
}
