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
