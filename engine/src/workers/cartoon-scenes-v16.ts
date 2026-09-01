import type { WorkerDef, WorkerOutput } from "../runner.ts";
import { operationFitsPrimitive, requiresNumericValue } from "../motion-contract.ts";
import { makeCartoonSceneCompilerWorker as makeV15CartoonSceneCompilerWorker } from "./cartoon-scenes-v15.ts";

export type ExplanationRole =
  | "character-hook"
  | "diagram-build"
  | "process-flow"
  | "object-state-change"
  | "comparison"
  | "kinetic-emphasis"
  | "character-reaction"
  | "recap";

export type VisualPrimitive =
  | "particles"
  | "rays"
  | "wave"
  | "horizon"
  | "spectrum"
  | "path"
  | "shells"
  | "objects"
  | "network"
  | "hierarchy"
  | "one-to-many"
  | "many-to-one"
  | "facets-around-center"
  | "overlapping-sets"
  | "nested-context"
  | "cycle"
  | "cause-chain"
  | "before-after"
  | "map"
  | "timeline"
  | "quantity"
  | "physical-transformation";

export type VisualOperation =
  | "stack"
  | "timeline"
  | "counter"
  | "compress"
  | "group"
  | "sort"
  | "scale-compare"
  | "payoff";

const VISUAL_OPERATIONS = new Set<VisualOperation>([
  "stack", "timeline", "counter", "compress",
  "group", "sort", "scale-compare", "payoff",
]);

interface ExplanationPlanScene {
  scene_index: number;
  scene_role?: ExplanationRole | string;
  visual_operation?: VisualOperation | string;
  visual_primitive?: VisualPrimitive | string;
  visual_state?: "hypothesis" | "contradiction" | "mechanism" | "qualification" | "payoff" | string;
  composition_mode?: "bookend" | "full-model" | "reaction" | string;
  explanation_title?: string;
  model_elements?: string[];
  model_relations?: unknown;
  numeric_value?: number | null;
  state_before?: string;
  state_after?: string;
  key_text?: string;
  character_cut_in?: "none" | "speaker" | "listener" | "both" | string;
  sound_cue?: "none" | "soft-hit" | "tick" | "whoosh" | "pop" | "resolve" | string;
}

interface CompiledEntry {
  scene_index: number;
  source: "template";
  template_category: string;
  template_data: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown, max = 80): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// Cleans model_elements AND reports where each ORIGINAL index ended up.
//
// model_relations (explanation_plan@1.5.0) addresses entities by their index
// in the plan's raw model_elements array, but this function trims, truncates,
// de-duplicates and caps at 4 -- so raw index 3 can easily become cleaned
// index 1, or disappear entirely. Returning only the cleaned array and
// letting the caller reuse the plan's indices against it would silently
// re-point edges at the wrong entities, drawing a claim the plan never made.
// A wrong edge is worse than a missing one, so the mapping is built here,
// beside the cleaning that causes the drift, rather than reconstructed later.
function cleanElementsWithIndexMap(value: unknown): { elements: string[]; indexMap: Map<number, number> } {
  const indexMap = new Map<number, number>();
  const elements: string[] = [];
  if (!Array.isArray(value)) return { elements, indexMap };
  const slotByLabel = new Map<string, number>();
  for (let raw = 0; raw < value.length; raw++) {
    const item = value[raw];
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    // Truncate long elements rather than dropping them. A resumed 1.2.0 plan
    // (deprecated but still valid, per the versioned-artifact contract) allows
    // elements up to 44 chars against 1.3.0's tighter 32 -- filtering those out
    // silently deleted labels the plan had explicitly authored, on top of the
    // renderer doing the same thing on overflow (see labelLines in
    // MotionDesignSystem.tsx). Neither layer should make content disappear.
    const label = trimmed.length <= 32 ? trimmed : `${trimmed.slice(0, 31).trimEnd()}…`;
    const existing = slotByLabel.get(label);
    if (existing !== undefined) {
      // A duplicate label is the same entity said twice: point the raw index
      // at the surviving slot instead of dropping any edge that used it.
      indexMap.set(raw, existing);
      continue;
    }
    if (elements.length >= 4) continue;
    slotByLabel.set(label, elements.length);
    indexMap.set(raw, elements.length);
    elements.push(label);
  }
  return { elements, indexMap };
}

function cleanElements(value: unknown): string[] {
  return cleanElementsWithIndexMap(value).elements;
}

const RELATION_KINDS = new Set(["causes", "blocks", "becomes", "feeds", "contains"]);
const MAX_RELATIONS = 6;

export interface ModelRelation {
  from: number;
  to: number;
  kind: string;
}

// Every rejection here is silent by design: an unusable edge must degrade to
// "this diagram has one fewer connection", never to a thrown error that fails
// the whole episode. The renderer falls back to its previous fixed topology
// when the relation list comes back empty, so dropping every edge of a
// malformed plan lands exactly on the pre-1.5.0 behaviour.
function cleanRelations(value: unknown, indexMap: Map<number, number>, elementCount: number): ModelRelation[] {
  if (!Array.isArray(value)) return [];
  const relations: ModelRelation[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const record = asRecord(raw);
    if (!record) continue;
    const rawFrom = record["from_element"];
    const rawTo = record["to_element"];
    if (!Number.isInteger(rawFrom) || !Number.isInteger(rawTo)) continue;
    const from = indexMap.get(rawFrom as number);
    const to = indexMap.get(rawTo as number);
    // undefined = the plan referenced an entity that cleaning removed, or one
    // that never existed. from === to = a self-loop, which no primitive can
    // draw as anything a viewer would read as a relationship.
    if (from === undefined || to === undefined || from === to) continue;
    if (from >= elementCount || to >= elementCount) continue;
    const kind = typeof record["kind"] === "string" ? record["kind"] : "";
    if (!RELATION_KINDS.has(kind)) continue;
    const key = `${from}>${to}:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relations.push({ from, to, kind });
    if (relations.length >= MAX_RELATIONS) break;
  }
  return relations;
}

function cleanPayoff(value: unknown): string {
  const text = cleanText(value, 72);
  if (text.length <= 52) return text;
  const sentence = text.split(/[.!?;:]/, 1)[0]?.trim() ?? "";
  return sentence.length >= 8 && sentence.length <= 52 ? sentence : text.slice(0, 49).replace(/\s+\S*$/, "") + "…";
}

function inferVisualPrimitive(plan: ExplanationPlanScene): VisualPrimitive {
  const explicit = cleanText(plan.visual_primitive, 24) as VisualPrimitive;
  const allowed = new Set<VisualPrimitive>([
    "particles", "rays", "wave", "horizon",
    "spectrum", "path", "shells", "objects",
    "network", "hierarchy", "one-to-many", "many-to-one", "facets-around-center",
    "overlapping-sets", "nested-context", "cycle", "cause-chain", "before-after",
    "map", "timeline", "quantity", "physical-transformation",
  ]);
  if (allowed.has(explicit)) return explicit;

  const terms = [
    plan.explanation_title, plan.key_text, plan.state_before, plan.state_after,
    ...(Array.isArray(plan.model_elements) ? plan.model_elements : []),
  ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();

  if (/overlap|shared categor|both groups|intersection/.test(terms)) return "overlapping-sets";
  if (/one source|single source|many forms|manifest|facets|viewpoints|attributes around/.test(terms)) return "facets-around-center";
  if (/converge|many inputs|combine into|merge into/.test(terms)) return "many-to-one";
  if (/branch|one becomes many|one produces|splits into/.test(terms)) return "one-to-many";
  if (/hierarchy|rank|parent|child|taxonomy|family tree/.test(terms)) return "hierarchy";
  if (/network|connected|relationship|interact|web of/.test(terms)) return "network";
  if (/nested|context|inside|layers of meaning/.test(terms)) return "nested-context";
  if (/cycle|loop|feeds back|repeats/.test(terms)) return "cycle";
  if (/causes|leads to|results in|chain|because then/.test(terms)) return "cause-chain";
  if (/before|after|changed from|became|transform/.test(terms)) return "before-after";
  if (/map|location|route|region|travel across/.test(terms)) return "map";
  if (/timeline|years|century|era|over time/.test(terms)) return "timeline";
  if (/quantity|count|amount|more|fewer|increase|decrease/.test(terms)) return "quantity";
  if (/wavelength|spectrum|infrared|microwave|redshift|ultraviolet/.test(terms)) return "spectrum";
  if (/sightline|ray|beam|direction/.test(terms)) return "rays";
  if (/horizon|boundary|reach limit|finite|observable/.test(terms)) return "horizon";
  if (/pulse|travel|arriv|journey|signal|path/.test(terms)) return "path";
  if (/layer|shell|depth|nested/.test(terms)) return "shells";
  if (/wave|oscillat|frequency/.test(terms)) return "wave";
  if (/star|particle|pin|dot|gap|sky/.test(terms)) return "particles";
  return "objects";
}

function planScenes(inputs: Record<string, { payload?: unknown } | undefined>): ExplanationPlanScene[] {
  const payload = asRecord(inputs["plan"]?.payload);
  return Array.isArray(payload?.scenes) ? payload.scenes as ExplanationPlanScene[] : [];
}

/**
 * Converts the final cinematic-puppet payload into an explanation-first
 * payload. The accumulated v1-v15 compiler remains the compatibility layer for
 * cast identity and acting data; this boundary changes what owns the frame.
 */
export function applyExplanationFormat(
  entries: CompiledEntry[],
  plans: ExplanationPlanScene[],
): CompiledEntry[] {
  const byIndex = new Map(plans.map((scene) => [scene.scene_index, scene]));
  const orderedPlans = [...plans].sort((a, b) => a.scene_index - b.scene_index);
  const openingPlan = orderedPlans[0];
  // A trailing character-room scene (the spoken outro/CTA, always the
  // literal last scene when the script authors one -- see
  // explanation_visual_planner's "The outro scene" section) has no diagram
  // and reuses no entities, so it must never be treated as "the closing
  // scene" for the reuse-opening-entities bookend logic below: that belongs
  // to the actual recap/teach-back scene right before it. Falling back to
  // the literal last scene when nothing is filtered keeps old plans with no
  // outro scene behaving exactly as before.
  const closingCandidates = orderedPlans.filter((scene) => scene.composition_mode !== "character-room");
  const closingPlan = closingCandidates[closingCandidates.length - 1] ?? orderedPlans[orderedPlans.length - 1];
  const openingIndex = openingPlan?.scene_index;
  const closingIndex = closingPlan?.scene_index;
  const openingPrimitive = openingPlan ? inferVisualPrimitive(openingPlan) : "objects";
  const openingCleaned = cleanElementsWithIndexMap(openingPlan?.model_elements);
  const openingElements = openingCleaned.elements;
  // The closing scene replaces its own entities with the opening's (below).
  // Its authored relations index into the entities it just lost, so they have
  // to be replaced too -- reusing them against a different entity list is
  // exactly the mis-pointing cleanElementsWithIndexMap exists to prevent.
  const openingRelations = cleanRelations(openingPlan?.model_relations, openingCleaned.indexMap, openingElements.length);

  return entries.map((entry) => {
    const plan = byIndex.get(entry.scene_index);
    if (!plan?.scene_role) return entry;

    // character-room scenes have no diagram at all -- the v1-v15
    // cinematic-puppet compiler above already built a complete, correct
    // CartoonScene payload for this scene (background, camera, both
    // characters positioned/gestured/gazing per the plan's speaker_*/
    // listener_*/background_location fields, mouth-cue wiring downstream in
    // compose.js keyed off template_category==="cartoon"). Everything below
    // this point exists to REPLACE that payload with a diagram-shaped
    // explanation one; a character-room scene wants the opposite, so it
    // passes through untouched with its template_category still "cartoon"
    // rather than being reformatted into a diagram it was never meant to
    // have.
    if (plan.composition_mode === "character-room") return entry;

    const legacy = JSON.parse(entry.template_data) as Record<string, unknown>;
    const characters = Array.isArray(legacy.characters) ? legacy.characters : [];
    const authoredRole = plan.scene_role as ExplanationRole;
    const role: ExplanationRole = entry.scene_index === openingIndex
      ? "character-hook"
      : entry.scene_index === closingIndex
        ? "recap"
        : authoredRole;
    const roleWasNormalized = role !== authoredRole;
    const plannedOperation = cleanText(plan.visual_operation, 24) as VisualOperation;
    if (!VISUAL_OPERATIONS.has(plannedOperation)) {
      throw new Error(`Scene ${entry.scene_index} requires a valid visual_operation`);
    }
    // A preserved plan cannot be regenerated when a resumed run starts at this
    // compiler. Normalize the cross-field recap invariant deterministically so
    // older successful artifacts still receive the decisive payoff renderer.
    const operation: VisualOperation = entry.scene_index === closingIndex ? "payoff" : plannedOperation;
    const operationWasNormalized = operation !== plannedOperation;
    const plannedPrimitive = inferVisualPrimitive(plan);
    // The final payoff must resolve the visual question the viewer first saw,
    // not introduce an unrelated graphical vocabulary.
    const primitive: VisualPrimitive = entry.scene_index === closingIndex ? openingPrimitive : plannedPrimitive;
    const primitiveWasNormalized = primitive !== plannedPrimitive;
    if (!operationFitsPrimitive(operation, primitive)) {
      throw new Error(`Scene ${entry.scene_index} visual_operation "${operation}" is incompatible with visual_primitive "${primitive}"`);
    }
    const hasNumericField = Object.prototype.hasOwnProperty.call(plan, "numeric_value");
    const numericValue = typeof plan.numeric_value === "number" && Number.isFinite(plan.numeric_value)
      ? plan.numeric_value
      : null;
    if (hasNumericField && requiresNumericValue(operation, primitive) && numericValue === null) {
      throw new Error(`Scene ${entry.scene_index} requires numeric_value for ${operation}/${primitive}`);
    }
    const authoredCutIn = cleanText(plan.character_cut_in || "none", 16);
    const cutIn = entry.scene_index === openingIndex || entry.scene_index === closingIndex
      ? "both"
      : authoredCutIn || (role === "character-reaction" ? "listener" : "none");
    const cutInWasNormalized = cutIn !== authoredCutIn;
    const authoredVisualState = cleanText(plan.visual_state || "mechanism", 20);
    const visualState = entry.scene_index === closingIndex
      ? "payoff"
      : ["hypothesis", "contradiction", "mechanism", "qualification", "payoff"].includes(authoredVisualState)
        ? authoredVisualState
        : "mechanism";
    const authoredCompositionMode = cleanText(plan.composition_mode || "full-model", 20);
    const compositionMode = entry.scene_index === openingIndex || entry.scene_index === closingIndex
      ? "bookend"
      : authoredCompositionMode === "reaction" || role === "character-reaction" || cutIn !== "none"
        ? "reaction"
        : "full-model";

    // Closing continuity is deterministic, not a prompt wish: reconstruct the
    // exact entities introduced by the hook so stable renderer identity
    // survives even when a preserved plan authored unrelated recap labels.
    const planned = cleanElementsWithIndexMap(plan.model_elements);
    const plannedElements = planned.elements;
    const reuseOpening = entry.scene_index === closingIndex && openingElements.length > 0;
    const elements = reuseOpening ? openingElements : plannedElements;
    const modelRelations = reuseOpening
      ? openingRelations
      : cleanRelations(plan.model_relations, planned.indexMap, plannedElements.length);
    const payload = {
      formatVersion: 4,
      role,
      visualOperation: operation,
      visualPrimitive: primitive,
      visualState,
      compositionMode,
      // Intermediate headings made the render read as a slide deck. Only the
      // opening owns an orienting title; the final scene owns one payoff line.
      title: entry.scene_index === openingIndex ? cleanText(plan.explanation_title, 52) : "",
      keyText: entry.scene_index === closingIndex ? cleanPayoff(plan.key_text || plan.state_after) : cleanText(plan.key_text, 72),
      elements,
      entityIdentityKeys: elements.map((element) => element.toLocaleLowerCase()),
      // The authored topology between those entities, as cleaned indices into
      // `elements` above. Before this every relationship primitive drew a
      // fixed graph, and only the labels sitting on it varied by episode.
      modelRelations,
      numericValue,
      before: entry.scene_index === closingIndex ? "" : cleanText(plan.state_before, 44),
      after: cleanText(plan.state_after, 44),
      characterCutIn: cutIn,
      soundCue: cleanText(plan.sound_cue || "none", 16),
      characters,
      visualStyle: legacy.visualStyle ?? legacy.visual_style,
      speakerEmphasis: legacy.speakerEmphasis,
      rendererPerformance: {
        ...(asRecord(legacy.rendererPerformance) ?? {}),
        format: "explanation-motion",
        explanationRole: role,
        visualOperation: operation,
        visualPrimitive: primitive,
        visualState,
        compositionMode,
        roleWasNormalized,
        operationWasNormalized,
        primitiveWasNormalized,
        cutInWasNormalized,
        characterCutIn: cutIn,
        explanatoryModelVisible: !["character-hook", "character-reaction"].includes(role),
        meaningfulStateChange: ["diagram-build", "process-flow", "object-state-change", "comparison", "recap"].includes(role),
      },
    };

    return {
      ...entry,
      template_category: "explanation",
      template_data: JSON.stringify(payload),
    };
  });
}

export function makeCartoonSceneCompilerWorker(): WorkerDef {
  const v15 = makeV15CartoonSceneCompilerWorker();
  return {
    ...v15,
    version: "26",
    consumes: v15.consumes
      .filter((input) => input.as !== "creative_direction")
      .map((input) => input.as === "plan" ? { ...input, schema_id: "explanation_plan", range: "^1" } : input),
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const plans = planScenes(inputs as Record<string, { payload?: unknown } | undefined>);
      const planInput = inputs["plan"];
      const planPayload = asRecord(planInput?.payload);
      // v1-v15 remain the cast/acting compatibility compiler and correctly
      // reject unknown categories. Feed that boundary a legacy category, then
      // restore the explanation-first contract after it has done its work.
      const legacyInputs = plans.some((scene) => scene.scene_role) && planInput && planPayload
        ? {
          ...inputs,
          plan: {
            ...planInput,
            payload: {
              ...planPayload,
              scenes: plans.map((scene) => ({
                background_location: "studio",
                background_variant: "normal",
                background_tone: "neutral",
                framing: "two-shot",
                camera_motion: "static",
                listener_actor_id: "host",
                speaker_emotion: "neutral",
                speaker_gesture: "idle",
                speaker_gaze_target: "auto",
                listener_emotion: "neutral",
                listener_gesture: "idle",
                listener_gaze_target: "auto",
                visual_event: "none",
                ambient_motion: "none",
                speaker_emphasis: "none",
                cutaway_label: "",
                ...scene,
                template_category: "cartoon",
              })),
            },
          },
        }
        : inputs;
      const out = await v15.execute(legacyInputs, ctx);
      if (!plans.some((scene) => scene.scene_role)) return out;

      const payload = out.payload as { scenes: CompiledEntry[]; degraded_count?: number };
      return {
        ...out,
        payload: {
          ...payload,
          scenes: applyExplanationFormat(payload.scenes, plans),
        },
      };
    },
  };
}
