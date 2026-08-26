import type { WorkerDef, WorkerOutput } from "../runner.ts";
import { makeCartoonSceneCompilerWorker as makeV9CartoonSceneCompilerWorker } from "./cartoon-scenes-v9.ts";

interface ScriptScene {
  scene_index: number;
  narration: string;
  point?: string;
  is_outro?: boolean;
}

interface PlanScene {
  scene_index: number;
  primary_prop?: string;
}

const ACTION_QUALITY_SCRIPT_VERSION = 5;
const PLANNING_TOPIC_PROPS = new Set(["clock", "keys", "calendar", "route-map", "door", "coffee", "shoes"]);

function dialogueWriterVersion(scriptArtifact: unknown): number {
  const producedBy = (scriptArtifact as { produced_by?: { transformation?: unknown; version?: unknown } }).produced_by;
  if (producedBy?.transformation !== "dialogue_script_writer" || typeof producedBy.version !== "string") return 0;
  return Number.parseInt(producedBy.version, 10) || 0;
}

function shouldApplyActionGate(scriptArtifact: unknown): boolean {
  return dialogueWriterVersion(scriptArtifact) >= ACTION_QUALITY_SCRIPT_VERSION;
}

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
    [/\b(?:calendar|schedule|planner|estimate|buffer)\b/, "calendar"],
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

function isMeaningfulProp(value: string): boolean {
  const prop = normalizedProp(value);
  return prop.length > 1 && !/^(none|n\/a|na|null|room|scene|character|characters|host|buddy)$/i.test(prop);
}

// The script's freely-typed prop= mention and the visual planner's freely-typed
// primary_prop are independently generated and only fall into the same
// canonical bucket above for a closed list of habit-vignette objects (phone,
// clock, door, ...). A comprehension-genre episode's demonstration object
// ("scrapbook cards" in the script vs "scrapbook" in the plan -- same object,
// same word, just singular/plural) has no bucket to land in, so exact
// equality after normalization fails even when the plan renders the object in
// every single scene. Whole-word substring containment catches this without
// requiring an ever-growing canonicalizer list for arbitrary future topics.
function propsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return new RegExp(`\\b${shorter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(longer);
}

function scriptProp(scene: ScriptScene): string {
  return normalizedProp(pointField(scene, ["prop", "central_object", "prop_in_scene", "object"]));
}

function plannedRawProp(scene?: PlanScene): string {
  return String(scene?.primary_prop ?? "").trim();
}

function plannedProp(scene?: PlanScene): string {
  return normalizedProp(plannedRawProp(scene));
}

function thirdForIndex(index: number, total: number): "opening" | "middle" | "final" {
  if (index < total / 3) return "opening";
  if (index < (total * 2) / 3) return "middle";
  return "final";
}

function centralProp(scenes: ScriptScene[]): string {
  const counts = new Map<string, number>();
  for (const scene of scenes) {
    const prop = scriptProp(scene);
    if (!isMeaningfulProp(prop)) continue;
    counts.set(prop, (counts.get(prop) ?? 0) + 1);
  }
  let prop = "";
  let count = 0;
  for (const [candidate, candidateCount] of counts) {
    if (candidateCount > count) {
      prop = candidate;
      count = candidateCount;
    }
  }
  return prop;
}

function assertNonPlanningPlanOwnedForegroundCoverage(scripts: ScriptScene[], plans: PlanScene[]): void {
  const ordered = scripts.filter((scene) => !scene.is_outro).slice().sort((a, b) => a.scene_index - b.scene_index);
  const prop = centralProp(ordered);
  if (!isMeaningfulProp(prop) || PLANNING_TOPIC_PROPS.has(prop)) return;

  const planByIndex = new Map(plans.map((scene) => [scene.scene_index, scene]));
  const coveredThirds = new Set<string>();
  ordered.forEach((scene, index) => {
    const plan = planByIndex.get(scene.scene_index);
    const planHasPrimaryPropField = plannedRawProp(plan).length > 0;
    const renderedProp = planHasPrimaryPropField ? plannedProp(plan) : scriptProp(scene);
    if (propsMatch(renderedProp, prop)) coveredThirds.add(thirdForIndex(index, ordered.length));
  });

  // Require the central object in at least two of the three thirds, not all
  // three -- a "confusion tour" opening that samples other objects before
  // settling on the real demonstration object is legitimate, especially for
  // comprehension-structure scripts (matches the identical relaxation applied
  // to the writer-stage central_object_usage gate in agent-validators.ts).
  if (coveredThirds.size < 2) {
    throw new Error(
      `cartoon_scene_compiler@10 foreground prop gate failed: central object "${prop}" must render as a foreground prop in at least two of the opening, middle, and payoff/final thirds; only found ${[...coveredThirds].join(", ") || "none"}`,
    );
  }
}

export function makeCartoonSceneCompilerWorker(): WorkerDef {
  const v9 = makeV9CartoonSceneCompilerWorker();
  return {
    ...v9,
    version: "10",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const out = await v9.execute(inputs, ctx);
      if (!shouldApplyActionGate(inputs["script"])) return out;
      const scriptScenes = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
      const planScenes = (inputs["plan"]!.payload as { scenes: PlanScene[] }).scenes;
      assertNonPlanningPlanOwnedForegroundCoverage(scriptScenes, planScenes);
      return out;
    },
  };
}
