import type { WorkerDef, WorkerOutput } from "../runner.ts";

interface PlanScene {
  scene_index: number;
  template_category?: string;
  background_location?: string;
  background_variant?: string;
  background_tone?: string;
  framing?: "two-shot" | "speaker-closeup" | "listener-closeup";
  camera_motion?: "static" | "push-in" | "pull-out" | "pan-left" | "pan-right";
  listener_actor_id?: string;
  speaker_emotion?: string;
  speaker_gesture?: string;
  speaker_gaze_target?: string;
  listener_emotion?: string;
  listener_gesture?: string;
  listener_gaze_target?: string;
  template_data?: string;
}

interface ScriptScene { scene_index: number; narration: string; speaker?: string; emotion?: string; }
interface CastCharacter { character_id: string; rig: string; }
interface CastRoster { characters: CastCharacter[]; }

const BACKGROUNDS: Record<string, readonly string[]> = {
  bedroom: ["day", "night", "messy-day", "messy-night"], cafe: ["day"],
  classroom: ["empty", "normal", "exam"], "generic-room": ["cool-day", "warm-day", "night"],
  "hospital-room": ["day"], kitchen: ["day", "night"], "living-room": ["day", "night"],
  office: ["day"], park: ["day", "evening"], "school-hallway": ["normal"],
  street: ["day", "night", "rain-night"],
};
const EMOTIONS = new Set(["neutral", "happy", "amused", "skeptical", "confused", "concerned", "sad", "angry", "surprised", "scared", "thinking", "annoyed"]);
const GESTURES = new Set(["idle", "explain", "point-left", "point-right", "shrug", "hands-open", "surprised", "thinking", "facepalm", "celebrate"]);
const GAZES = new Set(["auto", "camera", "left", "right", "up", "down", "away"]);
const TONES = new Set(["neutral", "scary", "happy", "dramatic", "cold", "warm"]);

function pick(value: unknown, allowed: Set<string>, fallback: string): string {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}
function defaultTone(emotion?: string): string {
  if (emotion === "scared") return "scary";
  if (emotion === "happy") return "happy";
  if (emotion === "angry") return "dramatic";
  if (emotion === "sad") return "cold";
  return "neutral";
}
function cameraFor(motion: PlanScene["camera_motion"]): Record<string, unknown> {
  switch (motion) {
    case "push-in": return { type: "zoom", from: 1, to: 1.1 };
    case "pull-out": return { type: "zoom", from: 1.1, to: 1 };
    case "pan-left": return { type: "pan", panFrom: 70, panTo: -70 };
    case "pan-right": return { type: "pan", panFrom: -70, panTo: 70 };
    default: return { type: "static" };
  }
}
function legacyObject(scene: PlanScene): Record<string, unknown> | null {
  const raw = scene.template_data?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
function validBackground(location: string, variant: string): boolean {
  return Boolean(BACKGROUNDS[location]?.includes(variant));
}
function sideFor(cast: CastCharacter[], actorId: string): "left" | "right" {
  const index = Math.max(0, cast.findIndex((c) => c.character_id === actorId));
  return index % 2 === 0 ? "left" : "right";
}
function baseCharacter(cast: CastCharacter[], actor: CastCharacter, isSpeaking: boolean, emotion: string, gesture: string, gazeTarget: string) {
  const side = sideFor(cast, actor.character_id);
  return { actorId: actor.character_id, characterId: actor.rig, x: side === "left" ? 280 : 1100, y: 380, scale: 1, isSpeaking, emotion, gesture, gazeTarget };
}

function compileFromShallow(plan: PlanScene, script: ScriptScene, roster: CastRoster): Record<string, unknown> | null {
  if (!plan.background_location || !plan.background_variant || !validBackground(plan.background_location, plan.background_variant) || !script.speaker) return null;
  const speaker = roster.characters.find((c) => c.character_id === script.speaker);
  if (!speaker) return null;
  const listener = plan.listener_actor_id
    ? roster.characters.find((c) => c.character_id === plan.listener_actor_id)
    : roster.characters.find((c) => c.character_id !== speaker.character_id);

  const speakerChar = baseCharacter(
    roster.characters, speaker, true,
    pick(plan.speaker_emotion, EMOTIONS, pick(script.emotion, EMOTIONS, "neutral")),
    pick(plan.speaker_gesture, GESTURES, "explain"),
    pick(plan.speaker_gaze_target, GAZES, "auto"),
  );
  const listenerChar = listener && listener.character_id !== speaker.character_id
    ? baseCharacter(roster.characters, listener, false, pick(plan.listener_emotion, EMOTIONS, "neutral"), pick(plan.listener_gesture, GESTURES, "idle"), pick(plan.listener_gaze_target, GAZES, "auto"))
    : null;

  let characters: Array<Record<string, unknown>>;
  if (plan.framing === "speaker-closeup") characters = [{ ...speakerChar, x: 710, y: 350, scale: 1.55 }];
  else if (plan.framing === "listener-closeup" && listenerChar) characters = [{ ...listenerChar, x: 710, y: 350, scale: 1.55 }];
  else characters = listenerChar ? [speakerChar, listenerChar] : [speakerChar];

  return {
    background: { location: plan.background_location, variant: plan.background_variant, tone: pick(plan.background_tone, TONES, defaultTone(script.emotion)) },
    camera: cameraFor(plan.camera_motion ?? "static"),
    characters,
  };
}

function deterministicFallback(script: ScriptScene, roster: CastRoster): Record<string, unknown> {
  const speaker = script.speaker ? roster.characters.find((c) => c.character_id === script.speaker) : roster.characters[0];
  if (!speaker) throw new Error(`scene ${script.scene_index}: cartoon compiler has no cast member to stage`);
  const listener = roster.characters.find((c) => c.character_id !== speaker.character_id);
  const speakerChar = baseCharacter(roster.characters, speaker, true, pick(script.emotion, EMOTIONS, "neutral"), "explain", "auto");
  return {
    background: { location: "generic-room", variant: "warm-day", tone: defaultTone(script.emotion) },
    camera: { type: "static" },
    characters: listener ? [speakerChar, baseCharacter(roster.characters, listener, false, "neutral", "idle", "auto")] : [speakerChar],
  };
}

export function makeCartoonSceneCompilerWorker(): WorkerDef {
  return {
    name: "cartoon_scene_compiler",
    kind: "worker",
    version: "1",
    consumes: [
      { schema_id: "visual_plan", range: "^1", as: "plan" },
      { schema_id: "script", range: "^1", as: "script" },
      { schema_id: "cast_roster", range: "^1", as: "cast" },
    ],
    produces: "asset_manifest",
    produces_version: "1.4.0",
    async execute(inputs, ctx): Promise<WorkerOutput> {
      const planScenes = (inputs["plan"]!.payload as { scenes: PlanScene[] }).scenes;
      const scriptScenes = (inputs["script"]!.payload as { scenes: ScriptScene[] }).scenes;
      const roster = inputs["cast"]!.payload as CastRoster;
      if (!Array.isArray(roster.characters) || roster.characters.length === 0) throw new Error("cartoon_scene_compiler requires a non-empty cast roster");
      const planByIndex = new Map(planScenes.map((scene) => [scene.scene_index, scene]));
      if (planByIndex.size !== planScenes.length) throw new Error("cartoon visual plan contains duplicate scene_index values");

      const entries = scriptScenes.slice().sort((a, b) => a.scene_index - b.scene_index).map((scriptScene) => {
        const plan = planByIndex.get(scriptScene.scene_index);
        let compiled: Record<string, unknown>;

        if (!plan) {
          compiled = deterministicFallback(scriptScene, roster);
          ctx.logger.warn(`[cartoon_scene_compiler] scene ${scriptScene.scene_index}: legacy visual plan is missing this script scene; synthesizing deterministic safe staging instead of blocking the episode`);
        } else {
          if (plan.template_category !== "cartoon") throw new Error(`scene ${scriptScene.scene_index}: expected template_category=\"cartoon\"`);

          const shallow = compileFromShallow(plan, scriptScene, roster);
          if (shallow) {
            compiled = shallow;
          } else {
            const legacy = legacyObject(plan);
            if (legacy) {
              compiled = legacy;
              ctx.logger.warn(`[cartoon_scene_compiler] scene ${scriptScene.scene_index}: using legacy template_data compatibility path`);
            } else {
              compiled = deterministicFallback(scriptScene, roster);
              ctx.logger.warn(`[cartoon_scene_compiler] scene ${scriptScene.scene_index}: unusable/missing planner staging; using deterministic safe staging instead of failing the episode`);
            }
          }
        }

        return { scene_index: scriptScene.scene_index, source: "template" as const, template_category: "cartoon", template_data: JSON.stringify(compiled) };
      });

      return { payload: { scenes: entries, degraded_count: 0 }, blobs: [] };
    },
  };
}
