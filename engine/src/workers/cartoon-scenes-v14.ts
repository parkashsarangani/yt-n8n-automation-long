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

type SetPieceKind = "doorway" | "window" | "bed" | "locker" | "vehicle";
type SetPieceMotion = "still" | "cross" | "glow" | "settle";

interface SetPieceSpec {
  kind: SetPieceKind;
  motion: SetPieceMotion;
  emphasis: "low" | "medium" | "high";
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

function setPieceKindFromProp(propType: string): SetPieceKind | null {
  if (["door", "doorway", "front-door"].includes(propType)) return "doorway";
  if (propType === "window") return "window";
  if (propType === "bed" || propType === "sheets") return "bed";
  if (propType === "locker" || propType === "cabinet") return "locker";
  if (propType === "vehicle" || propType === "car") return "vehicle";
  return null;
}

function isDoorwayMemoryScene(scene: CreativeScene): boolean {
  if (setPieceKindFromProp(foregroundPropKind(scene)) === "doorway") return true;
  return /\b(?:doorway|new room|old room|walked into|walk into|cross(?:ed|ing)?|location updating|without a door|through the door|room changed|room switch)\b/.test(sceneText(scene));
}

function spatialEnvironment(scene: CreativeScene, orderedSpatialScenes: CreativeScene[]): "office" | "living-room" | "kitchen" {
  const position = Math.max(0, orderedSpatialScenes.findIndex((candidate) => candidate.scene_index === scene.scene_index));
  if (position <= 1) return "office";
  if (position % 3 === 1) return "living-room";
  return "kitchen";
}

function setPieceMotionFor(kind: SetPieceKind, scene: CreativeScene): SetPieceMotion {
  const text = sceneText(scene);
  if (kind === "doorway") return /\b(?:cross|through|walk|enter|leave|leaving|open)\b/.test(text) ? "cross" : "still";
  if (kind === "locker") return /\b(?:glow|hum|open|pulse)\b/.test(text) ? "glow" : "still";
  if (kind === "vehicle") return /\b(?:arrive|leave|move|traffic|commute)\b/.test(text) ? "settle" : "still";
  return "still";
}

function setPieceSpecForScene(scene: CreativeScene): SetPieceSpec | null {
  const directKind = setPieceKindFromProp(foregroundPropKind(scene));
  const kind = directKind ?? (isDoorwayMemoryScene(scene) ? "doorway" : null);
  if (!kind) return null;
  return {
    kind,
    motion: setPieceMotionFor(kind, scene),
    emphasis: scene.callback_role === "payoff" ? "high" : scene.callback_role === "escalation" ? "medium" : "low",
  };
}

function ambientMotionForSetPiece(spec: SetPieceSpec): "doorway-cross" | "window-light" | "dust-float" | "subtle-parallax" {
  switch (spec.kind) {
    case "doorway": return "doorway-cross";
    case "window": return "window-light";
    case "bed": return "dust-float";
    case "locker":
    case "vehicle": return "subtle-parallax";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizeSetPieceForeground(compiled: Record<string, unknown>, scene: CreativeScene): Record<string, unknown> {
  const visualEvent = asRecord(compiled.visualEvent);
  if (!visualEvent) return compiled;

  const foregroundProp = asRecord(visualEvent.foregroundProp);
  if (!foregroundProp) return compiled;

  const propType = normalized(foregroundProp.type ?? scene.foreground_prop.type).replace(/\s+/g, "-");
  if (!setPieceKindFromProp(propType)) return compiled;

  delete visualEvent.foregroundProp;
  if (["prop-tremble", "callback-card", "thought-bubble", "metaphor-cutaway"].includes(String(visualEvent.type))) {
    visualEvent.type = "screen-change";
  }
  return { ...compiled, visualEvent };
}

function applySetPieceStaging(compiled: Record<string, unknown>, scene: CreativeScene, orderedSpatialScenes: CreativeScene[]): Record<string, unknown> {
  const withoutUnsafeProp = sanitizeSetPieceForeground(compiled, scene);
  const setPiece = setPieceSpecForScene(scene);
  if (!setPiece) return withoutUnsafeProp;

  const rawBackground = asRecord(withoutUnsafeProp.background) ?? {};
  const isSpatialDoorway = setPiece.kind === "doorway" && isDoorwayMemoryScene(scene);
  const location = isSpatialDoorway ? spatialEnvironment(scene, orderedSpatialScenes) : rawBackground.location;
  const existingPerformance = asRecord(withoutUnsafeProp.rendererPerformance) ?? {};

  return {
    ...withoutUnsafeProp,
    shotType: setPiece.kind === "doorway" ? "doorway-transition" : withoutUnsafeProp.shotType,
    background: {
      ...rawBackground,
      location: typeof location === "string" && location ? location : rawBackground.location,
      variant: typeof rawBackground.variant === "string" ? rawBackground.variant : "day",
      tone: typeof rawBackground.tone === "string" ? rawBackground.tone : "neutral",
      ambientMotion: ambientMotionForSetPiece(setPiece),
      setPiece,
      doorwaySetPiece: setPiece.kind === "doorway",
    },
    rendererPerformance: {
      ...existingPerformance,
      setPieceStaging: "background",
      setPieceKind: setPiece.kind,
      setPieceMotion: setPiece.motion,
      doorwayStaging: setPiece.kind === "doorway" ? "environment" : existingPerformance.doorwayStaging,
      doorwayEnvironment: setPiece.kind === "doorway" ? location : existingPerformance.doorwayEnvironment,
      visibleCentralObject: `${setPiece.kind}-set-piece`,
    },
  };
}

export function applyRendererStaging(entries: CompiledEntry[], creative: CreativeDirection): CompiledEntry[] {
  const scenesByIndex = new Map(contentCreativeScenes(creative).map((scene) => [scene.scene_index, scene]));
  const spatialScenes = contentCreativeScenes(creative).filter(isDoorwayMemoryScene);
  return entries.map((entry) => {
    const scene = scenesByIndex.get(entry.scene_index);
    if (!scene) return entry;
    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const staged = applySetPieceStaging(compiled, scene, spatialScenes);
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
