import type { WorkerDef, WorkerOutput } from "../runner.ts";
import { makeCartoonSceneCompilerWorker as makeV12CartoonSceneCompilerWorker } from "./cartoon-scenes-v12.ts";

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

type PerformanceCueType =
  | "notice"
  | "hesitate"
  | "double-take"
  | "side-eye"
  | "deadpan"
  | "recoil"
  | "small-defeat"
  | "reluctant-acceptance"
  | "point-at-prop";

type RendererShotType = "wide" | "medium" | "close-up" | "prop-close-up" | "doorway-transition" | "counter-shot" | "table-shot";
type RendererStyleName = "clean-flat" | "warm-modern" | "bold-outline" | "soft-editorial";
type RendererLighting = "neutral" | "warm-window" | "cool-monitor" | "morning-soft";
type RendererDepth = "flat" | "layered-parallax" | "stage-depth";
type RendererShadow = "none" | "soft-offset" | "deep-stage";

interface RendererVisualStyle {
  name: RendererStyleName;
  lineWeight: number;
  shadow: RendererShadow;
  depth: RendererDepth;
  lighting: RendererLighting;
  propScale: number;
}

interface RendererEnvironment {
  location: "kitchen" | "living-room" | "office" | "street";
  variant: "day" | "night";
  ambientMotion?: string;
}

function clean(value: unknown, max = 160): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function normalized(value: unknown): string {
  return clean(value, 240).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function contentCreativeScenes(creative: CreativeDirection): CreativeScene[] {
  return [...creative.scenes].sort((a, b) => a.scene_index - b.scene_index);
}

function callbackText(creative: CreativeDirection, role: CreativeScene["callback_role"]): string {
  switch (role) {
    case "seed": return clean(creative.callback.seed, 100);
    case "escalation": return clean(creative.callback.escalation, 100);
    case "payoff": return clean(creative.callback.payoff, 100);
    default: return "";
  }
}

function explicitPerformanceCue(text: string): PerformanceCueType | null {
  if (!text) return null;
  if (/\b(?:deadpan|dry|flat|blunt)\b/.test(text)) return "deadpan";
  if (/\b(?:side eye|skeptical|suspicious|judges|judge)\b/.test(text)) return "side-eye";
  if (/\b(?:betrayed|recoils?|backs away|scared|panic|dread|startled)\b/.test(text)) return "recoil";
  if (/\b(?:concedes|concede|reluctant|acceptance|accepts|fine|quietly redirects|finally)\b/.test(text)) return "reluctant-acceptance";
  if (/\b(?:defeat|embarrass\w*|caught|wrong|loses|beat)\b/.test(text)) return "small-defeat";
  if (/\b(?:realizes|realizing|sudden|wait|double take)\b/.test(text)) return "double-take";
  if (/\b(?:notices?|spots?|catches?|sees?|watches|recognizes?|observes?|looks at)\b/.test(text)) return "notice";
  if (/\b(?:hesitat\w*|pauses?|freezes|holds back|stops)\b/.test(text)) return "hesitate";
  if (/\b(?:points?|pointing|pointed)\b/.test(text) || /\b(?:toward|at) the (?:object|cue|prop|phone|clock|keys|kettle|laptop)\b/.test(text)) return "point-at-prop";
  return null;
}

function performanceCueType(scene: CreativeScene): PerformanceCueType {
  const noteCue = explicitPerformanceCue(normalized(scene.performance_note));
  if (noteCue) return noteCue;

  const fallbackCue = explicitPerformanceCue(normalized(`${scene.scene_function} ${scene.energy_beat}`));
  return fallbackCue ?? "notice";
}

function cueLabel(cue: PerformanceCueType): string {
  switch (cue) {
    case "double-take": return "DOUBLE TAKE";
    case "side-eye": return "SIDE-EYE";
    case "deadpan": return "DEADPAN";
    case "recoil": return "RECOIL";
    case "small-defeat": return "SMALL DEFEAT";
    case "reluctant-acceptance": return "RELUCTANT ACCEPTANCE";
    case "point-at-prop": return "LOOK AT THE PROP";
    case "hesitate": return "HESITATE";
    default: return "NOTICE";
  }
}

function callbackEchoFor(scene: CreativeScene, creative: CreativeDirection): Record<string, unknown> | null {
  if (scene.callback_role === "none" || scene.callback_role === "payoff") return null;
  const text = callbackText(creative, scene.callback_role);
  const label = clean(scene.metaphor.label, 80) || text;
  return {
    role: scene.callback_role,
    text,
    label,
    motif: clean(scene.foreground_prop.type, 40) || "callback",
    propType: clean(scene.foreground_prop.type, 40),
    propState: clean(scene.foreground_prop.state, 60),
    intensity: scene.callback_role === "escalation" ? "medium" : "low",
  };
}

function viewerPropType(value: unknown): string {
  const type = normalized(value);
  if (!type || type === "none" || type === "object" || type === "appliance" || type === "device") return "visual beat";
  return clean(value, 40).toLowerCase();
}

function foregroundPropLabel(scene: CreativeScene): string {
  const type = normalized(scene.foreground_prop.type);
  const propText = normalized(`${scene.foreground_prop.state} ${scene.foreground_prop.action}`);
  if (type === "phone") return "PHONE";
  if (type === "clock") return "8:00";
  if (type === "keys") return "KEYS";
  if (type === "route map" || type === "route-map") return "ROUTE";
  if (type === "calendar") return "PLAN";
  if (type === "door" || type === "doorway") return "DOOR";
  if (type === "coffee" || type === "mug") return "COFFEE";
  if (type === "kettle") return "KETTLE";
  if (type === "shoes") return "SHOES";
  if (type === "laptop") return /\bdownstairs\b/.test(propText) ? "LAPTOP DOWNSTAIRS" : "LAPTOP";
  if (type === "bed" || type === "sheets") return "BED";
  if (type === "appliance" || type === "device") return "GLOW";
  return clean(scene.foreground_prop.type, 24).toUpperCase() || "OBJECT";
}

function sanitizeForegroundProp(visualEvent: Record<string, unknown>, scene: CreativeScene): void {
  const raw = visualEvent.foregroundProp;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  visualEvent.foregroundProp = {
    ...(raw as Record<string, unknown>),
    label: foregroundPropLabel(scene),
  };
}

function metaphorVisualFor(scene: CreativeScene): Record<string, unknown> | null {
  const type = clean(scene.metaphor.type, 40);
  if (!type || type === "none") return null;
  return {
    type,
    label: clean(scene.metaphor.label, 80),
    emotionalBeat: clean(scene.metaphor.emotional_beat, 120),
    propType: viewerPropType(scene.foreground_prop.type),
    propState: clean(scene.foreground_prop.state, 60),
  };
}

function performanceCueFor(scene: CreativeScene): Record<string, unknown> {
  const type = performanceCueType(scene);
  return {
    type,
    label: cueLabel(type),
    anchor: scene.blocking.speaker_position || "center",
    propType: clean(scene.foreground_prop.type, 40),
    intensity: scene.callback_role === "payoff" ? "high" : scene.callback_role === "escalation" ? "medium" : "low",
  };
}

function isPrimaryTextCard(type: unknown): boolean {
  return ["callback-card", "metaphor-cutaway", "thought-bubble"].includes(String(type));
}

function hasPrimaryOverlay(visualEvent: Record<string, unknown>): boolean {
  const type = typeof visualEvent.type === "string" ? visualEvent.type : "none";
  const hasForegroundProp = Boolean(visualEvent.foregroundProp);
  return Boolean(visualEvent.callbackEcho || visualEvent.metaphorVisual)
    || isPrimaryTextCard(type)
    || (type === "screen-change" && !hasForegroundProp);
}

function stripEnhancementOverlays(visualEvent: Record<string, unknown>): void {
  delete visualEvent.callbackEcho;
  delete visualEvent.metaphorVisual;
  delete visualEvent.performanceCue;
}

function enhanceVisualEvent(raw: unknown, scene: CreativeScene, creative: CreativeDirection): Record<string, unknown> {
  const visualEvent: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : { type: "none" };
  sanitizeForegroundProp(visualEvent, scene);

  const callbackEcho = callbackEchoFor(scene, creative);
  if (scene.callback_role === "payoff") {
    visualEvent.type = "callback-card";
    visualEvent.label = clean(scene.metaphor.label, 80) || callbackText(creative, "payoff");
    stripEnhancementOverlays(visualEvent);
    return visualEvent;
  }

  if (callbackEcho) {
    if (isPrimaryTextCard(visualEvent.type)) {
      stripEnhancementOverlays(visualEvent);
      return visualEvent;
    }
    visualEvent.callbackEcho = callbackEcho;
    delete visualEvent.metaphorVisual;
  } else {
    const metaphorVisual = metaphorVisualFor(scene);
    if (metaphorVisual) {
      if (isPrimaryTextCard(visualEvent.type)) {
        stripEnhancementOverlays(visualEvent);
        return visualEvent;
      }
      visualEvent.metaphorVisual = metaphorVisual;
    }
  }

  if (hasPrimaryOverlay(visualEvent)) {
    delete visualEvent.performanceCue;
  } else {
    visualEvent.performanceCue = performanceCueFor(scene);
  }
  return visualEvent;
}

function sceneEnvironmentText(scene: CreativeScene): string {
  return normalized([
    scene.scene_function,
    scene.energy_beat,
    scene.foreground_prop.type,
    scene.foreground_prop.state,
    scene.foreground_prop.action,
    scene.blocking.power_shift,
    scene.metaphor.label,
    scene.metaphor.emotional_beat,
    scene.performance_note,
  ].join(" "));
}

function rendererEnvironmentFor(scene: CreativeScene): RendererEnvironment | null {
  const text = sceneEnvironmentText(scene);
  if (/\b(?:downstairs|kitchen|counter|coffee|kettle|breakfast|mug|sink|fridge)\b/.test(text)) {
    return { location: "kitchen", variant: "day", ambientMotion: "subtle-parallax" };
  }
  if (/\b(?:out the door|doorway|hallway|leaving the room|leave the room|outside the room)\b/.test(text)) {
    return { location: "living-room", variant: "day", ambientMotion: "subtle-parallax" };
  }
  if (/\b(?:office|desk|deadline|work|laptop|email|meeting)\b/.test(text)) {
    return { location: "office", variant: "day", ambientMotion: "monitor-glow" };
  }
  if (/\b(?:street|commute|bus|train|traffic|sidewalk)\b/.test(text)) {
    return { location: "street", variant: "day", ambientMotion: "subtle-parallax" };
  }
  return null;
}

function applyRendererEnvironment(compiled: Record<string, unknown>, scene: CreativeScene): Record<string, unknown> {
  const environment = rendererEnvironmentFor(scene);
  if (!environment) return compiled;
  const rawBackground = compiled.background;
  const background = rawBackground && typeof rawBackground === "object" && !Array.isArray(rawBackground)
    ? rawBackground as Record<string, unknown>
    : {};
  if (background.location === environment.location && background.variant === environment.variant) return compiled;
  return {
    ...compiled,
    background: {
      ...background,
      location: environment.location,
      variant: environment.variant,
      tone: typeof background.tone === "string" ? background.tone : "neutral",
      ambientMotion: environment.ambientMotion ?? background.ambientMotion ?? "subtle-parallax",
    },
  };
}

function foregroundPropKind(scene: CreativeScene): string {
  return normalized(scene.foreground_prop.type).replace(/\s+/g, "-");
}

function rendererShotTypeFor(scene: CreativeScene): RendererShotType {
  const propType = foregroundPropKind(scene);
  const propPosition = normalized(scene.blocking.prop_position);
  const energy = normalized(`${scene.scene_function} ${scene.energy_beat}`);

  if (scene.callback_role === "payoff" || propPosition.includes("foreground")) return "prop-close-up";
  if (propType === "door" || propType === "doorway") return "doorway-transition";
  if (["coffee", "mug", "kettle", "food", "appliance", "device"].includes(propType)) return "counter-shot";
  if (["route-map", "calendar", "document", "bill", "invoice", "receipt", "letter", "envelope", "keys"].includes(propType) || propPosition === "table") return "table-shot";
  if (/\b(?:realization|realizes|caught|defeat|betrayed|side eye|deadpan|recoil)\b/.test(energy)) return "close-up";
  if (scene.scene_index % 5 === 0) return "wide";
  return "medium";
}

function rendererVisualStyleFor(scene: CreativeScene): RendererVisualStyle {
  const propType = foregroundPropKind(scene);
  const text = sceneEnvironmentText(scene);
  const cue = performanceCueType(scene);

  const name: RendererStyleName = scene.callback_role === "payoff" || cue === "recoil" || cue === "small-defeat"
    ? "bold-outline"
    : /\b(?:sleep|morning|tired|bed|window|coffee|kettle|kitchen)\b/.test(text)
      ? "warm-modern"
      : /\b(?:office|laptop|email|screen|monitor)\b/.test(text)
        ? "soft-editorial"
        : "clean-flat";

  const lighting: RendererLighting = ["laptop", "phone", "appliance", "device"].includes(propType) || /\b(?:office|screen|monitor|email)\b/.test(text)
    ? "cool-monitor"
    : /\b(?:morning|kitchen|coffee|kettle|window|breakfast)\b/.test(text)
      ? "warm-window"
      : "neutral";

  const depth: RendererDepth = scene.callback_role === "payoff" || scene.callback_role === "escalation" ? "stage-depth" : "layered-parallax";
  const shadow: RendererShadow = name === "bold-outline" ? "deep-stage" : "soft-offset";
  const lineWeight = name === "bold-outline" ? 10 : name === "soft-editorial" ? 5 : 7;
  const propScale = rendererShotTypeFor(scene) === "prop-close-up" ? 1.12 : 1.03;

  return { name, lineWeight, shadow, depth, lighting, propScale };
}

function applyRendererSignals(entries: CompiledEntry[], creative: CreativeDirection): CompiledEntry[] {
  const scenesByIndex = new Map(contentCreativeScenes(creative).map((scene) => [scene.scene_index, scene]));
  return entries.map((entry) => {
    const scene = scenesByIndex.get(entry.scene_index);
    if (!scene) return entry;
    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const withEnvironment = applyRendererEnvironment(compiled, scene);
    const shotType = rendererShotTypeFor(scene);
    const visualStyle = rendererVisualStyleFor(scene);
    const next = {
      ...withEnvironment,
      shotType,
      visualStyle,
      visualEvent: enhanceVisualEvent(withEnvironment.visualEvent, scene, creative),
      rendererPerformance: {
        version: "13",
        cue: performanceCueType(scene),
        callbackRole: scene.callback_role,
        metaphorType: scene.metaphor.type,
        performanceNote: scene.performance_note,
        shotType,
        visualStyle: visualStyle.name,
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
  const v12 = makeV12CartoonSceneCompilerWorker();
  return {
    ...v12,
    version: "13",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const out = await v12.execute(inputs, ctx);
      const creative = creativeDirection(inputs as Record<string, { payload?: unknown } | undefined>);
      if (!creative) return out;

      const payload = out.payload as { scenes: CompiledEntry[]; degraded_count?: number };
      const scenes = applyRendererSignals(payload.scenes, creative);
      return { ...out, payload: { ...payload, scenes } };
    },
  };
}
