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
  | "objects";

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
  ]);
  if (allowed.has(explicit)) return explicit;

  const terms = [
    plan.explanation_title, plan.key_text, plan.state_before, plan.state_after,
    ...(Array.isArray(plan.model_elements) ? plan.model_elements : []),
  ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();

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
  const openingPlan = plans.find((scene) => scene.scene_role === "character-hook") ?? plans[0];
  const openingPrimitive = openingPlan ? inferVisualPrimitive(openingPlan) : "objects";

  return entries.map((entry) => {
    const plan = byIndex.get(entry.scene_index);
    if (!plan?.scene_role) return entry;

    const legacy = JSON.parse(entry.template_data) as Record<string, unknown>;
    const characters = Array.isArray(legacy.characters) ? legacy.characters : [];
    const role = plan.scene_role as ExplanationRole;
    const plannedOperation = cleanText(plan.visual_operation, 24) as VisualOperation;
    if (!VISUAL_OPERATIONS.has(plannedOperation)) {
      throw new Error(`Scene ${entry.scene_index} requires a valid visual_operation`);
    }
    // A preserved plan cannot be regenerated when a resumed run starts at this
    // compiler. Normalize the cross-field recap invariant deterministically so
    // older successful artifacts still receive the decisive payoff renderer.
    const operation: VisualOperation = role === "recap" ? "payoff" : plannedOperation;
    const operationWasNormalized = operation !== plannedOperation;
    const plannedPrimitive = inferVisualPrimitive(plan);
    // The final payoff must resolve the visual question the viewer first saw,
    // not introduce an unrelated graphical vocabulary.
    const primitive: VisualPrimitive = role === "recap" ? openingPrimitive : plannedPrimitive;
    const primitiveWasNormalized = primitive !== plannedPrimitive;
    const cutIn = cleanText(plan.character_cut_in || (
      role === "character-hook" ? "both" :
      role === "character-reaction" ? "listener" :
      role === "recap" ? "speaker" : "none"
    ), 16);

    const payload = {
      formatVersion: 2,
      role,
      visualOperation: operation,
      visualPrimitive: primitive,
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
        operationWasNormalized,
        primitiveWasNormalized,
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
    version: "22",
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
