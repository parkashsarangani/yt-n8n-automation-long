import compatibility from "./motion-compatibility.json" with { type: "json" };

export type MotionOperation =
  | "stack" | "timeline" | "counter" | "compress"
  | "group" | "sort" | "scale-compare" | "payoff";

export const MOTION_COMPATIBILITY = compatibility as Record<MotionOperation, readonly string[]>;

export function operationFitsPrimitive(operation: MotionOperation, primitive: string): boolean {
  return MOTION_COMPATIBILITY[operation].includes(primitive);
}

export function requiresNumericValue(operation: MotionOperation, primitive: string): boolean {
  return operation === "counter" || primitive === "quantity";
}

export interface MotionRepair {
  path: string;
  from: string;
  to: string;
}

const OPERATIONS_FOR_PRIMITIVE = (() => {
  const reverse = new Map<string, MotionOperation[]>();
  for (const [operation, primitives] of Object.entries(MOTION_COMPATIBILITY) as Array<[MotionOperation, readonly string[]]>) {
    for (const primitive of primitives) {
      const list = reverse.get(primitive) ?? [];
      list.push(operation);
      reverse.set(primitive, list);
    }
  }
  return reverse;
})();

/**
 * Deterministically fixes an incompatible visual_operation/visual_primitive
 * pair before the semantic gate ever sees it, the same way schema-repair.ts
 * snaps a near-miss enum value: pick the closest valid alternative instead of
 * spending a full retry attempt on a mistake the system already knows how to
 * fix.
 *
 * Production evidence this is worth doing rather than just retrying harder:
 * explanation_visual_planner exhausted all 3 attempts on run_39850b3e without
 * ever producing a compatible ~40-scene plan -- each attempt fixed some pairs
 * and broke others, spending the whole retry budget on this one problem and
 * leaving none for the unrelated numeric_value rule that then blocked the
 * final attempt.
 *
 * The primitive is kept and the operation is replaced, not the reverse. A
 * primitive is what the scene depicts, tied to the narration it illustrates;
 * an operation is the animation applied to it, and is comparatively
 * interchangeable. "payoff" is deliberately deprioritized as a repair target:
 * it is the recap-only operation, and defaulting every mismatch to it would
 * flatten the visual variety the plan is supposed to have.
 */
export function repairMotionCompatibility(payload: unknown): { data: unknown; repairs: MotionRepair[] } {
  const repairs: MotionRepair[] = [];
  if (!payload || typeof payload !== "object") return { data: payload, repairs };
  const scenes = (payload as { scenes?: unknown }).scenes;
  if (!Array.isArray(scenes)) return { data: payload, repairs };

  const repairedScenes = scenes.map((raw, index) => {
    if (!raw || typeof raw !== "object") return raw;
    const scene = raw as Record<string, unknown>;
    const operation = scene.visual_operation;
    const primitive = scene.visual_primitive;
    if (typeof operation !== "string" || typeof primitive !== "string") return scene;
    // An operation string outside the enum entirely is a job for
    // repairEnumValues (near-miss casing/whitespace) or the schema gate, not
    // this repair -- it only fixes a real, valid-but-incompatible pair.
    if (!(operation in MOTION_COMPATIBILITY)) return scene;
    if (operationFitsPrimitive(operation as MotionOperation, primitive)) return scene;

    const candidates = OPERATIONS_FOR_PRIMITIVE.get(primitive);
    if (!candidates || candidates.length === 0) return scene;
    const to = candidates.find((op) => op !== "payoff") ?? candidates[0]!;

    repairs.push({ path: `$.scenes[${index}].visual_operation`, from: operation, to });
    return { ...scene, visual_operation: to };
  });

  return { data: { ...(payload as Record<string, unknown>), scenes: repairedScenes }, repairs };
}

// explanation_plan@1.4.0 tightened state_before/state_after to 32 chars and
// key_text to 48 -- the planner is now told this explicitly (see the
// explanation_visual_planner prompt), but an LLM instruction is not a hard
// guarantee the way a schema is. Rather than burn a full retry attempt (and
// risk exhausting the 3-attempt budget, per repairMotionCompatibility's own
// production evidence) on an otherwise-good plan whose only problem is one
// field running a few characters long, clamp at a word boundary the same way
// the Remotion renderer's own labelLines() degrades an overflow: keep whole
// words, mark the cut with an ellipsis, never chop mid-word.
const LABEL_FIELD_LIMITS: Record<string, number> = {
  state_before: 32,
  state_after: 32,
  key_text: 48,
};

function clampAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength - 1);
  const lastSpace = truncated.lastIndexOf(" ");
  const base = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return `${base.trimEnd()}…`;
}

export function repairOverlongLabels(payload: unknown): { data: unknown; repairs: MotionRepair[] } {
  const repairs: MotionRepair[] = [];
  if (!payload || typeof payload !== "object") return { data: payload, repairs };
  const scenes = (payload as { scenes?: unknown }).scenes;
  if (!Array.isArray(scenes)) return { data: payload, repairs };

  const repairedScenes = scenes.map((raw, index) => {
    if (!raw || typeof raw !== "object") return raw;
    let scene = raw as Record<string, unknown>;
    for (const [field, limit] of Object.entries(LABEL_FIELD_LIMITS)) {
      const value = scene[field];
      if (typeof value !== "string" || value.length <= limit) continue;
      const to = clampAtWordBoundary(value, limit);
      repairs.push({ path: `$.scenes[${index}].${field}`, from: value, to });
      scene = { ...scene, [field]: to };
    }
    return scene;
  });

  return { data: { ...(payload as Record<string, unknown>), scenes: repairedScenes }, repairs };
}
