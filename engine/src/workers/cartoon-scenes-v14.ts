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
type ShotRecipe = "establishing" | "two-shot" | "reaction-closeup" | "prop-insert" | "over-shoulder" | "crossing-transition" | "callback-reveal" | "payoff-hold";
type PropPlacement = "hand-held" | "on-table" | "on-counter" | "floor" | "wall-mounted" | "background-set-piece" | "ui-badge";
type SceneRole = "setup" | "room-a" | "crossing" | "room-b" | "return" | "payoff" | "mechanism";

interface SetPieceSpec {
  kind: SetPieceKind;
  motion: SetPieceMotion;
  emphasis: "low" | "medium" | "high";
}

interface CinematicSpec {
  shotRecipe: ShotRecipe;
  transition: "cut" | "soft-push-left" | "soft-push-right" | "doorway-slide" | "prop-match-cut" | "reaction-pop-cut";
  cameraIntent: "static" | "slow-push" | "reaction-push" | "prop-focus" | "doorway-track" | "payoff-hold";
  propPlacement: PropPlacement;
  propMode: "physical" | "badge";
  sceneRole: SceneRole;
  continuityGroup: string;
  sfxCue: "none" | "soft-hit" | "room-change" | "prop" | "reaction" | "payoff";
  qualityTags: string[];
}

const SET_PIECE_PROPS = new Set(["door", "doorway", "front-door", "window", "bed", "sheets", "locker", "cabinet", "vehicle", "car"]);

function clean(value: unknown, max = 240): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function normalized(value: unknown): string {
  return clean(value, 500).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

function episodeText(scenes: CreativeScene[]): string {
  return normalized(scenes.map(sceneText).join(" "));
}

function setPieceKindFromProp(propType: string): SetPieceKind | null {
  if (["door", "doorway", "front-door"].includes(propType)) return "doorway";
  if (propType === "window") return "window";
  if (propType === "bed" || propType === "sheets") return "bed";
  if (propType === "locker" || propType === "cabinet") return "locker";
  if (propType === "vehicle" || propType === "car") return "vehicle";
  return null;
}

function isDoorwayTopic(scenes: CreativeScene[]): boolean {
  return /\b(?:doorway|new room|old room|walked into|walk into|cross|crossing|through the door|room changed|room switch|location updating)\b/.test(episodeText(scenes));
}

function isDoorCrossingBeat(scene: CreativeScene): boolean {
  const prop = foregroundPropKind(scene);
  const text = sceneText(scene);
  return setPieceKindFromProp(prop) === "doorway" || /\b(?:cross|through|walk|enter|leave|leaving|open|doorway)\b/.test(text);
}

function sceneRoleFor(scene: CreativeScene, orderedScenes: CreativeScene[], doorwayTopic: boolean): SceneRole {
  const index = Math.max(0, orderedScenes.findIndex((candidate) => candidate.scene_index === scene.scene_index));
  const total = Math.max(1, orderedScenes.length);
  const text = sceneText(scene);

  if (scene.callback_role === "payoff" || /\bpayoff|resolution|changed behavior\b/.test(text)) return "payoff";
  if (doorwayTopic && isDoorCrossingBeat(scene)) return "crossing";
  if (/\bmechanism|metaphor|explain|why|turn\b/.test(text)) return "mechanism";
  if (!doorwayTopic) return index === 0 ? "setup" : index > total * 0.72 ? "payoff" : "mechanism";
  if (index < Math.ceil(total * 0.28)) return "room-a";
  if (index > Math.floor(total * 0.74)) return "return";
  return "room-b";
}

function spatialEnvironmentFor(scene: CreativeScene, orderedScenes: CreativeScene[], doorwayTopic: boolean, rawLocation: unknown): string | undefined {
  if (!doorwayTopic) return typeof rawLocation === "string" && rawLocation ? rawLocation : undefined;
  const role = sceneRoleFor(scene, orderedScenes, doorwayTopic);
  switch (role) {
    case "setup":
    case "room-a": return "living-room";
    case "crossing": return "hallway";
    case "room-b": return "kitchen";
    case "return": return "living-room";
    case "payoff": return "living-room";
    case "mechanism": return "office";
  }
}

function setPieceMotionFor(kind: SetPieceKind, scene: CreativeScene): SetPieceMotion {
  const text = sceneText(scene);
  if (kind === "doorway") return /\b(?:cross|through|walk|enter|leave|leaving|open)\b/.test(text) ? "cross" : "still";
  if (kind === "locker") return /\b(?:glow|hum|open|pulse)\b/.test(text) ? "glow" : "still";
  if (kind === "vehicle") return /\b(?:arrive|leave|move|traffic|commute)\b/.test(text) ? "settle" : "still";
  return "still";
}

function setPieceSpecForScene(scene: CreativeScene, doorwayTopic: boolean): SetPieceSpec | null {
  const directKind = setPieceKindFromProp(foregroundPropKind(scene));
  const doorwayKind = doorwayTopic && isDoorCrossingBeat(scene) ? "doorway" : null;
  const kind = directKind ?? doorwayKind;
  if (!kind) return null;
  if (kind === "doorway" && doorwayTopic && !isDoorCrossingBeat(scene)) return null;
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

function propPlacementForScene(scene: CreativeScene, location?: string): PropPlacement {
  const prop = foregroundPropKind(scene);
  const action = sceneText(scene);
  if (setPieceKindFromProp(prop)) return "background-set-piece";
  if (/\b(?:hold|holds|holding|grab|grabs|picked|picks|clutch|shows|hands?)\b/.test(action)) return "hand-held";
  if (["clock", "calendar", "window", "door"].includes(prop)) return "wall-mounted";
  if (["shoes", "shoe", "vehicle", "car"].includes(prop)) return "floor";
  if (location === "kitchen" || location === "cafe" || location === "shop") return "on-counter";
  if (["phone", "charger", "phone-charger"].includes(prop)) return "hand-held";
  return "on-table";
}

function ensureForegroundProp(compiled: Record<string, unknown>, scene: CreativeScene, placement: PropPlacement): Record<string, unknown> {
  const propType = foregroundPropKind(scene);
  if (!propType || propType === "none" || setPieceKindFromProp(propType)) return compiled;

  const visualEvent = asRecord(compiled.visualEvent) ?? { type: "none" };
  const existing = asRecord(visualEvent.foregroundProp) ?? {};
  visualEvent.foregroundProp = {
    ...existing,
    type: existing.type ?? propType,
    state: existing.state ?? clean(scene.foreground_prop.state, 80) || "present",
    motion: existing.motion ?? clean(scene.foreground_prop.motion, 40) || "settle",
    anchor: placement,
    placement,
    renderMode: "physical",
  };
  return { ...compiled, visualEvent };
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

function shotRecipeFor(scene: CreativeScene, index: number, total: number, setPiece: SetPieceSpec | null, role: SceneRole): ShotRecipe {
  const prop = foregroundPropKind(scene);
  const text = sceneText(scene);
  if (index === 0) return "establishing";
  if (role === "crossing" || setPiece?.kind === "doorway") return "crossing-transition";
  if (scene.callback_role === "payoff" || role === "payoff") return "payoff-hold";
  if (scene.callback_role === "escalation") return "callback-reveal";
  if (prop && prop !== "none" && !SET_PIECE_PROPS.has(prop) && (/\b(?:prop|object|grab|shows|points|practical|attempt|payoff|callback|central)\b/.test(text) || index % 5 === 2)) return "prop-insert";
  if (/\b(?:reaction|double take|side eye|surprise|confused|skeptical|deadpan|rude|wait)\b/.test(text)) return "reaction-closeup";
  if (index > total * 0.66 && index % 2 === 0) return "over-shoulder";
  return "two-shot";
}

function shotTypeForRecipe(recipe: ShotRecipe): "wide" | "medium" | "close-up" | "prop-close-up" | "doorway-transition" | "counter-shot" | "table-shot" {
  switch (recipe) {
    case "establishing": return "wide";
    case "reaction-closeup": return "close-up";
    case "prop-insert": return "prop-close-up";
    case "over-shoulder": return "medium";
    case "crossing-transition": return "doorway-transition";
    case "callback-reveal": return "close-up";
    case "payoff-hold": return "medium";
    case "two-shot": return "medium";
  }
}

function transitionForRecipe(recipe: ShotRecipe, index: number): CinematicSpec["transition"] {
  switch (recipe) {
    case "establishing": return "cut";
    case "crossing-transition": return "doorway-slide";
    case "prop-insert": return "prop-match-cut";
    case "reaction-closeup": return "reaction-pop-cut";
    case "callback-reveal": return "soft-push-left";
    case "payoff-hold": return "soft-push-right";
    case "over-shoulder": return index % 2 === 0 ? "soft-push-left" : "soft-push-right";
    case "two-shot": return index % 2 === 0 ? "soft-push-right" : "soft-push-left";
  }
}

function cameraIntentForRecipe(recipe: ShotRecipe): CinematicSpec["cameraIntent"] {
  switch (recipe) {
    case "establishing": return "slow-push";
    case "reaction-closeup": return "reaction-push";
    case "prop-insert": return "prop-focus";
    case "crossing-transition": return "doorway-track";
    case "payoff-hold": return "payoff-hold";
    case "callback-reveal": return "slow-push";
    case "over-shoulder": return "slow-push";
    case "two-shot": return "static";
  }
}

function cinematicSpecForScene(scene: CreativeScene, index: number, total: number, setPiece: SetPieceSpec | null, location: string | undefined, role: SceneRole): CinematicSpec {
  const shotRecipe = shotRecipeFor(scene, index, total, setPiece, role);
  const propPlacement = propPlacementForScene(scene, location);
  const sfxCue: CinematicSpec["sfxCue"] = shotRecipe === "crossing-transition" ? "room-change" : shotRecipe === "prop-insert" ? "prop" : shotRecipe === "reaction-closeup" ? "reaction" : shotRecipe === "payoff-hold" ? "payoff" : "none";
  return {
    shotRecipe,
    transition: transitionForRecipe(shotRecipe, index),
    cameraIntent: cameraIntentForRecipe(shotRecipe),
    propPlacement,
    propMode: propPlacement === "ui-badge" ? "badge" : "physical",
    sceneRole: role,
    continuityGroup: location ? `space:${location}` : "space:unknown",
    sfxCue,
    qualityTags: ["cinematic-shot", `recipe:${shotRecipe}`, `role:${role}`, `prop:${propPlacement}`],
  };
}

function applySetPieceAndCinematicStaging(compiled: Record<string, unknown>, scene: CreativeScene, orderedScenes: CreativeScene[], index: number, doorwayTopic: boolean): Record<string, unknown> {
  const withoutUnsafeProp = sanitizeSetPieceForeground(compiled, scene);
  const rawBackground = asRecord(withoutUnsafeProp.background) ?? {};
  const role = sceneRoleFor(scene, orderedScenes, doorwayTopic);
  const location = spatialEnvironmentFor(scene, orderedScenes, doorwayTopic, rawBackground.location);
  const setPiece = setPieceSpecForScene(scene, doorwayTopic && role === "crossing");
  const cinematic = cinematicSpecForScene(scene, index, orderedScenes.length, setPiece, location, role);
  const existingPerformance = asRecord(withoutUnsafeProp.rendererPerformance) ?? {};
  const withForeground = ensureForegroundProp(withoutUnsafeProp, scene, cinematic.propPlacement);
  const foregroundVisualEvent = asRecord(withForeground.visualEvent) ?? asRecord(withoutUnsafeProp.visualEvent);

  return {
    ...withForeground,
    shotType: shotTypeForRecipe(cinematic.shotRecipe),
    cinematic,
    background: {
      ...rawBackground,
      location: typeof location === "string" && location ? location : rawBackground.location,
      variant: typeof rawBackground.variant === "string" ? rawBackground.variant : "day",
      tone: typeof rawBackground.tone === "string" ? rawBackground.tone : "neutral",
      ambientMotion: setPiece ? ambientMotionForSetPiece(setPiece) : (rawBackground.ambientMotion ?? "subtle-parallax"),
      setPiece: setPiece ?? undefined,
      doorwaySetPiece: setPiece?.kind === "doorway",
    },
    visualEvent: foregroundVisualEvent ?? withForeground.visualEvent,
    rendererPerformance: {
      ...existingPerformance,
      qualityTarget: "cinematic-9-5",
      shotRecipe: cinematic.shotRecipe,
      sceneRole: cinematic.sceneRole,
      transition: cinematic.transition,
      propPlacement: cinematic.propPlacement,
      setPieceStaging: setPiece ? "background" : existingPerformance.setPieceStaging,
      setPieceKind: setPiece?.kind ?? existingPerformance.setPieceKind,
      setPieceMotion: setPiece?.motion ?? existingPerformance.setPieceMotion,
      doorwayStaging: setPiece?.kind === "doorway" ? "environment" : existingPerformance.doorwayStaging,
      doorwayEnvironment: setPiece?.kind === "doorway" ? location : existingPerformance.doorwayEnvironment,
      visibleCentralObject: setPiece ? `${setPiece.kind}-set-piece` : foregroundPropKind(scene),
    },
  };
}

export function applyRendererStaging(entries: CompiledEntry[], creative: CreativeDirection): CompiledEntry[] {
  const scenes = contentCreativeScenes(creative);
  const scenesByIndex = new Map(scenes.map((scene) => [scene.scene_index, scene]));
  const doorwayTopic = isDoorwayTopic(scenes);
  return entries.map((entry, index) => {
    const scene = scenesByIndex.get(entry.scene_index);
    if (!scene) return entry;
    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const staged = applySetPieceAndCinematicStaging(compiled, scene, scenes, index, doorwayTopic);
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
    version: "15",
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
