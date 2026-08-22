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
const NATURAL_DIALOGUE_SCRIPT_VERSION = 6;
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

function shouldApplyNaturalDialogueGate(scriptArtifact: unknown): boolean {
  return dialogueWriterVersion(scriptArtifact) >= NATURAL_DIALOGUE_SCRIPT_VERSION;
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

function allSceneText(scenes: ScriptScene[]): string {
  return scenes.map((scene) => `${scene.narration} ${scene.point ?? ""}`).join("\n").toLowerCase();
}

function isPlanningOrLatenessTopic(scenes: ScriptScene[]): boolean {
  return /\b(?:late|lateness|leaving early|leave early|planning fallacy|plan|planned|schedule|estimate|buffer|clock|timer|keys?|traffic|route|calendar|morning|minutes?|spare|door)\b/.test(allSceneText(scenes));
}

function topicPropForScene(scene: ScriptScene, allScenes: ScriptScene[]): string {
  if (!isPlanningOrLatenessTopic(allScenes)) return "";
  const text = `${scene.narration} ${scene.point ?? ""}`.toLowerCase();
  if (/\b(?:keys?|keyring|pocket)\b/.test(text)) return "keys";
  if (/\b(?:traffic|route|map|gps|drive|commute)\b/.test(text)) return "route-map";
  if (/\b(?:calendar|schedule|planner|estimate|buffer|half again|add half|spare|minutes?)\b/.test(text)) return "calendar";
  if (/\b(?:door|leave|leaving|left|out the door)\b/.test(text)) return "door";
  if (/\b(?:coffee|cup|mug)\b/.test(text)) return "coffee";
  if (/\b(?:shoes?|sneakers?|boots?)\b/.test(text)) return "shoes";
  return "clock";
}

function inferPropState(prop: string, scene: ScriptScene, plan?: PlanScene): string {
  const planned = String(plan?.prop_state ?? "").trim().toLowerCase();
  if (planned && planned !== "none" && !(prop !== "phone" && /phone/.test(planned))) return planned;
  const text = `${scene.point ?? ""} ${scene.narration}`.toLowerCase();
  if (prop === "phone") {
    if (/face\s*down/.test(text)) return "face-down";
    if (/across|away|slide|move the cue/.test(text)) return "across-room";
    if (/notification|badge|lights? up|glow/.test(text)) return "notification-badge";
    if (/unlock|already unlocked|holding/.test(text)) return "phone-unlocked";
    if (/thumb|reach/.test(text)) return "thumb-hover";
    return "phone-visible";
  }
  if (prop === "clock") {
    if (/late|running late|still late/.test(text)) return "running-late";
    if (/fantasy|perfect|best-case/.test(text)) return "fantasy-schedule";
    if (/jump|lost|vanish|gone/.test(text)) return "time-jump";
    if (/buffer|half again|spare|early/.test(text)) return "buffer-added";
    return "clock-visible";
  }
  if (prop === "keys") {
    if (/missing|where|search|pocket/.test(text)) return "missing-keys";
    if (/found|grab/.test(text)) return "keys-found";
    return "keys-visible";
  }
  if (prop === "route-map") {
    if (/traffic|red|delay/.test(text)) return "traffic-delay";
    if (/clear|open|green/.test(text)) return "route-clear";
    return "route-visible";
  }
  if (prop === "calendar") {
    if (/buffer|half again|spare/.test(text)) return "buffer-added";
    if (/fantasy|perfect|best-case/.test(text)) return "fantasy-schedule";
    return "schedule-visible";
  }
  if (prop === "door") {
    if (/leave|leaving|out/.test(text)) return "leaving";
    if (/open|opened|opens/.test(text)) return "open";
    return "closed";
  }
  if (/open|opened|opens/.test(text)) return "open";
  if (/closed|shut|face down/.test(text)) return "closed";
  if (/replacement|instead|kettle wins|changed behavior/.test(text)) return `${prop}-replacement`;
  return `${prop}-visible`;
}

function inferPropMotion(propState: string, scene: ScriptScene, plan?: PlanScene): string {
  const planned = String(plan?.prop_motion ?? "").trim().toLowerCase();
  if (planned && planned !== "none" && !(propState !== "phone-visible" && /thumb/.test(planned))) return planned;
  const text = `${scene.point ?? ""} ${scene.narration}`.toLowerCase();
  if (/tremble|shake|shaking/.test(text)) return "tremble";
  if (/slide|across|away|move the cue/.test(text)) return "slide-away";
  if (/thumb|reach/.test(text) || propState === "thumb-hover") return "thumb-hover";
  if (/glow|lights? up|notification|late|traffic|time|clock/.test(text)) return "pulse";
  if (/open/.test(text)) return "open";
  return "none";
}

function anchorFor(prop: string, scene: ScriptScene): string {
  const text = `${scene.point ?? ""} ${scene.narration}`.toLowerCase();
  if (prop === "clock" || prop === "calendar") return "background";
  if (prop === "keys" || prop === "coffee" || prop === "shoes") return "table";
  if (prop === "route-map") return "foreground";
  if (/hand|holding|thumb|reach/.test(text)) return "hand";
  if (/table|desk|counter/.test(text)) return "table";
  if (/across|away|room|kitchen/.test(text)) return "background";
  return "foreground";
}

function foregroundPropFor(scene: ScriptScene, allScenes: ScriptScene[], plan?: PlanScene): ForegroundPropSpec | null {
  const topicProp = topicPropForScene(scene, allScenes);
  const scriptProp = propValue(scene);
  const plannedProp = planPropValue(plan);
  const prop = topicProp || (isMeaningfulProp(scriptProp) ? scriptProp : plannedProp);
  if (!isMeaningfulProp(prop)) return null;
  const state = inferPropState(prop, scene, plan);
  return {
    type: prop,
    state,
    motion: inferPropMotion(state, scene, plan),
    anchor: anchorFor(prop, scene),
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
  if ((prop.type === "phone" || prop.type === "clock" || prop.type === "calendar" || prop.type === "route-map") && visualEvent.type === "none") {
    visualEvent.type = "screen-change";
  }
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
    const prop = foregroundPropFor(script, scripts, planByIndex.get(entry.scene_index));
    return { ...entry, template_data: JSON.stringify(attachForegroundProp(compiled, prop)) };
  });
}

function assertForegroundCoverage(scripts: ScriptScene[], entries: CompiledEntry[]): void {
  const ordered = scripts.filter((scene) => !scene.is_outro).slice().sort((a, b) => a.scene_index - b.scene_index);
  const central = isPlanningOrLatenessTopic(ordered)
    ? { prop: "clock", thirds: new Set<string>(["opening", "middle", "final"]), count: 3 }
    : centralPropCoverage(ordered);
  if (!central.prop) return;
  const entriesByIndex = new Map(entries.map((entry) => [entry.scene_index, entry]));
  const coveredThirds = new Set<string>();
  ordered.forEach((scene, index) => {
    const entry = entriesByIndex.get(scene.scene_index);
    if (!entry) return;
    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const prop = compiledForegroundProp(compiled);
    if (prop?.type === central.prop || (central.prop === "clock" && ["clock", "keys", "route-map", "calendar", "door", "coffee", "shoes"].includes(prop?.type ?? ""))) {
      coveredThirds.add(thirdForIndex(index, ordered.length));
    }
  });
  for (const required of ["opening", "middle", "final"]) {
    if (!coveredThirds.has(required)) {
      throw new Error(
        `cartoon_scene_compiler@9 foreground prop gate failed: central topic object "${central.prop}" must render as a topic-correct foreground prop in opening, middle, and payoff/final third; missing ${required}`,
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
      `cartoon_scene_compiler@9 runtime density gate failed: estimated ${estimatedDurationSec.toFixed(1)}s exceeds ${LONG_EPISODE_SECONDS}s; long episodes require at least ${MIN_LONG_PROP_STATES} foreground prop state changes, ${MIN_LONG_CUTAWAYS} cutaway/callback/mechanism scenes, and ${minVisualEvents} visual events (${propStates.size} prop states, ${cutaways} cutaways, ${visualEvents} visual events found).`,
    );
  }
}

function assertNaturalDialogue(scripts: ScriptScene[]): void {
  const ordered = scripts.filter((scene) => !scene.is_outro).slice().sort((a, b) => a.scene_index - b.scene_index);
  if (ordered.length === 0) return;

  const lines = ordered.map((scene) => scene.narration.trim()).filter(Boolean);
  const counts = lines.map(wordCount);
  const averageWords = counts.reduce((sum, count) => sum + count, 0) / Math.max(1, counts.length);
  const shortLines = counts.filter((count) => count <= 10).length;
  const longLines = ordered.filter((scene) => wordCount(scene.narration) > 18);
  const fragmentLines = ordered.filter((scene) => wordCount(scene.narration) <= 4);
  const humanMomentLines = ordered.filter((scene) => /\b(?:i|i'm|im|i’ll|i'd|me|my|you|you're|youre|your|we|we're|were|wait|nope|ugh|okay|still|again|late|where|why|how|fine|hate|rude|keys?)\b|(?:n't|'m|'re|'ve|'ll|'d)/i.test(scene.narration));
  const lecturePhrases = ordered.filter((scene) => /\b(?:that's fascinating|that is fascinating|interesting|exactly\.|this means|in other words|research shows|studies show|the reason is|what happens is|the key is|the concept is|as a result)\b/i.test(scene.narration));
  const definitionLines = ordered.filter((scene) => /^\s*(?:the\s+)?(?:planning fallacy|dopamine|cognitive bias|the brain|your brain|human brain|reward system)\s+(?:is|means|refers to|causes|explains)\b/i.test(scene.narration));
  const conceptLectureLines = ordered.filter((scene) => /\b(?:planning fallacy|cognitive bias|dopamine|reward system|human brain)\b/i.test(scene.narration) && wordCount(scene.narration) > 12);

  const failures: string[] = [];
  if (averageWords > 12.5) failures.push(`average line length ${averageWords.toFixed(1)} words exceeds 12.5`);
  if (shortLines < Math.ceil(lines.length * 0.5)) failures.push(`${shortLines}/${lines.length} lines are 10 words or fewer; at least half must be short`);
  if (longLines.length > Math.max(1, Math.floor(lines.length * 0.2))) failures.push(`too many long lines: ${longLines.map((s) => s.scene_index).join(", ")}`);
  if (fragmentLines.length < 1) failures.push("needs at least one short human fragment such as Wait, Nope, Ugh, or Still late");
  if (humanMomentLines.length < Math.ceil(lines.length * 0.45)) failures.push("too few lines sound like someone inside the situation rather than explaining it");
  if (lecturePhrases.length > 0) failures.push(`lecture/generic reaction phrases in scenes ${lecturePhrases.map((s) => s.scene_index).join(", ")}`);
  if (definitionLines.length > 0) failures.push(`definition-style concept lines in scenes ${definitionLines.map((s) => s.scene_index).join(", ")}`);
  if (conceptLectureLines.length > 1) failures.push(`too many long concept-label lines in scenes ${conceptLectureLines.map((s) => s.scene_index).join(", ")}`);

  if (failures.length > 0) {
    throw new Error(`dialogue_script_writer@6 natural dialogue gate failed: ${failures.join("; ")}. Rewrite as short, human, situational dialogue, not textbook/explainer speech.`);
  }
}

function assertTopicPropSemantics(scripts: ScriptScene[]): void {
  const ordered = scripts.filter((scene) => !scene.is_outro).slice().sort((a, b) => a.scene_index - b.scene_index);
  if (!isPlanningOrLatenessTopic(ordered)) return;
  const phoneScenes = ordered.filter((scene) => propValue(scene) === "phone");
  if (phoneScenes.length > 0) {
    throw new Error(
      `dialogue_script_writer@6 topic prop gate failed: planning/lateness scenes ${phoneScenes.map((s) => s.scene_index).join(", ")} use phone as the central prop. Use clock, keys, calendar, route-map, door, coffee, or shoes unless the story is specifically about a phone.`,
    );
  }
}

export function makeCartoonSceneCompilerWorker(): WorkerDef {
  const base = makeBaseCartoonSceneCompilerWorker();
  return {
    ...base,
    version: "9",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const out = await base.execute(inputs, ctx);
      if (!shouldApplyV8Gate(inputs["script"])) return out;
      const scriptScenes = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
      const planScenes = (inputs["plan"]!.payload as { scenes: PlanScene[] }).scenes;
      if (shouldApplyNaturalDialogueGate(inputs["script"])) {
        assertNaturalDialogue(scriptScenes);
        assertTopicPropSemantics(scriptScenes);
      }
      const payload = out.payload as { scenes: CompiledEntry[]; degraded_count?: number };
      const entries = applyForegroundProps(payload.scenes, scriptScenes, planScenes);
      assertForegroundCoverage(scriptScenes, entries);
      assertRuntimeDensity(scriptScenes, entries);
      return { ...out, payload: { ...payload, scenes: entries } };
    },
  };
}
