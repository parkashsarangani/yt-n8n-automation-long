import type { WorkerDef, WorkerOutput } from "../runner.ts";
import { makeCartoonSceneCompilerWorker as makeV10CartoonSceneCompilerWorker } from "./cartoon-scenes-v10.ts";

interface ScriptScene {
  scene_index: number;
  narration: string;
  speaker?: string;
  point?: string;
  is_outro?: boolean;
}

interface CompiledEntry {
  scene_index: number;
  source: "template";
  template_category: "cartoon";
  template_data: string;
}

interface CreativeRole {
  character_id: string;
  comic_role: string;
  voice_markers: string[];
  reaction_pattern: string;
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
  character_roles: CreativeRole[];
  callback: { seed: string; escalation: string; payoff: string };
  scenes: CreativeScene[];
}

const VISUAL_EVENT_TYPES = new Set(["none", "alarm-pulse", "screen-change", "audience-silhouette", "metaphor-cutaway", "prop-tremble", "thought-bubble", "reaction-pop", "callback-card"]);
const PROP_MOTIONS = new Set(["none", "pulse", "glow", "tremble", "slide-away", "thumb-hover", "open", "close", "bounce"]);

function clean(value: unknown, max = 120): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function normalizedRole(value: string): string {
  return clean(value, 120).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function markerSet(markers: string[]): Set<string> {
  return new Set(markers.map((marker) => normalizedRole(marker)).filter(Boolean));
}

function activeSpeakers(scenes: ScriptScene[]): string[] {
  return Array.from(new Set(
    scenes
      .filter((scene) => !scene.is_outro)
      .map((scene) => scene.speaker)
      .filter((speaker): speaker is string => typeof speaker === "string" && speaker.length > 0),
  ));
}

function assertCreativeSceneCoverage(scriptScenes: ScriptScene[], creative: CreativeDirection): void {
  const expected = scriptScenes.filter((scene) => !scene.is_outro).map((scene) => scene.scene_index);
  const scenesByIndex = new Map<number, CreativeScene>();
  for (const scene of creative.scenes) {
    if (scenesByIndex.has(scene.scene_index)) {
      throw new Error(`cartoon_creative_director@1 contract violated: duplicate creative scene_index ${scene.scene_index}`);
    }
    scenesByIndex.set(scene.scene_index, scene);
  }
  const missing = expected.filter((sceneIndex) => !scenesByIndex.has(sceneIndex));
  if (missing.length > 0) {
    throw new Error(`cartoon_creative_director@1 contract violated: missing creative direction for scenes ${missing.join(", ")}`);
  }
}

function assertCharacterVoiceGate(scriptScenes: ScriptScene[], creative: CreativeDirection): void {
  const speakers = activeSpeakers(scriptScenes);
  if (speakers.length < 2) return;

  const roles = new Map(creative.character_roles.map((role) => [role.character_id, role]));
  const missing = speakers.filter((speaker) => !roles.has(speaker));
  if (missing.length > 0) {
    throw new Error(`cartoon_creative_director@1 character voice gate failed: missing character_roles for active speakers ${missing.join(", ")}`);
  }

  const normalizedRoles = speakers.map((speaker) => normalizedRole(roles.get(speaker)!.comic_role));
  if (new Set(normalizedRoles).size < normalizedRoles.length) {
    throw new Error("cartoon_creative_director@1 character voice gate failed: active speakers must have distinct comic_role values");
  }

  for (let i = 0; i < speakers.length; i++) {
    for (let j = i + 1; j < speakers.length; j++) {
      const left = roles.get(speakers[i]!)!;
      const right = roles.get(speakers[j]!)!;
      const leftMarkers = markerSet(left.voice_markers);
      const rightMarkers = markerSet(right.voice_markers);
      const sharedMarkers = Array.from(leftMarkers).filter((marker) => rightMarkers.has(marker));
      const sameReaction = normalizedRole(left.reaction_pattern) === normalizedRole(right.reaction_pattern);
      if (sharedMarkers.length >= Math.min(leftMarkers.size, rightMarkers.size) && sameReaction) {
        throw new Error(`cartoon_creative_director@1 character voice gate failed: ${left.character_id} and ${right.character_id} have interchangeable voice markers and reaction patterns`);
      }
    }
  }
}

function normalizeForegroundProp(prop: CreativeForegroundProp | undefined): Record<string, unknown> | null {
  if (!prop) return null;
  const type = clean(prop.type, 40).toLowerCase();
  if (!type || type === "none") return null;
  const state = clean(prop.state, 60).toLowerCase() || `${type}-visible`;
  const motion = PROP_MOTIONS.has(clean(prop.motion, 40)) ? clean(prop.motion, 40) : "none";
  const anchor = clean(prop.anchor, 40) || "foreground";
  return {
    type,
    state,
    motion,
    anchor,
    action: clean(prop.action, 160),
    label: state.replace(/[-_]+/g, " ").toUpperCase().slice(0, 28),
  };
}

function creativeVisualEvent(compiled: Record<string, unknown>, scene: CreativeScene, root: CreativeDirection): Record<string, unknown> {
  const rawEvent = compiled.visualEvent;
  const visualEvent: Record<string, unknown> = rawEvent && typeof rawEvent === "object" && !Array.isArray(rawEvent)
    ? { ...(rawEvent as Record<string, unknown>) }
    : { type: "none" };

  const foregroundProp = normalizeForegroundProp(scene.foreground_prop);
  if (foregroundProp) {
    visualEvent.foregroundProp = foregroundProp;
    if (visualEvent.type === "none") visualEvent.type = "screen-change";
  }

  const metaphorType = clean(scene.metaphor?.type, 40);
  if (metaphorType && metaphorType !== "none" && VISUAL_EVENT_TYPES.has(metaphorType)) {
    visualEvent.type = metaphorType;
    const label = clean(scene.metaphor.label, 80);
    if (label) visualEvent.label = label;
  } else if (scene.callback_role === "payoff" && clean(root.callback?.payoff, 80)) {
    visualEvent.type = "callback-card";
    visualEvent.label = clean(root.callback.payoff, 80);
  }

  return visualEvent;
}

function applyCreativeDirection(entries: CompiledEntry[], creative: CreativeDirection): CompiledEntry[] {
  const creativeByIndex = new Map(creative.scenes.map((scene) => [scene.scene_index, scene]));
  return entries.map((entry) => {
    const scene = creativeByIndex.get(entry.scene_index);
    if (!scene) return entry;
    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const next = {
      ...compiled,
      visualEvent: creativeVisualEvent(compiled, scene, creative),
      creativeBlocking: scene.blocking,
      creativeSceneFunction: scene.scene_function,
      creativeEnergyBeat: scene.energy_beat,
      creativeCallbackRole: scene.callback_role,
      performanceNote: scene.performance_note,
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
  const v10 = makeV10CartoonSceneCompilerWorker();
  const consumes = [
    ...(v10.consumes ?? []),
    { schema_id: "creative_direction", range: "^1", as: "creative_direction" },
  ];
  return {
    ...v10,
    version: "11",
    consumes,
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const out = await v10.execute(inputs, ctx);
      const creative = creativeDirection(inputs as Record<string, { payload?: unknown } | undefined>);
      if (!creative) return out;

      const scriptScenes = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
      assertCreativeSceneCoverage(scriptScenes, creative);
      assertCharacterVoiceGate(scriptScenes, creative);

      const payload = out.payload as { scenes: CompiledEntry[]; degraded_count?: number };
      const scenes = applyCreativeDirection(payload.scenes, creative);
      return { ...out, payload: { ...payload, scenes } };
    },
  };
}
