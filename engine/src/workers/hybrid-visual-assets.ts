import type { Artifact, BlobRef } from "../artifact.ts";
import {
  MOTION_BG,
  MOTION_PALETTE_ID,
  MOTION_PAPER,
  MOTION_STYLE_ID,
  motionEntityVisualTokens,
  type MotionEntityVisualToken,
} from "../motion-visual-identity.ts";
import type { Aspect, ImageProvider } from "../provider.ts";
import type { WorkerContext, WorkerDef, WorkerOutput } from "../runner.ts";

export type HybridVisualMode = "motion_graphic" | "ai_broll";
export type HybridShotType = "establishing" | "wide" | "medium" | "close-up" | "detail" | "reaction" | "symbolic" | "overhead";

interface PlanScene {
  scene_index: number;
  scene_role?: string;
  visual_operation?: string;
  visual_primitive?: string;
  visual_state?: string;
  composition_mode?: string;
  explanation_title?: string;
  model_elements?: string[];
  state_before?: string;
  state_after?: string;
  key_text?: string;
  character_cut_in?: string;
}
interface ScriptScene { scene_index: number; narration?: string; speaker?: string; emotion?: string; point?: string; is_outro?: boolean }
interface VoiceClip { scene_index: number; alignment_uri?: string; duration_sec?: number }
interface AlignmentData { characters?: string[]; character_start_times_seconds?: number[]; character_end_times_seconds?: number[] }
interface CastCharacter { character_id: string; name?: string; visual_description?: string; color_palette?: string[] }
interface BaseAssetScene {
  scene_index: number;
  source: "primary" | "fallback" | "placeholder" | "template";
  image_uri?: string;
  video_uri?: string;
  prompt?: string;
  template_category?: string;
  template_data?: string;
}
interface ShotSegment { shot_type: HybridShotType; start_sec: number; end_sec: number; semantic_text: string }
interface HybridAssetScene extends BaseAssetScene {
  image_uris?: string[];
  visual_mode?: HybridVisualMode;
  continuity_group?: string;
  style_id?: string;
  palette_id?: string;
  entity_ids?: string[];
  entity_visual_tokens?: MotionEntityVisualToken[];
  visible_character_ids?: string[];
  duration_sec?: number;
  shot_types?: HybridShotType[];
  shot_segments?: ShotSegment[];
  hook_strength?: number;
  hook_strategy?: "ai_question" | "motion_transformation" | "fallback";
}
interface GeneratedImage { bytes: Uint8Array; media_type: string }
interface ConsistentPackProvider extends ImageProvider {
  generatePack?: (req: { prompts: string[]; aspect: Aspect; seed: number; reference?: GeneratedImage }) => Promise<{ images: GeneratedImage[] }>;
}

export const TEMPLATE_DATA_MAX_LENGTH = 8000;

const STATE_ACCENT: Record<string, string> = {
  hypothesis: "#E8B96A",
  contradiction: "#FF7D7D",
  mechanism: "#65C7F7",
  qualification: "#B794F4",
  payoff: "#7DE2A8",
};

const HOUSE_STYLE = [
  "same visual world as a premium motion-editorial explainer",
  `deep navy field ${MOTION_BG}, warm paper highlights ${MOTION_PAPER}`,
  "clean 2D editorial illustration, thick confident outlines, simple readable silhouettes",
  "flat semantic accent colors with restrained cinematic lighting, never glossy 3D and never photorealistic",
  "full-bleed 16:9 composition with one dominant focal event occupying roughly 65 to 80 percent of the useful frame",
  "depth from foreground, midground and background staging while retaining the motion-graphic palette and line language",
  "no centered infographic card, no decorative UI frame, no large empty border",
  "no words, no letters, no captions, no logos, no watermark",
].join(", ");

const MOTION_FIRST_PRIMITIVES = new Set([
  "network", "hierarchy", "one-to-many", "many-to-one", "facets-around-center", "overlapping-sets", "nested-context",
  "cycle", "cause-chain", "timeline", "quantity", "spectrum", "map", "rays", "wave", "horizon", "shells",
]);
const AI_FRIENDLY_PRIMITIVES = new Set(["objects", "physical-transformation", "before-after", "particles", "path"]);

function stableHash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function clean(value: unknown, max = 300): string { return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : ""; }
function words(text: string): string[] { return clean(text, 4000).split(/\s+/).filter(Boolean); }
function estimatedDuration(scene: ScriptScene): number { return Math.max(1.8, words(scene.narration ?? "").length / 2.55 + 0.18); }
function entityId(label: string): string {
  const normalized = clean(label, 80).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "entity";
  return `entity-${normalized.slice(0, 42)}-${stableHash(normalized).toString(36).slice(0, 6)}`;
}
function entityIdsFor(plan: PlanScene): string[] {
  return [...new Set((plan.model_elements ?? []).map((value) => clean(value, 80)).filter(Boolean).map(entityId))].slice(0, 4);
}
function parseTemplateData(scene: BaseAssetScene): Record<string, unknown> | null {
  if (!scene.template_data) return null;
  try {
    const value = JSON.parse(scene.template_data) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/**
 * Never let watchability metadata invalidate an otherwise renderable scene.
 * The compiler-produced template_data is already schema-validated; if adding
 * downstream identity/composition metadata would exceed the manifest's 8k
 * limit, retain that validated payload rather than emitting an invalid artifact.
 */
export function templateDataWithinLimit(original: string | undefined, normalized: Record<string, unknown>): string | undefined {
  const encoded = JSON.stringify(normalized);
  if (encoded.length <= TEMPLATE_DATA_MAX_LENGTH) return encoded;
  if (original && original.length <= TEMPLATE_DATA_MAX_LENGTH) return original;
  return undefined;
}

function shouldPromoteToFullCanvas(plan: PlanScene | undefined, isOpening: boolean, isClosing: boolean): boolean {
  if (isOpening || isClosing) return true;
  // Interior bookends were another source of the audited narrow-card silhouette.
  // Reaction compositions keep their character staging, but the renderer now
  // gives their model substantially more room instead of converting them here.
  return plan?.composition_mode === "bookend";
}

function normalizedMotionScene(base: BaseAssetScene, ids: string[], promoteToFullCanvas: boolean): BaseAssetScene {
  const data = parseTemplateData(base);
  if (!data) return base;
  const performance = data["rendererPerformance"] && typeof data["rendererPerformance"] === "object"
    ? data["rendererPerformance"] as Record<string, unknown> : {};
  const normalized: Record<string, unknown> = {
    ...data,
    entityIdentityKeys: ids,
    ...(promoteToFullCanvas ? {
      compositionMode: "full-model",
      characterCutIn: "none",
      title: "",
      rendererPerformance: {
        ...performance,
        compositionMode: "full-model",
        characterCutIn: "none",
        watchabilityFullCanvas: true,
      },
    } : {}),
  };
  const template_data = templateDataWithinLimit(base.template_data, normalized);
  return template_data ? { ...base, template_data } : base;
}

function scoreScene(plan: PlanScene, script: ScriptScene, first: boolean, last: boolean): number {
  if (last || script.is_outro) return -100;
  let score = first ? 4 : 0;
  if (plan.scene_role === "character-reaction") score += 5;
  if (plan.scene_role === "kinetic-emphasis") score += 5;
  if (plan.scene_role === "object-state-change") score += 4;
  if (plan.scene_role === "character-hook") score += 4;
  if (plan.composition_mode === "reaction") score += 2;
  if (plan.character_cut_in && plan.character_cut_in !== "none") score += 1;
  if (AI_FRIENDLY_PRIMITIVES.has(plan.visual_primitive ?? "")) score += 3;
  if (MOTION_FIRST_PRIMITIVES.has(plan.visual_primitive ?? "")) score -= 5;
  if (["diagram-build", "process-flow", "comparison", "recap"].includes(plan.scene_role ?? "")) score -= 4;
  if (["counter", "sort", "group", "scale-compare"].includes(plan.visual_operation ?? "")) score -= 2;
  const before = clean(plan.state_before, 80), after = clean(plan.state_after, 80);
  if (before && after && before !== after && AI_FRIENDLY_PRIMITIVES.has(plan.visual_primitive ?? "")) score += 2;
  return score;
}
function cadenceLimit(startSec: number): number { return startSec < 15 ? 7.5 : startSec < 45 ? 11 : 16; }
function durationLookup(plans: PlanScene[], scripts: ScriptScene[], durations?: Map<number, number> | Record<number, number>): Map<number, number> {
  const scriptBy = new Map(scripts.map((scene) => [scene.scene_index, scene]));
  const out = new Map<number, number>();
  for (const plan of plans) {
    const supplied = durations instanceof Map ? durations.get(plan.scene_index) : durations?.[plan.scene_index];
    out.set(plan.scene_index, typeof supplied === "number" && supplied > 0 ? supplied : estimatedDuration(scriptBy.get(plan.scene_index) ?? { scene_index: plan.scene_index }));
  }
  return out;
}

export function selectAiScenes(plans: PlanScene[], scripts: ScriptScene[], durations?: Map<number, number> | Record<number, number>): Set<number> {
  const scriptBy = new Map(scripts.map((scene) => [scene.scene_index, scene]));
  const ordered = [...plans].sort((a, b) => a.scene_index - b.scene_index);
  if (!ordered.length) return new Set();
  const lastIndex = ordered[ordered.length - 1]!.scene_index;
  const durationBy = durationLookup(ordered, scripts, durations);
  const starts = new Map<number, number>();
  let cursor = 0;
  for (const plan of ordered) { starts.set(plan.scene_index, cursor); cursor += durationBy.get(plan.scene_index) ?? 0; }
  const targetAiSec = cursor * 0.34;
  const maxAiSec = cursor * 0.45;
  const candidates = ordered.map((plan, order) => {
    const script = scriptBy.get(plan.scene_index) ?? { scene_index: plan.scene_index };
    const start = starts.get(plan.scene_index) ?? 0;
    return { plan, script, start, duration: durationBy.get(plan.scene_index) ?? 2, score: scoreScene(plan, script, order === 0, plan.scene_index === lastIndex) };
  }).filter((item) => item.score > 0 && !item.script.is_outro && item.plan.scene_index !== lastIndex);

  const selected = new Set<number>();
  let selectedSec = 0;
  let lastAiEnd = 0;
  for (const item of candidates) {
    const gap = item.start - lastAiEnd;
    const spacing = selected.size === 0 || gap >= 3.5;
    const firstResetNeeded = selected.size === 0 && item.start < 12;
    const cadenceResetNeeded = selected.size > 0 && gap >= cadenceLimit(item.start);
    const strongCandidate = item.score >= 6 && selectedSec < targetAiSec && spacing;
    const withinBudget = selectedSec + item.duration <= maxAiSec || firstResetNeeded || cadenceResetNeeded;
    if (withinBudget && spacing && (firstResetNeeded || cadenceResetNeeded || strongCandidate)) {
      selected.add(item.plan.scene_index); selectedSec += item.duration; lastAiEnd = item.start + item.duration;
    }
  }
  if (selectedSec < targetAiSec) {
    const ranked = [...candidates].sort((a, b) => {
      const earlyA = a.start < 30 ? 2 : a.start < 60 ? 1 : 0;
      const earlyB = b.start < 30 ? 2 : b.start < 60 ? 1 : 0;
      return (b.score + earlyB) - (a.score + earlyA) || a.start - b.start;
    });
    for (const item of ranked) {
      if (selected.has(item.plan.scene_index) || selectedSec >= targetAiSec || selectedSec + item.duration > maxAiSec) continue;
      if ([...selected].some((index) => Math.abs((starts.get(index) ?? 0) - item.start) < 3.5)) continue;
      selected.add(item.plan.scene_index); selectedSec += item.duration;
    }
  }
  if (!selected.size && candidates.length) selected.add(candidates[0]!.plan.scene_index);

  // Safety valve: a diagram-heavy stretch is legitimately left AI-free (see
  // "short all-diagram episode still has a valid deterministic path" below,
  // which asserts a short 4-scene episode is NOT forced into an arbitrary AI
  // quota) — but an unbounded gap between AI resets still reads as visually
  // monotonous regardless of what kind of content fills it. Production runs
  // this session (run_9989c55b, run_8279e9b3, run_f0f60b55) trended
  // visual_reset_cadence 32.8s -> 25.7s -> 23.8s after the label/slot fixes,
  // still short of the <=16s QA target. Rather than loosen the score>0 filter
  // globally (which the diagram-heavy test exists specifically to prevent),
  // only intervene when a gap is long enough that no reasonable content
  // choice justifies it, and pick the least-bad scene inside that gap.
  const HARD_CEILING_SEC = 20;
  if (ordered.length > 2) {
    const scoredAll = ordered.map((plan, order) => {
      const script = scriptBy.get(plan.scene_index) ?? { scene_index: plan.scene_index };
      return { plan, script, start: starts.get(plan.scene_index) ?? 0, duration: durationBy.get(plan.scene_index) ?? 2, score: scoreScene(plan, script, order === 0, plan.scene_index === lastIndex) };
    });
    const selectedOrdered = [...selected].sort((a, b) => (starts.get(a) ?? 0) - (starts.get(b) ?? 0));
    const windowStarts = [0, ...selectedOrdered.map((i) => (starts.get(i) ?? 0) + (durationBy.get(i) ?? 0))];
    const windowEnds = [...selectedOrdered.map((i) => starts.get(i) ?? 0), cursor];
    for (let w = 0; w < windowStarts.length; w++) {
      const wStart = windowStarts[w]!, wEnd = windowEnds[w]!;
      if (wEnd - wStart <= HARD_CEILING_SEC || selectedSec >= maxAiSec) continue;
      // Converting a scene to ai_broll makes it count as character-visible by
      // default (hybrid_visual_assets always resolves the speaking character
      // for an AI shot, unlike a motion_graphic scene which can be marked
      // character_cut_in "none"). Confirmed against two live runs this
      // session (run_3c266ce5: cadence 23.8s->14.2s but character ratio
      // 35%->44%; run_a53a0170: cadence ->12.0s, ratio ->38%) that the valve
      // was pushing character_cut_in_restraint over its 35% cap. Preferring a
      // candidate the plan never marked as a character beat keeps the forced
      // pick's contribution to that ratio to the unavoidable minimum instead
      // of also picking up the +1 character_cut_in bonus in scoreScene.
      const pick = scoredAll
        .filter((item) => !selected.has(item.plan.scene_index) && item.plan.scene_index !== lastIndex && !item.script.is_outro && item.start >= wStart && item.start < wEnd)
        .sort((a, b) => {
          const aChar = a.plan.character_cut_in && a.plan.character_cut_in !== "none" ? 1 : 0;
          const bChar = b.plan.character_cut_in && b.plan.character_cut_in !== "none" ? 1 : 0;
          return aChar - bChar || b.score - a.score;
        })[0];
      if (pick && selectedSec + pick.duration <= maxAiSec) { selected.add(pick.plan.scene_index); selectedSec += pick.duration; }
    }
  }

  return selected;
}

function shotTypesFor(plan: PlanScene, first: boolean, durationSec: number): HybridShotType[] {
  const maxShots = durationSec >= 10 ? 3 : durationSec >= 5.5 ? 2 : 1;
  const preferred: HybridShotType[] = first ? ["establishing", "medium", "detail"]
    : plan.scene_role === "character-reaction" ? ["medium", "reaction", "close-up"]
    : plan.scene_role === "kinetic-emphasis" ? ["wide", "symbolic", "detail"]
    : plan.scene_role === "object-state-change" ? ["medium", "detail", "close-up"]
    : ["wide", "medium", "detail"];
  return preferred.slice(0, maxShots);
}
function semanticTextFallback(text: string, index: number, count: number): string {
  const parts = words(text); if (!parts.length) return "visual beat";
  const start = Math.floor(parts.length * index / count), end = Math.max(start + 1, Math.floor(parts.length * (index + 1) / count));
  return parts.slice(start, end).join(" ").slice(0, 240);
}
function alignmentText(alignment: AlignmentData | null, startSec: number, endSec: number): string {
  const chars = alignment?.characters, starts = alignment?.character_start_times_seconds, ends = alignment?.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) return "";
  const length = Math.min(chars.length, starts.length, ends.length); let text = "";
  for (let i = 0; i < length; i++) {
    const start = starts[i], end = ends[i]; if (typeof start !== "number" || typeof end !== "number") continue;
    const midpoint = (start + end) / 2;
    if (midpoint >= startSec && midpoint < endSec) text += chars[i] ?? "";
  }
  return clean(text, 240);
}
function shotSegments(shots: HybridShotType[], durationSec: number, script: ScriptScene, alignment: AlignmentData | null): ShotSegment[] {
  return shots.map((shot, index) => {
    const start = durationSec * index / shots.length, end = durationSec * (index + 1) / shots.length;
    return {
      shot_type: shot,
      start_sec: Number(start.toFixed(3)),
      end_sec: Number(end.toFixed(3)),
      semantic_text: alignmentText(alignment, start, end) || semanticTextFallback(script.narration ?? script.point ?? "", index, shots.length),
    };
  });
}
function visibleCast(base: BaseAssetScene, script: ScriptScene, cast: CastCharacter[]): CastCharacter[] {
  const data = parseTemplateData(base);
  const chars = Array.isArray(data?.["characters"]) ? data!["characters"] as unknown[] : [];
  const ids = chars.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const actor = (value as Record<string, unknown>)["actorId"];
    return typeof actor === "string" ? [actor] : [];
  });
  let chosen = cast.filter((character) => ids.includes(character.character_id));
  if (!chosen.length && script.speaker) {
    const speaker = clean(script.speaker, 60).toLowerCase();
    chosen = cast.filter((character) => character.character_id.toLowerCase() === speaker || clean(character.name, 60).toLowerCase() === speaker);
  }
  return chosen.slice(0, 2);
}
function motionVisibleCharacterIds(base: BaseAssetScene, script: ScriptScene, cast: CastCharacter[]): string[] | undefined {
  const data = parseTemplateData(base);
  if (!data) return undefined;
  const perf = data["rendererPerformance"] && typeof data["rendererPerformance"] === "object"
    ? data["rendererPerformance"] as Record<string, unknown> : {};
  const cutIn = perf["characterCutIn"] ?? data["characterCutIn"];
  if (cutIn === "none") return [];
  const visible = visibleCast(base, script, cast).map((character) => character.character_id);
  if (visible.length) return visible;
  // Missing/unknown telemetry deliberately stays undefined. QA treats that
  // conservatively as character-visible instead of silently granting a pass.
  return undefined;
}
function continuityGroup(visible: CastCharacter[], ids: string[], episodeEntity: string): string {
  const castIds = visible.map((c) => c.character_id).sort().join("-");
  return (castIds ? `cast:${castIds}` : `world:${ids[0] ?? episodeEntity}`).slice(0, 80);
}
function castBible(cast: CastCharacter[]): string {
  return cast.map((character) => {
    const palette = Array.isArray(character.color_palette) ? character.color_palette.join(", ") : "";
    return `${character.character_id}: ${clean(character.visual_description, 220)}${palette ? `; palette ${palette}` : ""}`;
  }).filter(Boolean).join(" | ");
}
function tokenPrompt(tokens: MotionEntityVisualToken[]): string {
  return tokens.map((token) => `${token.entity_id} uses ${token.color} and a ${token.shape} silhouette`).join("; ");
}
function shotPrompt(segment: ShotSegment, plan: PlanScene, script: ScriptScene, visible: CastCharacter[], group: string, tokens: MotionEntityVisualToken[]): string {
  const entities = (plan.model_elements ?? []).map((item) => clean(item, 60)).filter(Boolean).join(", ");
  const state = [clean(plan.state_before, 80), clean(plan.state_after, 80)].filter(Boolean).join(" -> ");
  const accent = STATE_ACCENT[plan.visual_state ?? "mechanism"] ?? STATE_ACCENT.mechanism;
  const instruction: Record<HybridShotType, string> = {
    establishing: "wide visual-hook shot: the surprising physical question must be obvious before the viewer reads a caption",
    wide: "wide cinematic story composition with foreground, midground and background separation",
    medium: "medium story shot focused on the concrete physical action, never a presenter beside an infographic",
    "close-up": "close-up with one dominant subject and an immediately readable reaction or physical change",
    detail: "tight insert of the exact object, molecular consequence, texture or state change being discussed",
    reaction: "reaction shot with a clear eyeline toward the important object or event",
    symbolic: "bold metaphor grounded in the real topic, with one clear subject rather than decorative abstraction",
    overhead: "overhead composition that makes the spatial relationship instantly legible",
  };
  return [
    HOUSE_STYLE,
    `Style ID ${MOTION_STYLE_ID}; palette ID ${MOTION_PALETTE_ID}; current semantic accent ${accent}.`,
    tokens.length ? `Preserve these motion-graphic entity identities in the illustration: ${tokenPrompt(tokens)}.` : "",
    `Continuity group ${group}; preserve any supplied recurring subject exactly.`,
    visible.length ? `Only these recurring characters may appear: ${castBible(visible)}.` : "No presenter character unless essential to the physical action.",
    `${instruction[segment.shot_type]}.`,
    entities ? `Canonical physical entities: ${entities}.` : "",
    state ? `Physical change: ${state}.` : "",
    `Visualize only this narration window: ${clean(segment.semantic_text, 240)}.`,
    clean(script.point, 180) ? `Underlying point: ${clean(script.point, 180)}.` : "",
    "The transition from the adjacent motion graphic should feel like the camera entered the same illustrated world. Show cause or consequence through concrete action. Keep the focal subject near the central safe area for gentle camera movement.",
  ].filter(Boolean).join(" ");
}
async function generatePack(provider: ConsistentPackProvider, prompts: string[], seed: number, reference?: GeneratedImage): Promise<GeneratedImage[]> {
  if (prompts.length < 1 || prompts.length > 5 || prompts.some((prompt) => !prompt.trim())) {
    throw new Error(`invalid continuity pack prompt set (${prompts.length} prompts)`);
  }
  if (provider.generatePack) {
    const out = await provider.generatePack({ prompts, aspect: "16:9", seed, ...(reference ? { reference } : {}) });
    if (out.images.length !== prompts.length) {
      throw new Error(`continuity pack returned ${out.images.length}/${prompts.length} requested images`);
    }
    return out.images;
  }
  // Independent regeneration would make a multi-shot scene or recurring
  // cross-scene subject visually drift. Fail closed to deterministic motion.
  if (reference || prompts.length > 1) {
    throw new Error("image provider cannot guarantee continuity-aware pack generation");
  }
  const out = await provider.generate({ prompt: prompts[0]!, aspect: "16:9", count: 1 });
  const image = out.images[0];
  if (!image) throw new Error("image provider returned no image");
  return [image];
}
function validateGenerated(images: GeneratedImage[], expected: number): void {
  if (images.length !== expected) throw new Error(`image provider returned ${images.length}/${expected} requested shots`);
  for (const [index, image] of images.entries()) {
    if (!image.media_type.startsWith("image/")) throw new Error(`shot ${index} returned non-image media type ${image.media_type}`);
    if (image.bytes.byteLength < 12_000) throw new Error(`shot ${index} is suspiciously small (${image.bytes.byteLength} bytes)`);
  }
}
function hookStrength(plan: PlanScene, base: BaseAssetScene, aiShots: number): number {
  let score = 0;
  if (entityIdsFor(plan).length) score += 0.2;
  const before = clean(plan.state_before, 80), after = clean(plan.state_after, 80);
  if (before && after && before !== after) score += 0.25;
  if (["character-hook", "object-state-change", "kinetic-emphasis"].includes(plan.scene_role ?? "")) score += 0.15;
  if (plan.visual_operation && plan.visual_operation !== "payoff") score += 0.1;
  if (aiShots >= 2) score += 0.3;
  else {
    const perf = parseTemplateData(base)?.["rendererPerformance"];
    if (perf && typeof perf === "object" && (perf as Record<string, unknown>)["meaningfulStateChange"] === true) score += 0.3;
  }
  return Math.min(1, Number(score.toFixed(2)));
}

export function makeHybridVisualAssetsWorker(): WorkerDef {
  return {
    name: "hybrid_visual_assets",
    kind: "worker",
    version: "4",
    consumes: [
      { schema_id: "asset_manifest", range: "^1", as: "compiled" },
      { schema_id: "explanation_plan", range: "^1", as: "plan" },
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "cast_roster", range: "^1", as: "cast" },
      { schema_id: "voice", range: "^1", as: "voice" },
    ],
    produces: "asset_manifest",
    produces_version: "1.5.0",
    async execute(inputs: Record<string, Artifact>, ctx: WorkerContext): Promise<WorkerOutput> {
      const compiled = inputs["compiled"]!.payload as { scenes: BaseAssetScene[]; degraded_count?: number };
      const plans = (inputs["plan"]!.payload as { scenes: PlanScene[] }).scenes;
      const scripts = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
      const cast = (inputs["cast"]!.payload as { characters: CastCharacter[] }).characters ?? [];
      const clips = (inputs["voice"]!.payload as { clips: VoiceClip[] }).clips ?? [];
      const clipBy = new Map(clips.map((clip) => [clip.scene_index, clip]));
      const durationBy = new Map(clips.map((clip) => [clip.scene_index, typeof clip.duration_sec === "number" && clip.duration_sec > 0 ? clip.duration_sec : 0]));
      const configured = ctx.media.images as ConsistentPackProvider | undefined;
      const provider = configured && !configured.id.startsWith("fake/") ? configured : undefined;
      const selected = selectAiScenes(plans, scripts, durationBy);
      const planBy = new Map(plans.map((scene) => [scene.scene_index, scene]));
      const scriptBy = new Map(scripts.map((scene) => [scene.scene_index, scene]));
      const orderedPlans = [...plans].sort((a, b) => a.scene_index - b.scene_index);
      if (!orderedPlans.length || orderedPlans[0]!.scene_index !== 0) throw new Error("hybrid visual invariant failed: explanation plan must contain literal scene_index 0");
      const lastIndex = orderedPlans[orderedPlans.length - 1]!.scene_index;
      const openingIds = entityIdsFor(orderedPlans[0]!);
      const episodeEntity = openingIds[0] ?? entityId(scripts[0]?.narration ?? "episode");
      const blobs: BlobRef[] = [];
      const anchors = new Map<string, GeneratedImage>();
      const scenes: HybridAssetScene[] = [];

      for (const original of [...compiled.scenes].sort((a, b) => a.scene_index - b.scene_index)) {
        const plan = planBy.get(original.scene_index);
        const script = scriptBy.get(original.scene_index) ?? { scene_index: original.scene_index };
        const clip = clipBy.get(original.scene_index);
        const durationSec = typeof clip?.duration_sec === "number" && clip.duration_sec > 0 ? clip.duration_sec : estimatedDuration(script);
        const isOpening = original.scene_index === 0, isClosing = original.scene_index === lastIndex;
        // The deterministic compiler deliberately makes the closing bookend
        // reuse the opening model. Keep those exact stable identities even if
        // the closing plan authors unrelated recap wording.
        const ids = isClosing ? openingIds : plan ? entityIdsFor(plan) : [];
        const tokens = motionEntityVisualTokens(ids);
        const promoteToFullCanvas = shouldPromoteToFullCanvas(plan, isOpening, isClosing);
        const base = normalizedMotionScene(original, ids, promoteToFullCanvas);
        const motionVisible = motionVisibleCharacterIds(base, script, cast);
        const common = {
          style_id: MOTION_STYLE_ID,
          palette_id: MOTION_PALETTE_ID,
          entity_ids: ids,
          entity_visual_tokens: tokens,
          duration_sec: Number(durationSec.toFixed(3)),
        };

        if (!plan || !selected.has(base.scene_index) || script.is_outro || !provider) {
          scenes.push({
            ...base,
            ...common,
            ...(motionVisible !== undefined ? { visible_character_ids: motionVisible } : {}),
            visual_mode: "motion_graphic",
            ...(isOpening ? { hook_strength: hookStrength(plan ?? { scene_index: 0 }, base, 0), hook_strategy: "motion_transformation" as const } : {}),
          });
          continue;
        }

        let alignment: AlignmentData | null = null;
        if (clip?.alignment_uri) {
          try { alignment = JSON.parse(new TextDecoder().decode(await ctx.blobs.get(clip.alignment_uri))) as AlignmentData; }
          catch (error) { ctx.logger.warn(`[hybrid_visual_assets] scene ${base.scene_index} alignment unavailable; using narration segmentation: ${error instanceof Error ? error.message : String(error)}`); }
        }
        const visible = visibleCast(original, script, cast);
        const visibleCharacterIds = visible.map((character) => character.character_id);
        const group = continuityGroup(visible, ids, episodeEntity);
        const shots = shotTypesFor(plan, isOpening, durationSec);
        const segments = shotSegments(shots, durationSec, script, alignment);
        const prompts = segments.map((segment) => shotPrompt(segment, plan, script, visible, group, tokens));
        const seed = stableHash(`${MOTION_STYLE_ID}:${group}`) & 0x7fffffff;

        try {
          const generated = await generatePack(provider, prompts, seed, anchors.get(group));
          validateGenerated(generated, prompts.length);
          if (!anchors.has(group)) anchors.set(group, generated[0]!);
          const refs: BlobRef[] = [];
          for (const image of generated) {
            const ref = await ctx.blobs.put(image.bytes, { role: "image", media_type: image.media_type });
            refs.push(ref); blobs.push(ref);
          }
          scenes.push({
            scene_index: base.scene_index,
            image_uri: refs[0]!.uri,
            image_uris: refs.map((ref) => ref.uri),
            source: "primary",
            prompt: prompts.join("\n---\n").slice(0, 3000),
            ...(base.template_data ? { template_data: base.template_data } : {}),
            ...common,
            visible_character_ids: visibleCharacterIds,
            visual_mode: "ai_broll",
            continuity_group: group,
            shot_types: shots,
            shot_segments: segments,
            ...(isOpening ? { hook_strength: hookStrength(plan, base, shots.length), hook_strategy: "ai_question" as const } : {}),
          });
        } catch (error) {
          ctx.logger.warn(`[hybrid_visual_assets] scene ${base.scene_index} AI pack failed; retaining deterministic motion graphic: ${error instanceof Error ? error.message : String(error)}`);
          scenes.push({
            ...base,
            ...common,
            ...(motionVisible !== undefined ? { visible_character_ids: motionVisible } : {}),
            visual_mode: "motion_graphic",
            continuity_group: group,
            ...(isOpening ? { hook_strength: hookStrength(plan, base, 0), hook_strategy: "fallback" as const } : {}),
          });
        }
      }

      const first = scenes.find((scene) => scene.scene_index === 0);
      if (!first || first.source === "placeholder" || !(first.image_uri || first.video_uri || first.template_category)) {
        throw new Error("hybrid visual invariant failed: literal scene 0 has no renderable visual");
      }
      return { payload: { scenes, degraded_count: compiled.degraded_count ?? 0 }, blobs };
    },
  };
}
