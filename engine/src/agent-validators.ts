import type { AgentDef } from "./runner.ts";
import type { Artifact } from "./artifact.ts";

const LONG_CARTOON_PLAN_SCENES = 13;

interface ScriptScene {
  scene_index: number;
  is_outro?: boolean;
}

interface PlanScene {
  scene_index: number;
  background_location?: string;
  background_variant?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function scriptScenes(inputs: Record<string, Artifact>): ScriptScene[] {
  const payload = asRecord(inputs["script"]?.payload);
  const scenes = payload?.scenes;
  return Array.isArray(scenes) ? scenes as ScriptScene[] : [];
}

function planScenes(payload: unknown): PlanScene[] {
  const record = asRecord(payload);
  const scenes = record?.scenes;
  return Array.isArray(scenes) ? scenes as PlanScene[] : [];
}

function backgroundKey(scene: PlanScene | undefined): string {
  if (!scene) return "";
  const location = typeof scene.background_location === "string" ? scene.background_location : "";
  const variant = typeof scene.background_variant === "string" ? scene.background_variant : "";
  return location && variant ? `${location}/${variant}` : "";
}

function validateCartoonVisualPlan(payload: unknown, inputs: Record<string, Artifact>): string[] {
  const contentScenes = scriptScenes(inputs)
    .filter((scene) => !scene.is_outro)
    .sort((a, b) => a.scene_index - b.scene_index);
  if (contentScenes.length < LONG_CARTOON_PLAN_SCENES) return [];

  const planByIndex = new Map(planScenes(payload).map((scene) => [scene.scene_index, scene]));
  const keys = new Set(
    contentScenes
      .map((scene) => backgroundKey(planByIndex.get(scene.scene_index)))
      .filter(Boolean),
  );
  if (keys.size >= 2) return [];

  const only = [...keys][0] ?? "unknown/unknown";
  return [
    `cartoon_visual_planner output is too static: all content scenes use ${only}. `
    + `Long cartoon episodes require at least two distinct visible environments before scene compilation; `
    + `change background_location/background_variant on a motivated subset of scenes.`,
  ];
}

export function agentSemanticValidationErrors(
  def: AgentDef,
  payload: unknown,
  inputs: Record<string, Artifact>,
): string[] {
  if (def.name === "cartoon_visual_planner" && def.produces === "visual_plan") {
    return validateCartoonVisualPlan(payload, inputs);
  }
  return [];
}
