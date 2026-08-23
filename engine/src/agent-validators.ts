import type { AgentDef } from "./runner.ts";
import type { Artifact } from "./artifact.ts";

const LONG_CARTOON_PLAN_SCENES = 13;
const SHORT_DIALOGUE_WORD_LIMIT = 10;

interface ScriptScene {
  scene_index: number;
  narration?: string;
  point?: string;
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

const DEFINITIONAL_DIALOGUE_PATTERN = /\b(?:this means|the reason is|in other words|research shows|studies show|is called|it's called|it is called|by that,\s*(?:it's|it is)\s+called|actually tested this|that is fascinating|that's fascinating|interesting)\b/i;
const TRAILING_ELLIPSIS_PATTERN = /\.\.\.\s*$/;

// Mirrors cartoon_scene_compiler's assertTopicPropSemantics (engine/src/workers/
// cartoon-scenes-v9.ts): planning/lateness scripts must not default to phone as
// the central prop. Ported here so the writer retries on this signal instead of
// leaving an already-"current" v7 script permanently stuck at the compiler gate
// (resume only re-runs a node whose recorded version is stale, so a script that
// passes writer-stage checks once will never be re-validated against a gate that
// only exists downstream).

function pointField(scene: ScriptScene, keys: string[]): string {
  const point = scene.point ?? "";
  for (const key of keys) {
    const match = new RegExp(`(?:^|[;|])\\s*${key}\\s*[:=]\\s*([^;|]+)`, "i").exec(point);
    if (match?.[1]) return match[1].replace(/\s+/g, " ").trim().toLowerCase();
  }
  return "";
}

function normalizedProp(value: string): string {
  const cleaned = value
    .replace(/\b(?:the|a|an|central|object|prop|this|that|my|your|his|her|their|our|its)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const canonicalizers: Array<[RegExp, string]> = [
    [/\b(?:phone|screen|app|notification|message|text|lock\s*screen)\b/, "phone"],
    [/\b(?:airplane\s+window|plane\s+window|cabin\s+window|window)\b/, "window"],
    [/\b(?:clock|timer|alarm|watch|countdown|time)\b/, "clock"],
    [/\b(?:keys?|keyring)\b/, "keys"],
    [/\b(?:calendar|schedule|planner|plan|estimate|buffer)\b/, "calendar"],
    [/\b(?:route\s*map|map|route|traffic|gps)\b/, "route-map"],
    [/\b(?:door|doorway|front\s+door)\b/, "door"],
    [/\b(?:coffee|cup|mug)\b/, "coffee"],
    [/\b(?:shoes?|sneakers?|boots?)\b/, "shoes"],
    [/\b(?:kettle|tea\s+kettle)\b/, "kettle"],
    [/\b(?:bill|invoice|receipt|statement)\b/, "bill"],
    [/\b(?:letter|envelope|mail)\b/, "letter"],
    [/\b(?:tool|hammer|wrench|screwdriver|drill)\b/, "tool"],
    [/\b(?:vehicle|car|bus|train|bike|bicycle|scooter|airplane|plane)\b/, "vehicle"],
    [/\b(?:food|meal|snack|banana|sandwich|pizza|cake|soup|tea)\b/, "food"],
    [/\b(?:microwave|oven|fridge|refrigerator)\b/, "appliance"],
    [/\b(?:book|notebook|paper|document|form)\b/, "document"],
    [/\b(?:locker|cabinet|box)\b/, "locker"],
  ];
  for (const [pattern, canonical] of canonicalizers) {
    if (pattern.test(cleaned)) return canonical;
  }
  return cleaned.split(/[,/]/)[0]?.trim() ?? "";
}

function propValue(scene: ScriptScene): string {
  return normalizedProp(pointField(scene, ["prop", "central_object", "prop_in_scene", "object"]));
}

function allSceneText(scenes: ScriptScene[]): string {
  return scenes.map((scene) => `${scene.narration ?? ""} ${scene.point ?? ""}`).join("\n").toLowerCase();
}

function isPlanningOrLatenessTopic(scenes: ScriptScene[]): boolean {
  return /\b(?:late|lateness|leaving early|leave early|planning fallacy|schedule|estimate|buffer|clock|timer|keys?|traffic|route|calendar|morning|spare|door)\b/.test(allSceneText(scenes));
}

function repeatedPhraseFailure(scene: ScriptScene): string | null {
  const narration = scene.narration ?? "";
  const phrases = narration
    .split(/[.!?;,]+/)
    .map((part) => part.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
  const counts = new Map<string, number>();
  for (const phrase of phrases) {
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    if ((counts.get(phrase) ?? 0) >= 3 && wordCount(phrase) <= 4) {
      return `scene ${scene.scene_index} repeats "${phrase}" three times in one line`;
    }
  }
  return null;
}

function roboticDialogueFailures(scenes: ScriptScene[]): string[] {
  const failures: string[] = [];
  for (const scene of scenes) {
    const narration = scene.narration ?? "";
    const repeated = repeatedPhraseFailure(scene);
    if (repeated) failures.push(repeated);
    if (TRAILING_ELLIPSIS_PATTERN.test(narration)) {
      failures.push(`scene ${scene.scene_index} ends with unresolved ellipsis`);
    }
    if (DEFINITIONAL_DIALOGUE_PATTERN.test(narration)) {
      failures.push(`scene ${scene.scene_index} uses definition/explainer phrasing`);
    }
  }
  return failures;
}

function validateDialogueScript(payload: unknown, def: AgentDef): string[] {
  const contentScenes = scenesFromPayload(payload)
    .filter((scene) => !scene.is_outro)
    .sort((a, b) => a.scene_index - b.scene_index);
  if (contentScenes.length === 0) return [];

  const errors: string[] = [];
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

  const roboticFailures = roboticDialogueFailures(contentScenes);
  if (roboticFailures.length > 0) {
    failures.push(
      `robotic dialogue patterns: ${roboticFailures.slice(0, 6).join("; ")}. `
      + `Rewrite with ordinary spoken responses, complete thoughts, and no repeated incantations.`,
    );
  }

  if (failures.length > 0) {
    errors.push(
      `${def.name}@${def.version ?? "1"} natural dialogue gate failed: ${failures.join("; ")}. `
      + `Rewrite as short, human, situational dialogue, not textbook/explainer speech.`,
    );
  }

  if (isPlanningOrLatenessTopic(contentScenes)) {
    const phoneScenes = contentScenes.filter((scene) => propValue(scene) === "phone");
    if (phoneScenes.length > 0) {
      errors.push(
        `${def.name}@${def.version ?? "1"} topic prop gate failed: planning/lateness scenes `
        + `${phoneScenes.map((s) => s.scene_index).join(", ")} use phone as the central prop. `
        + `Use clock, keys, calendar, route-map, door, coffee, or shoes unless the story is specifically about a phone.`,
      );
    }
  }

  return errors;
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
