import type { WorkerDef, WorkerOutput } from "../runner.ts";
import { makeCartoonSceneCompilerWorker as makeV11CartoonSceneCompilerWorker } from "./cartoon-scenes-v11.ts";

interface ScriptScene {
  scene_index: number;
  narration: string;
  speaker?: string;
  is_outro?: boolean;
}

interface CompiledEntry {
  scene_index: number;
  source: "template";
  template_category: "cartoon";
  template_data: string;
}

interface CreativeForegroundProp {
  type: string;
  state: string;
  motion: string;
  anchor: string;
  action: string;
}

interface CreativeBlocking {
  speaker_position: string;
  listener_position: string;
  prop_position: string;
  power_shift: string;
}

interface CreativeMetaphor {
  type: string;
  label: string;
  emotional_beat: string;
}

interface CreativeScene {
  scene_index: number;
  scene_function: string;
  energy_beat: string;
  foreground_prop: CreativeForegroundProp;
  blocking: CreativeBlocking;
  metaphor: CreativeMetaphor;
  callback_role: "none" | "seed" | "escalation" | "payoff";
  performance_note: string;
}

interface CreativeDirection {
  character_roles: Array<{ character_id: string; comic_role: string; voice_markers: string[]; reaction_pattern: string }>;
  callback: { seed: string; escalation: string; payoff: string };
  scenes: CreativeScene[];
}

const GENERIC_LABELS = new Set([
  "", "callback", "new slide", "screen change", "what your brain sees", "what if", "lesson",
  "the point", "important", "remember this", "big idea", "concept", "metaphor", "visual",
]);
const GENERIC_NOTE_VALUES = new Set([
  "", "make it funny", "keep it interesting", "be expressive", "act natural",
  "say it clearly", "generic", "same energy", "explain this",
]);
const GENERIC_POWER_VALUES = new Set([
  "", "same", "unchanged", "no change", "continues", "explains", "talks",
  "speaks", "neutral", "none",
]);
const ABSTRACT_EVENT_TYPES = new Set(["metaphor-cutaway", "thought-bubble", "reaction-pop", "screen-change"]);

function clean(value: unknown, max = 160): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function normalized(value: unknown): string {
  return clean(value, 200).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isGenericExact(value: unknown, genericValues: Set<string>): boolean {
  return genericValues.has(normalized(value));
}

function contentCreativeScenes(creative: CreativeDirection): CreativeScene[] {
  return [...creative.scenes].sort((a, b) => a.scene_index - b.scene_index);
}

function contentScriptScenes(scriptScenes: ScriptScene[]): ScriptScene[] {
  return scriptScenes.filter((scene) => !scene.is_outro).sort((a, b) => a.scene_index - b.scene_index);
}

function sceneOrder(creative: CreativeDirection, role: CreativeScene["callback_role"]): number | null {
  const scene = contentCreativeScenes(creative).find((entry) => entry.callback_role === role);
  return scene ? scene.scene_index : null;
}

function isGenericLabel(value: string): boolean {
  const label = normalized(value);
  return GENERIC_LABELS.has(label) || /^scene \d+$/.test(label) || /^beat \d+$/.test(label);
}

function hasTripleRepeat(values: string[]): boolean {
  for (let i = 2; i < values.length; i++) {
    if (values[i] && values[i] === values[i - 1] && values[i] === values[i - 2]) return true;
  }
  return false;
}

function uniqueCount(values: string[]): number {
  return new Set(values.filter(Boolean)).size;
}

function assertCallbackArc(creative: CreativeDirection): void {
  const seed = clean(creative.callback?.seed, 140);
  const escalation = clean(creative.callback?.escalation, 140);
  const payoff = clean(creative.callback?.payoff, 140);
  if (!seed || !escalation || !payoff) {
    throw new Error("cartoon_creative_director@2 callback gate failed: seed, escalation, and payoff are required");
  }
  if (uniqueCount([normalized(seed), normalized(escalation), normalized(payoff)]) < 3) {
    throw new Error("cartoon_creative_director@2 callback gate failed: seed, escalation, and payoff must be distinct beats");
  }

  const scenes = contentCreativeScenes(creative);
  const seedScene = sceneOrder(creative, "seed");
  const payoffScene = sceneOrder(creative, "payoff");
  const escalationScene = sceneOrder(creative, "escalation");
  if (seedScene === null || payoffScene === null || (scenes.length >= 3 && escalationScene === null)) {
    throw new Error("cartoon_creative_director@2 callback gate failed: scenes must mark seed, escalation, and payoff roles");
  }
  if (seedScene !== null && escalationScene !== null && seedScene >= escalationScene) {
    throw new Error("cartoon_creative_director@2 callback gate failed: callback seed must appear before escalation");
  }
  if (escalationScene !== null && payoffScene !== null && escalationScene >= payoffScene) {
    throw new Error("cartoon_creative_director@2 callback gate failed: callback escalation must appear before payoff");
  }
  // Only enforce a specific label when the scene actually uses a metaphor
  // overlay. metaphor.type="none" is a deliberate, encouraged choice in the
  // active creative_direction prompt ("use metaphor only when it adds a real
  // visual beat") -- a payoff carried entirely through concrete foreground_prop
  // action and performance_note (a physical/behavioral closure, not a lesson
  // restatement) doesn't need a callback-card to be a real payoff.
  const payoffCreativeScene = scenes.find((scene) => scene.callback_role === "payoff");
  if (
    payoffCreativeScene &&
    payoffCreativeScene.metaphor.type !== "none" &&
    payoffCreativeScene.metaphor.type !== "callback-card" &&
    isGenericLabel(payoffCreativeScene.metaphor.label)
  ) {
    throw new Error("cartoon_creative_director@2 callback gate failed: payoff needs a specific callback card or payoff label");
  }
}

function assertMetaphorSpecificity(creative: CreativeDirection): void {
  const scenes = contentCreativeScenes(creative);
  const nonNone = scenes.filter((scene) => clean(scene.metaphor?.type, 40) !== "none");
  const minCount = scenes.length >= 6 ? 2 : scenes.length >= 3 ? 1 : 0;
  if (nonNone.length < minCount) {
    throw new Error(`cartoon_creative_director@2 metaphor gate failed: expected at least ${minCount} specific visual metaphor/callback beat(s)`);
  }
  for (const scene of nonNone) {
    const label = clean(scene.metaphor.label, 80);
    const emotionalBeat = clean(scene.metaphor.emotional_beat, 120);
    if (isGenericLabel(label)) {
      throw new Error(`cartoon_creative_director@2 metaphor gate failed: scene ${scene.scene_index} uses a generic metaphor label`);
    }
    if (!emotionalBeat || isGenericLabel(emotionalBeat)) {
      throw new Error(`cartoon_creative_director@2 metaphor gate failed: scene ${scene.scene_index} needs a specific emotional beat`);
    }
  }
  if (scenes.length >= 6 && !nonNone.some((scene) => ABSTRACT_EVENT_TYPES.has(clean(scene.metaphor.type, 40)))) {
    throw new Error("cartoon_creative_director@2 metaphor gate failed: longer episodes need at least one non-card metaphor or reaction visual");
  }
}

function assertRhythmVariety(creative: CreativeDirection): void {
  // Product direction: storytelling and concept explanation over cinematic
  // shot/rhythm variety. Blocked production run_a1838b5d (comprehension
  // genre): scenes 11-14 were all correctly labeled scene_function=visual_model
  // -- the script deliberately devotes several consecutive scenes to the
  // demonstration that makes the idea concrete ("do not rush it" in
  // dialogue_script_writer@10), and cartoon_creative_director correctly
  // reflected that. The old triple-repeat/four-distinct requirements assume
  // a fast-cutting entertainment pacing model and directly punish a script
  // for lingering on the one beat where comprehension actually happens.
  // Dropped those; kept the structural shape checks (opens on a hook, closes
  // on a payoff) since those are genuine comprehension requirements, not
  // visual ones.
  const scenes = contentCreativeScenes(creative);
  if (scenes.length === 0) return;
  const first = scenes[0]!;
  const last = scenes[scenes.length - 1]!;
  if (!/(?:hook|open|opening|problem|setup|seed)/.test(normalized(first.scene_function + " " + first.energy_beat + " " + first.callback_role))) {
    throw new Error("cartoon_creative_director@2 rhythm gate failed: first scene must function as a hook/opening problem/seed");
  }
  if (!/(?:payoff|resolution|resolve|callback|recap|confirm)/.test(normalized(last.scene_function + " " + last.energy_beat + " " + last.callback_role))) {
    throw new Error("cartoon_creative_director@2 rhythm gate failed: final scene must function as a payoff or resolution");
  }
}

function assertBlockingVariety(creative: CreativeDirection): void {
  // Same product-direction change as assertRhythmVariety above: dropped the
  // blocking-layout repetition/distinctness requirements (cinematic
  // staging variety), kept the per-scene requirement that power_shift is an
  // actual concrete sentence and not a generic placeholder -- that's a
  // content-quality floor, not a visual-variety quota.
  const scenes = contentCreativeScenes(creative);
  const powerShifts = scenes.map((scene) => clean(scene.blocking.power_shift, 120));
  for (const [index, powerShift] of powerShifts.entries()) {
    if (!powerShift || isGenericExact(powerShift, GENERIC_POWER_VALUES)) {
      throw new Error(`cartoon_creative_director@2 blocking gate failed: scene ${scenes[index]!.scene_index} needs a concrete power_shift`);
    }
  }
}

function assertPerformanceSpecificity(creative: CreativeDirection): void {
  const scenes = contentCreativeScenes(creative);
  const notes = scenes.map((scene) => clean(scene.performance_note, 180));
  for (const [index, note] of notes.entries()) {
    if (note.length < 12 || isGenericExact(note, GENERIC_NOTE_VALUES)) {
      throw new Error(`cartoon_creative_director@2 performance gate failed: scene ${scenes[index]!.scene_index} needs a concrete performance note`);
    }
  }
  if (scenes.length >= 5 && uniqueCount(notes.map(normalized)) < Math.ceil(scenes.length * 0.75)) {
    throw new Error("cartoon_creative_director@2 performance gate failed: performance notes are too repetitive");
  }
}

function assertPropStateVariety(creative: CreativeDirection): void {
  const scenes = contentCreativeScenes(creative);
  const byType = new Map<string, CreativeScene[]>();
  for (const scene of scenes) {
    const type = normalized(scene.foreground_prop.type);
    if (!type || type === "none") continue;
    byType.set(type, [...(byType.get(type) ?? []), scene]);
  }
  for (const [type, entries] of byType) {
    if (entries.length < 5) continue;
    const states = entries.map((scene) => normalized(scene.foreground_prop.state));
    const motions = entries.map((scene) => normalized(scene.foreground_prop.motion));
    if (uniqueCount(states) < 3 && uniqueCount(motions) < 3) {
      throw new Error(`cartoon_creative_director@2 prop gate failed: repeated ${type} prop needs visible state or motion changes`);
    }
  }
}

function assertTasteGates(scriptScenes: ScriptScene[], creative: CreativeDirection): void {
  const scriptCount = contentScriptScenes(scriptScenes).length;
  const creativeCount = contentCreativeScenes(creative).length;
  if (scriptCount !== creativeCount) {
    throw new Error(`cartoon_creative_director@2 taste gate failed: expected ${scriptCount} creative scenes, got ${creativeCount}`);
  }
  assertCallbackArc(creative);
  assertMetaphorSpecificity(creative);
  assertRhythmVariety(creative);
  assertBlockingVariety(creative);
  assertPerformanceSpecificity(creative);
  assertPropStateVariety(creative);
}

function xForPosition(position: string, fallback: unknown, speaker: boolean): number {
  switch (clean(position, 40)) {
    case "left": return 260;
    case "right": return 1080;
    case "center": return 690;
    case "offscreen": return speaker ? -180 : 1500;
    case "unchanged":
    default: return typeof fallback === "number" ? fallback : speaker ? 280 : 1100;
  }
}

function applyBlockingToCharacters(compiled: Record<string, unknown>, blocking: CreativeBlocking): Record<string, unknown> {
  if (!Array.isArray(compiled.characters)) return compiled;
  const characters = compiled.characters.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const c = raw as Record<string, unknown>;
    const isSpeaking = Boolean(c.isSpeaking);
    const position = isSpeaking ? blocking.speaker_position : blocking.listener_position;
    const x = xForPosition(position, c.x, isSpeaking);
    const propPosition = clean(blocking.prop_position, 40);
    const scaleNudge = propPosition === "foreground-center" && isSpeaking ? 1.08 : 1;
    return { ...c, x, scale: typeof c.scale === "number" ? c.scale * scaleNudge : scaleNudge };
  });
  return { ...compiled, characters };
}

function propAnchorForBlocking(propPosition: string, current: unknown): string {
  switch (clean(propPosition, 40)) {
    case "foreground-left": return "left";
    case "foreground-right": return "right";
    case "foreground-center": return "foreground";
    case "background": return "background";
    case "table": return "table";
    case "hand": return "hand";
    case "none": return "none";
    default: return typeof current === "string" ? current : "foreground";
  }
}

function applyBlockingToForegroundProp(compiled: Record<string, unknown>, blocking: CreativeBlocking): Record<string, unknown> {
  const rawEvent = compiled.visualEvent;
  if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) return compiled;
  const event = rawEvent as Record<string, unknown>;
  const rawProp = event.foregroundProp;
  if (!rawProp || typeof rawProp !== "object" || Array.isArray(rawProp)) return compiled;
  const prop = rawProp as Record<string, unknown>;
  const nextProp = { ...prop, anchor: propAnchorForBlocking(blocking.prop_position, prop.anchor) };
  return { ...compiled, visualEvent: { ...event, foregroundProp: nextProp } };
}

function applyTasteMetadata(entries: CompiledEntry[], creative: CreativeDirection): CompiledEntry[] {
  const creativeByIndex = new Map(creative.scenes.map((scene) => [scene.scene_index, scene]));
  return entries.map((entry) => {
    const scene = creativeByIndex.get(entry.scene_index);
    if (!scene) return entry;
    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const blocked = applyBlockingToForegroundProp(applyBlockingToCharacters(compiled, scene.blocking), scene.blocking);
    const next = {
      ...blocked,
      creativeTasteGate: {
        version: "12",
        callbackRole: scene.callback_role,
        sceneFunction: scene.scene_function,
        energyBeat: scene.energy_beat,
        metaphorType: scene.metaphor.type,
        metaphorLabel: scene.metaphor.label,
        powerShift: scene.blocking.power_shift,
      },
    };
    return { ...entry, template_data: JSON.stringify(next) };
  });
}

function creativeDirection(inputs: Record<string, { payload?: unknown } | undefined>): CreativeDirection | null {
  const payload = inputs["creative_direction"]?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const maybe = payload as Partial<CreativeDirection>;
  if (!Array.isArray(maybe.character_roles) || !Array.isArray(maybe.scenes)) return null;
  return maybe as CreativeDirection;
}

export function makeCartoonSceneCompilerWorker(): WorkerDef {
  const v11 = makeV11CartoonSceneCompilerWorker();
  return {
    ...v11,
    version: "12",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const out = await v11.execute(inputs, ctx);
      const creative = creativeDirection(inputs as Record<string, { payload?: unknown } | undefined>);
      if (!creative) return out;

      const scriptScenes = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
      assertTasteGates(scriptScenes, creative);

      const payload = out.payload as { scenes: CompiledEntry[]; degraded_count?: number };
      const scenes = applyTasteMetadata(payload.scenes, creative);
      return { ...out, payload: { ...payload, scenes } };
    },
  };
}
