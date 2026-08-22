import type { AgentDef } from "./runner.ts";
import type { Artifact } from "./artifact.ts";

const LONG_CARTOON_PLAN_SCENES = 13;
const SHORT_DIALOGUE_WORD_LIMIT = 10;

interface ScriptScene {
  scene_index: number;
  narration?: string;
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

function scenesFromPayload(payload: unknown): ScriptScene[] {
  const record = asRecord(payload);
  const scenes = record?.scenes;
  return Array.isArray(scenes) ? scenes as ScriptScene[] : [];
}

function inputScriptScenes(inputs: Record<string, Artifact>): ScriptScene[] {
  return scenesFromPayload(inputs["script"]?.payload);
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

function wordCount(value: unknown): number {
  return typeof value === "string"
    ? value.trim().split(/\s+/).filter(Boolean).length
    : 0;
}

// Mirrors cartoon_scene_compiler's assertNaturalDialogue humanMomentLines check
// (engine/src/workers/cartoon-scenes-v9.ts) so the writer retries on this signal
// before the compiler ever sees the script, instead of failing two stages later.
const HUMAN_MOMENT_PATTERN = /\b(?:i|i'm|im|i’ll|i'd|me|my|you|you're|youre|your|we|we're|were|wait|nope|ugh|okay|still|again|late|where|why|how|fine|hate|rude|keys?)\b|(?:n't|'m|'re|'ve|'ll|'d)/i;
const HUMAN_MOMENT_MIN_RATIO = 0.45;

function validateDialogueScript(payload: unknown, def: AgentDef): string[] {
  const contentScenes = scenesFromPayload(payload)
    .filter((scene) => !scene.is_outro)
    .sort((a, b) => a.scene_index - b.scene_index);
  if (contentScenes.length === 0) return [];

  const failures: string[] = [];

  const shortLineCount = contentScenes.filter((scene) => wordCount(scene.narration) <= SHORT_DIALOGUE_WORD_LIMIT).length;
  const requiredShortLines = Math.ceil(contentScenes.length / 2);
  if (shortLineCount < requiredShortLines) {
    failures.push(
      `${shortLineCount}/${contentScenes.length} lines are ${SHORT_DIALOGUE_WORD_LIMIT} words or fewer; `
      + `at least half (${requiredShortLines}/${contentScenes.length}) must be short`,
    );
  }

  const humanMomentCount = contentScenes.filter((scene) => HUMAN_MOMENT_PATTERN.test(scene.narration ?? "")).length;
  const requiredHumanMomentLines = Math.ceil(contentScenes.length * HUMAN_MOMENT_MIN_RATIO);
  if (humanMomentCount < requiredHumanMomentLines) {
    failures.push(
      `${humanMomentCount}/${contentScenes.length} lines sound like someone inside the situation `
      + `(first/second-person pronouns, contractions, or situational words); `
      + `at least ${requiredHumanMomentLines}/${contentScenes.length} are required`,
    );
  }

  if (failures.length === 0) return [];

  return [
    `${def.name}@${def.version ?? "1"} natural dialogue gate failed: ${failures.join("; ")}. `
    + `Rewrite as short, human, situational dialogue, not textbook/explainer speech.`,
  ];
}

function validateCartoonVisualPlan(payload: unknown, inputs: Record<string, Artifact>): string[] {
  const contentScenes = inputScriptScenes(inputs)
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
  if (def.name === "dialogue_script_writer" && def.produces === "script") {
    return validateDialogueScript(payload, def);
  }
  if (def.name === "cartoon_visual_planner" && def.produces === "visual_plan") {
    return validateCartoonVisualPlan(payload, inputs);
  }
  return [];
}
