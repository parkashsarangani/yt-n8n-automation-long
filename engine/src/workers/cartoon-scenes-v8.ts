import type { WorkerDef, WorkerOutput } from "../runner.ts";
import { makeCartoonSceneCompilerWorker as makeBaseCartoonSceneCompilerWorker } from "./cartoon-scenes.ts";

interface ScriptScene {
  scene_index: number;
  narration: string;
  point?: string;
  is_outro?: boolean;
}

interface PlanScene {
  scene_index: number;
  primary_prop?: string;
  prop_state?: string;
  prop_motion?: string;
  foreground_action?: string;
}

interface CompiledEntry {
  scene_index: number;
  source: "template";
  template_category: "cartoon";
  template_data: string;
}

interface ForegroundPropSpec {
  type: string;
  state: string;
  motion: string;
  anchor: string;
  label: string;
}

const WORDS_PER_SECOND = 2.6;
const ACTION_QUALITY_SCRIPT_VERSION = 5;
const LONG_EPISODE_SECONDS = 120;
const MIN_LONG_PROP_STATES = 5;
const MIN_LONG_CUTAWAYS = 3;

function dialogueWriterVersion(scriptArtifact: unknown): number {
  const producedBy = (scriptArtifact as { produced_by?: { transformation?: unknown; version?: unknown } }).produced_by;
  if (producedBy?.transformation !== "dialogue_script_writer" || typeof producedBy.version !== "string") return 0;
  return Number.parseInt(producedBy.version, 10) || 0;
}

function shouldApplyV8Gate(scriptArtifact: unknown): boolean {
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
    [/\b(?:kettle|tea\s+kettle)\b/, "kettle"],
    [/\b(?:bill|invoice|receipt|statement)\b/, "bill"],
    [/\b(?:letter|envelope|mail)\b/, "letter"],
    [/\b(?:door|doorway)\b/, "door"],
    [/\b(?:tool|hammer|wrench|screwdriver|drill)\b/, "tool"],
    [/\b(?:vehicle|car|bus|train|bike|bicycle|scooter|airplane|plane)\b/, "vehicle"],
    [/\b(?:food|meal|snack|banana|sandwich|pizza|cake|soup|coffee|tea)\b/, "food"],
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

function actionValue(scene: ScriptScene): string {
  return pointField(scene, ["action", "observable_action", "visible_action"]);
}

function propValue(scene: ScriptScene): string {
  return normalizedProp(pointField(scene, ["prop", "central_object", "prop_in_scene", "object"]));
}

function planPropValue(plan?: PlanScene): string {
  return normalizedProp(String(plan?.primary_prop ?? ""));
}

function functionValue(scene: ScriptScene): string {
  return pointField(scene, ["function", "story_function", "tag"]);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function thirdForIndex(index: number, total: number): "opening" | "middle" | "final" {
  if (index < total / 3) return "opening";
  if (index < (total * 2) / 3) return "middle";
  return "final";
}

function centralPropCoverage(scenes: ScriptScene[]): { prop: string; thirds: Set<string>; count: number } {
  const counts = new Map<string, number>();
  for (const scene of scenes) {
    const prop = propValue(scene);
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
  const thirds = new Set<string>();
  if (prop) {
    scenes.forEach((scene, index) => {
      if (propValue(scene) === prop) thirds.add(thirdForIndex(index, scenes.length));
    });
  }
  return { prop, thirds, count };
}

function inferPropState(prop: string, scene: ScriptScene, plan?: PlanScene): string {
  const planned = String(plan?.prop_state ?? "").trim().toLowerCase();
  if (planned && planned !== "none") return planned;
  const text = `${scene.point ?? ""} ${scene.narration}`.toLowerCase();
  if (prop === "phone") {
    if (/face\s*down/.test(text)) return "face-down";
    if (/across|away|slide|move the cue/.test(text)) return "across-room";
    if (/notification|badge|lights? up|glow/.test(text)) return "notification-badge";
    if (/unlock|already unlocked|holding/.test(text)) return "phone-unlocked";
    if (/thumb|reach/.test(text)) return "thumb-hover";
    return "phone-visible";
  }
  if (/open|opened|opens/.test(text)) return "open";
  if (/closed|shut|face down/.test(text)) return "closed";
  if (/replacement|instead|kettle wins|changed behavior/.test(text)) return `${prop}-replacement`;
  return `${prop}-visible`;
}

function inferPropMotion(propState: string, scene: ScriptScene, plan?: PlanScene): string {
  const planned = String(plan?.prop_motion ?? "").trim().toLowerCase();
  if (planned && planned !== "none") return planned;
  const text = `${scene.point ?? ""} ${scene.narration}`.toLowerCase();
  if (/tremble|shake|shaking/.test(text)) return "tremble";
  if (/slide|across|away|move the cue/.test(text)) return "slide-away";
  if (/thumb|reach/.test(text) || propState === "thumb-hover") return "thumb-hover";
  if (/glow|lights? up|notification/.test(text)) return "pulse";
  if (/open/.test(text)) return "open";
  return "none";
}

function anchorFor(scene: ScriptScene): string {
  const text = `${scene.point ?? ""} ${scene.narration}`.toLowerCase();
  if (/hand|holding|thumb|reach/.test(text)) return "hand";
  if (/table|desk|counter/.test(text)) return "table";
  if (/across|away|room|kitchen/.test(text)) return "background";
  return "foreground";
}

function foregroundPropFor(scene: ScriptScene, plan?: PlanScene): ForegroundPropSpec | null {
  const prop = planPropValue(plan) || propValue(scene);
  if (!isMeaningfulProp(prop)) return null;
  const state = inferPropState(prop, scene, plan);
  return {
    type: prop,
    state,
    motion: inferPropMotion(state, scene, plan),
    anchor: anchorFor(scene),
    label: state.replace(/[-_]+/g, " ").toUpperCase(),
  };
}

function visualEventType(compiled: Record<string, unknown>): string {
  const raw = compiled.visualEvent;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "none";
  const type = (raw as Record<string, unknown>).type;
  return typeof type === "string" ? type : "none";
}

function compiledForegroundProp(compiled: Record<string, unknown>): ForegroundPropSpec | null {
  const rawEvent = compiled.visualEvent;
  if (rawEvent && typeof rawEvent === "object" && !Array.isArray(rawEvent)) {
    const rawProp = (rawEvent as Record<string, unknown>).foregroundProp;
    if (rawProp && typeof rawProp === "object" && !Array.isArray(rawProp)) {
      const type = normalizedProp(String((rawProp as Record<string, unknown>).type ?? ""));
      if (isMeaningfulProp(type)) return { ...(rawProp as ForegroundPropSpec), type };
    }
  }
  return null;
}

function attachForegroundProp(compiled: Record<string, unknown>, prop: ForegroundPropSpec | null): Record<string, unknown> {
  if (!prop) return compiled;
  const rawEvent = compiled.visualEvent;
  const visualEvent: Record<string, unknown> = rawEvent && typeof rawEvent === "object" && !Array.isArray(rawEvent)
    ? { ...(rawEvent as Record<string, unknown>) }
    : { type: "none" };
  if (prop.type === "phone" && visualEvent.type === "none") visualEvent.type = "screen-change";
  if (!visualEvent.label && prop.label) visualEvent.label = prop.label;
  visualEvent.foregroundProp = prop;
  return { ...compiled, visualEvent };
}

function applyForegroundProps(entries: CompiledEntry[], scripts: ScriptScene[], plans: PlanScene[]): CompiledEntry[] {
  const scriptByIndex = new Map(scripts.map((scene) => [scene.scene_index, scene]));
  const planByIndex = new Map(plans.map((scene) => [scene.scene_index, scene]));
  return entries.map((entry) => {
    const script = scriptByIndex.get(entry.scene_index);
    if (!script) return entry;
    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const prop = foregroundPropFor(script, planByIndex.get(entry.scene_index));
    return { ...entry, template_data: JSON.stringify(attachForegroundProp(compiled, prop)) };
  });
}

function assertForegroundCoverage(scripts: ScriptScene[], entries: CompiledEntry[]): void {
  const ordered = scripts.filter((scene) => !scene.is_outro).slice().sort((a, b) => a.scene_index - b.scene_index);
  const central = centralPropCoverage(ordered);
  if (!central.prop) return;
  const entriesByIndex = new Map(entries.map((entry) => [entry.scene_index, entry]));
  const coveredThirds = new Set<string>();
  ordered.forEach((scene, index) => {
    const entry = entriesByIndex.get(scene.scene_index);
    if (!entry) return;
    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const prop = compiledForegroundProp(compiled);
    if (prop?.type === central.prop) coveredThirds.add(thirdForIndex(index, ordered.length));
  });
  for (const required of ["opening", "middle", "final"]) {
    if (!coveredThirds.has(required)) {
      throw new Error(
        `cartoon_scene_compiler@8 foreground prop gate failed: central object "${central.prop}" must render as a foreground prop in opening, middle, and payoff/final third; missing ${required}`,
      );
    }
  }
}

function assertRuntimeDensity(scripts: ScriptScene[], entries: CompiledEntry[]): void {
  const ordered = scripts.filter((scene) => !scene.is_outro).slice().sort((a, b) => a.scene_index - b.scene_index);
  const estimatedDurationSec = ordered.reduce((sum, scene) => sum + wordCount(scene.narration), 0) / WORDS_PER_SECOND;
  if (estimatedDurationSec <= LONG_EPISODE_SECONDS) return;

  const propStates = new Set<string>();
  let cutaways = 0;
  let visualEvents = 0;
  for (const entry of entries) {
    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const eventType = visualEventType(compiled);
    if (eventType !== "none") visualEvents += 1;
    if (["metaphor-cutaway", "thought-bubble", "callback-card"].includes(eventType)) cutaways += 1;
    const prop = compiledForegroundProp(compiled);
    if (prop) propStates.add(`${prop.type}:${prop.state}`);
  }
  const minVisualEvents = Math.ceil(entries.length * 0.35);
  if (propStates.size < MIN_LONG_PROP_STATES || cutaways < MIN_LONG_CUTAWAYS || visualEvents < minVisualEvents) {
    throw new Error(
      `cartoon_scene_compiler@8 runtime density gate failed: estimated ${estimatedDurationSec.toFixed(1)}s exceeds ${LONG_EPISODE_SECONDS}s; long episodes require at least ${MIN_LONG_PROP_STATES} foreground prop state changes, ${MIN_LONG_CUTAWAYS} cutaway/callback/mechanism scenes, and ${minVisualEvents} visual events (${propStates.size} prop states, ${cutaways} cutaways, ${visualEvents} visual events found).`,
    );
  }
}

export function makeCartoonSceneCompilerWorker(): WorkerDef {
  const base = makeBaseCartoonSceneCompilerWorker();
  return {
    ...base,
    version: "8",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const out = await base.execute(inputs, ctx);
      if (!shouldApplyV8Gate(inputs["script"])) return out;
      const scriptScenes = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
      const planScenes = (inputs["plan"]!.payload as { scenes: PlanScene[] }).scenes;
      const payload = out.payload as { scenes: CompiledEntry[]; degraded_count?: number };
      const entries = applyForegroundProps(payload.scenes, scriptScenes, planScenes);
      assertForegroundCoverage(scriptScenes, entries);
      assertRuntimeDensity(scriptScenes, entries);
      return { ...out, payload: { ...payload, scenes: entries } };
    },
  };
}
