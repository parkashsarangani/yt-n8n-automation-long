import type { WorkerDef, WorkerOutput } from "../runner.ts";
import { makeCartoonSceneCompilerWorker as makeV12CartoonSceneCompilerWorker } from "./cartoon-scenes-v12.ts";

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
  if (/\b(?:betrayed|recoil|backs away|scared|panic|dread|startled)\b/.test(text)) return "recoil";
  if (/\b(?:concedes|concede|reluctant|acceptance|accepts|fine|quietly redirects|finally)\b/.test(text)) return "reluctant-acceptance";
  if (/\b(?:defeat|embarrass|caught|wrong|loses|beat)\b/.test(text)) return "small-defeat";
  if (/\b(?:realizes|realizing|sudden|wait|double take)\b/.test(text)) return "double-take";
  if (/\b(?:hesitat|pause|freezes|before|holds back|stops)\b/.test(text)) return "hesitate";
  if (/\b(?:points|point|object|cue|prop|phone|clock|keys|kettle)\b/.test(text)) return "point-at-prop";
  return null;
}

function performanceCueType(scene: CreativeScene): PerformanceCueType {
  const noteCue = explicitPerformanceCue(normalized(scene.performance_note));
  if (noteCue) return noteCue;

  const fallbackCue = explicitPerformanceCue(normalized(`${scene.scene_function} ${scene.energy_beat}`));
  return fallbackCue ?? "notice";
}

function cueLabel(cue: PerformanceCueType, scene: CreativeScene): string {
  const note = clean(scene.performance_note, 90);
  if (note) return note;
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
  if (scene.callback_role === "none") return null;
  const text = callbackText(creative, scene.callback_role);
  const label = clean(scene.metaphor.label, 80) || text;
  return {
    role: scene.callback_role,
    text,
    label,
    motif: clean(scene.foreground_prop.type, 40) || "callback",
    propType: clean(scene.foreground_prop.type, 40),
    propState: clean(scene.foreground_prop.state, 60),
    intensity: scene.callback_role === "payoff" ? "high" : scene.callback_role === "escalation" ? "medium" : "low",
  };
}

function metaphorVisualFor(scene: CreativeScene): Record<string, unknown> | null {
  const type = clean(scene.metaphor.type, 40);
  if (!type || type === "none") return null;
  return {
    type,
    label: clean(scene.metaphor.label, 80),
    emotionalBeat: clean(scene.metaphor.emotional_beat, 120),
    propType: clean(scene.foreground_prop.type, 40),
    propState: clean(scene.foreground_prop.state, 60),
  };
}

function performanceCueFor(scene: CreativeScene): Record<string, unknown> {
  const type = performanceCueType(scene);
  return {
    type,
    label: cueLabel(type, scene),
    anchor: scene.blocking.speaker_position || "center",
    propType: clean(scene.foreground_prop.type, 40),
    intensity: scene.callback_role === "payoff" ? "high" : scene.callback_role === "escalation" ? "medium" : "low",
  };
}

function enhanceVisualEvent(raw: unknown, scene: CreativeScene, creative: CreativeDirection): Record<string, unknown> {
  const visualEvent: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : { type: "none" };

  const callbackEcho = callbackEchoFor(scene, creative);
  if (callbackEcho) {
    visualEvent.callbackEcho = callbackEcho;
    if (scene.callback_role === "payoff") {
      visualEvent.type = "callback-card";
      visualEvent.label = clean(scene.metaphor.label, 80) || callbackText(creative, "payoff");
    }
  }

  const metaphorVisual = metaphorVisualFor(scene);
  if (metaphorVisual) visualEvent.metaphorVisual = metaphorVisual;

  visualEvent.performanceCue = performanceCueFor(scene);
  return visualEvent;
}

function applyRendererSignals(entries: CompiledEntry[], creative: CreativeDirection): CompiledEntry[] {
  const scenesByIndex = new Map(contentCreativeScenes(creative).map((scene) => [scene.scene_index, scene]));
  return entries.map((entry) => {
    const scene = scenesByIndex.get(entry.scene_index);
    if (!scene) return entry;
    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const next = {
      ...compiled,
      visualEvent: enhanceVisualEvent(compiled.visualEvent, scene, creative),
      rendererPerformance: {
        version: "13",
        cue: performanceCueType(scene),
        callbackRole: scene.callback_role,
        metaphorType: scene.metaphor.type,
        performanceNote: scene.performance_note,
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
