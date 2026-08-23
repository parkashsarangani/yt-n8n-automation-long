import type { WorkerDef, WorkerOutput } from "../runner.ts";
import { makeCartoonSceneCompilerWorker as makeV13CartoonSceneCompilerWorker } from "./cartoon-scenes-v13.ts";

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

function clean(value: unknown, max = 240): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function normalized(value: unknown): string {
  return clean(value, 400).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function contentCreativeScenes(creative: CreativeDirection): CreativeScene[] {
  return [...creative.scenes].sort((a, b) => a.scene_index - b.scene_index);
}

function foregroundPropKind(scene: CreativeScene): string {
  return normalized(scene.foreground_prop.type).replace(/\s+/g, "-");
}

function sceneText(scene: CreativeScene): string {
  return normalized([
    scene.scene_function,
    scene.energy_beat,
    scene.foreground_prop.type,
    scene.foreground_prop.state,
    scene.foreground_prop.action,
    scene.blocking.prop_position,
    scene.blocking.power_shift,
    scene.metaphor.label,
    scene.metaphor.emotional_beat,
    scene.performance_note,
  ].join(" "));
}

function isDoorProp(scene: CreativeScene): boolean {
  const prop = foregroundPropKind(scene);
  return prop === "door" || prop === "doorway" || prop === "front-door";
}

function isDoorwayMemoryScene(scene: CreativeScene): boolean {
  if (isDoorProp(scene)) return true;
  return /\b(?:doorway|new room|old room|walked into|walk into|cross(?:ed|ing)?|location updating|without a door|through the door|room changed|room switch)\b/.test(sceneText(scene));
}

function doorwayEnvironment(scene: CreativeScene, orderedDoorwayScenes: CreativeScene[]): "office" | "living-room" | "kitchen" {
  const position = Math.max(0, orderedDoorwayScenes.findIndex((candidate) => candidate.scene_index === scene.scene_index));
  if (position <= 1) return "office";
  if (position % 3 === 1) return "living-room";
  return "kitchen";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizeLargeSetPieceProps(compiled: Record<string, unknown>, scene: CreativeScene): Record<string, unknown> {
  const visualEvent = asRecord(compiled.visualEvent);
  if (!visualEvent) return compiled;

  const foregroundProp = asRecord(visualEvent.foregroundProp);
  if (!foregroundProp) return compiled;

  const propType = normalized(foregroundProp.type ?? scene.foreground_prop.type).replace(/\s+/g, "-");
  if (propType === "door" || propType === "doorway" || propType === "front-door") {
    delete visualEvent.foregroundProp;
    if (["prop-tremble", "callback-card", "thought-bubble", "metaphor-cutaway"].includes(String(visualEvent.type))) {
      visualEvent.type = "screen-change";
    }
    return { ...compiled, visualEvent };
  }

  if (["locker", "cabinet", "window", "bed", "vehicle", "car"].includes(propType)) {
    visualEvent.foregroundProp = {
      ...foregroundProp,
      anchor: foregroundProp.anchor === "left" || foregroundProp.anchor === "right" ? foregroundProp.anchor : "background",
      motion: foregroundProp.motion === "tremble" ? "none" : foregroundProp.motion,
    };
    return { ...compiled, visualEvent };
  }

  return compiled;
}

function applyDoorwayStaging(compiled: Record<string, unknown>, scene: CreativeScene, orderedDoorwayScenes: CreativeScene[]): Record<string, unknown> {
  const withoutUnsafeProp = sanitizeLargeSetPieceProps(compiled, scene);
  if (!isDoorwayMemoryScene(scene)) return withoutUnsafeProp;

  const rawBackground = asRecord(withoutUnsafeProp.background) ?? {};
  const location = doorwayEnvironment(scene, orderedDoorwayScenes);
  const shotType = /\b(?:cross|door|doorway|walk|through)\b/.test(sceneText(scene)) ? "doorway-transition" : withoutUnsafeProp.shotType;
  const existingPerformance = asRecord(withoutUnsafeProp.rendererPerformance) ?? {};

  return {
    ...withoutUnsafeProp,
    shotType,
    background: {
      ...rawBackground,
      location,
      variant: "day",
      tone: typeof rawBackground.tone === "string" ? rawBackground.tone : "neutral",
      ambientMotion: "doorway-cross",
      doorwaySetPiece: true,
    },
    rendererPerformance: {
      ...existingPerformance,
      doorwayStaging: "environment",
      doorwayEnvironment: location,
      visibleCentralObject: "doorway-set-piece",
    },
  };
}

export function applyRendererStaging(entries: CompiledEntry[], creative: CreativeDirection): CompiledEntry[] {
  const scenesByIndex = new Map(contentCreativeScenes(creative).map((scene) => [scene.scene_index, scene]));
  const doorwayScenes = contentCreativeScenes(creative).filter(isDoorwayMemoryScene);
  return entries.map((entry) => {
    const scene = scenesByIndex.get(entry.scene_index);
    if (!scene) return entry;
    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const staged = applyDoorwayStaging(compiled, scene, doorwayScenes);
    return { ...entry, template_data: JSON.stringify(staged) };
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
  const v13 = makeV13CartoonSceneCompilerWorker();
  return {
    ...v13,
    version: "14",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const out = await v13.execute(inputs, ctx);
      const creative = creativeDirection(inputs as Record<string, { payload?: unknown } | undefined>);
      if (!creative) return out;

      const payload = out.payload as { scenes: CompiledEntry[]; degraded_count?: number };
      const scenes = applyRendererStaging(payload.scenes, creative);
      return { ...out, payload: { ...payload, scenes } };
    },
  };
}
