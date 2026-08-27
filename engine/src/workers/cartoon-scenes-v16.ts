import type { WorkerDef, WorkerOutput } from "../runner.ts";
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

function cleanElements(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 44))
    .filter(Boolean)
    .slice(0, 5);
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
  const closingPlan = orderedPlans[orderedPlans.length - 1];
  const openingIndex = openingPlan?.scene_index;
  const closingIndex = closingPlan?.scene_index;
  const openingPrimitive = openingPlan ? inferVisualPrimitive(openingPlan) : "objects";

  return entries.map((entry) => {
    const plan = byIndex.get(entry.scene_index);
    if (!plan?.scene_role) return entry;

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
      : authoredCompositionMode === "reaction" || authoredCompositionMode === "bookend"
        ? authoredCompositionMode
        : "full-model";

    const payload = {
      formatVersion: 2,
      role,
      visualOperation: operation,
      visualPrimitive: primitive,
      visualState,
      compositionMode,
      title: cleanText(plan.explanation_title),
      keyText: cleanText(plan.key_text, 96),
      elements: cleanElements(plan.model_elements),
      before: cleanText(plan.state_before, 64),
      after: cleanText(plan.state_after, 64),
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
    version: "24",
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
              scenes: plans.map((scene) => ({ ...scene, template_category: "cartoon" })),
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
