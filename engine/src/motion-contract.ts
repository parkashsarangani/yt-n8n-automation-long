export type MotionOperation =
  | "stack" | "timeline" | "counter" | "compress"
  | "group" | "sort" | "scale-compare" | "payoff";

export const MOTION_COMPATIBILITY = {
  stack: ["particles", "objects", "hierarchy", "nested-context", "quantity", "shells"],
  timeline: ["timeline", "cause-chain", "path", "map", "rays", "wave", "spectrum", "cycle", "particles"],
  counter: ["quantity", "particles", "objects"],
  compress: ["particles", "objects", "many-to-one", "physical-transformation", "before-after", "shells"],
  group: ["network", "one-to-many", "many-to-one", "facets-around-center", "overlapping-sets", "nested-context", "particles", "objects"],
  sort: ["objects", "hierarchy", "quantity", "timeline"],
  "scale-compare": ["before-after", "physical-transformation", "spectrum", "quantity", "objects", "overlapping-sets"],
  payoff: ["*"],
} as const satisfies Record<MotionOperation, readonly string[]>;

export function operationFitsPrimitive(operation: MotionOperation, primitive: string): boolean {
  const supported = MOTION_COMPATIBILITY[operation];
  return supported.includes("*" as never) || supported.includes(primitive as never);
}

export function requiresNumericValue(operation: MotionOperation, primitive: string): boolean {
  return operation === "counter" || primitive === "quantity";
}
