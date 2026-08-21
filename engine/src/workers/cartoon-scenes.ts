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
interface CastCharacter { character_id: string; name?: string; rig: string; }
interface CastRoster { characters: CastCharacter[]; }
interface ShallowCompileResult {
  compiled: Record<string, unknown> | null;
  reason?: string;
  warnings: string[];
}

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
function catalogBackground(location: string, variant: string): { location: string; variant: string } {
  if (!validBackground(location, variant)) {
    throw new Error(`cartoon fallback requested unknown background ${location}/${variant}`);
  }
  return { location, variant };
}
function actorKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
function resolveCastCharacter(roster: CastRoster, value: string | undefined): CastCharacter | undefined {
  if (!value?.trim()) return undefined;
  const key = actorKey(value);
  return roster.characters.find((character) =>
    [character.character_id, character.name, character.rig]
      .filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
      .some((candidate) => actorKey(candidate) === key),
  );
}
function sideFor(cast: CastCharacter[], actorId: string): "left" | "right" {
  const index = Math.max(0, cast.findIndex((c) => c.character_id === actorId));
  return index % 2 === 0 ? "left" : "right";
}
function baseCharacter(cast: CastCharacter[], actor: CastCharacter, isSpeaking: boolean, emotion: string, gesture: string, gazeTarget: string, motionOffsetFrames: number) {
  const side = sideFor(cast, actor.character_id);
  return { actorId: actor.character_id, characterId: actor.rig, x: side === "left" ? 280 : 1100, y: 380, scale: 1, isSpeaking, emotion, gesture, gazeTarget, motionOffsetFrames };
}

function compileFromShallow(plan: PlanScene, script: ScriptScene, roster: CastRoster): ShallowCompileResult {
  const warnings: string[] = [];
  const location = plan.background_location?.trim().toLowerCase();
  const requestedVariant = plan.background_variant?.trim().toLowerCase();
  if (!location || !requestedVariant) {
    return { compiled: null, reason: "planner omitted background_location/background_variant", warnings };
  }
  const variants = BACKGROUNDS[location];
  if (!variants) {
    return { compiled: null, reason: `planner requested unknown background location "${plan.background_location}"`, warnings };
  }
  const variant = variants.includes(requestedVariant) ? requestedVariant : variants[0]!;
  if (variant !== requestedVariant) {
    warnings.push(`background ${location}/${requestedVariant} is not in the catalog; using ${location}/${variant}`);
  }

  if (!script.speaker?.trim()) {
    return { compiled: null, reason: "script scene has no speaker", warnings };
  }
  const speaker = resolveCastCharacter(roster, script.speaker);
  if (!speaker) {
    return {
      compiled: null,
      reason: `script speaker "${script.speaker}" does not match cast ids/names/rigs (${roster.characters.map((c) => c.character_id).join(", ")})`,
      warnings,
    };
  }
  if (script.speaker.trim() !== speaker.character_id) {
    warnings.push(`resolved legacy speaker label "${script.speaker}" to cast id "${speaker.character_id}"`);
  }

  let listener = resolveCastCharacter(roster, plan.listener_actor_id);
  if (plan.listener_actor_id && !listener) {
    listener = roster.characters.find((c) => c.character_id !== speaker.character_id);
    warnings.push(
      listener
        ? `listener_actor_id "${plan.listener_actor_id}" is unknown; using "${listener.character_id}"`
        : `listener_actor_id "${plan.listener_actor_id}" is unknown; rendering speaker only`,
    );
  } else if (!listener) {
    listener = roster.characters.find((c) => c.character_id !== speaker.character_id);
  }
  const baseOffset = script.scene_index * 41;

  const speakerChar = baseCharacter(
    roster.characters, speaker, true,
    pick(plan.speaker_emotion, EMOTIONS, pick(script.emotion, EMOTIONS, "neutral")),
    pick(plan.speaker_gesture, GESTURES, "idle"),
    pick(plan.speaker_gaze_target, GAZES, "auto"),
    baseOffset,
  );
  const listenerChar = listener && listener.character_id !== speaker.character_id
    ? baseCharacter(roster.characters, listener, false, pick(plan.listener_emotion, EMOTIONS, "neutral"), pick(plan.listener_gesture, GESTURES, "idle"), pick(plan.listener_gaze_target, GAZES, "auto"), baseOffset + 17)
    : null;

  let characters: Array<Record<string, unknown>>;
  if (plan.framing === "speaker-closeup") characters = [{ ...speakerChar, x: 710, y: 350, scale: 1.55 }];
  else if (plan.framing === "listener-closeup" && listenerChar) characters = [{ ...listenerChar, x: 710, y: 350, scale: 1.55 }];
  else characters = listenerChar ? [speakerChar, listenerChar] : [speakerChar];

  return {
    compiled: {
      background: { location, variant, tone: pick(plan.background_tone, TONES, defaultTone(script.emotion)) },
      camera: cameraFor(plan.camera_motion ?? "static"),
      characters,
    },
    warnings,
  };
}

function fallbackEnvironment(script: ScriptScene): { location: string; variant: string } {
  const text = script.narration.toLowerCase();
  if (/\b(?:sleep|bed|night|alarm|wake|woke|awake)\b|\b[23]\s*a\.?m\.?/.test(text)) return catalogBackground("bedroom", "night");
  if (/\b(?:boss|meeting|email|work|office|presentation|deadline)\b/.test(text)) return catalogBackground("office", "day");
  if (/\b(?:exam|class|school|teacher|student|test)\b/.test(text)) return catalogBackground("classroom", "exam");
  if (/\b(?:coffee|cafe|date|table)\b/.test(text)) return catalogBackground("cafe", "day");
  if (/\b(?:walk|outside|park|bench)\b/.test(text)) return catalogBackground("park", "day");
  if (/\b(?:street|traffic|car|bus|train)\b/.test(text)) return catalogBackground("street", "day");
  if (/\b(?:cook|kitchen|fridge|food|dinner)\b/.test(text)) return catalogBackground("kitchen", "day");
  return catalogBackground("living-room", script.scene_index % 8 >= 6 ? "night" : "day");
}

function deterministicFallback(script: ScriptScene, roster: CastRoster): Record<string, unknown> {
  const speaker = script.speaker ? resolveCastCharacter(roster, script.speaker) ?? roster.characters[0] : roster.characters[0];
  if (!speaker) throw new Error(`scene ${script.scene_index}: cartoon compiler has no cast member to stage`);
  const listener = roster.characters.find((c) => c.character_id !== speaker.character_id);
  const baseOffset = script.scene_index * 41;
  const gesture = script.scene_index % 4 === 1 ? "explain" : script.scene_index % 7 === 3 ? "thinking" : "idle";
  const speakerChar = baseCharacter(roster.characters, speaker, true, pick(script.emotion, EMOTIONS, "neutral"), gesture, "auto", baseOffset);
  const listenerChar = listener ? baseCharacter(roster.characters, listener, false, "neutral", "idle", "auto", baseOffset + 17) : null;
  const environment = fallbackEnvironment(script);
  const beat = script.scene_index % 7;

  if (beat === 2) {
    return {
      background: { ...environment, tone: defaultTone(script.emotion) },
      camera: { type: "zoom", from: 1, to: 1.08 },
      characters: [{ ...speakerChar, x: 710, y: 350, scale: 1.55 }],
    };
  }
  if (beat === 5 && listenerChar) {
    return {
      background: { ...environment, tone: defaultTone(script.emotion) },
      camera: { type: "zoom", from: 1, to: 1.04 },
      characters: [
        { ...speakerChar, x: 210, y: 390, scale: 0.84 },
        { ...listenerChar, x: 820, y: 330, scale: 1.38 },
      ],
    };
  }
  return {
    background: { ...environment, tone: defaultTone(script.emotion) },
    camera: { type: "static" },
    characters: listenerChar ? [speakerChar, listenerChar] : [speakerChar],
  };
}

function ensureMotionOffsets(compiled: Record<string, unknown>, sceneIndex: number): Record<string, unknown> {
  if (!Array.isArray(compiled.characters)) return compiled;
  const characters = compiled.characters.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const c = raw as Record<string, unknown>;
    const existing = typeof c.motionOffsetFrames === "number" && Number.isFinite(c.motionOffsetFrames)
      ? c.motionOffsetFrames
      : sceneIndex * 41 + index * 17;
    return { ...c, motionOffsetFrames: existing };
  });
  return { ...compiled, characters };
}

export function makeCartoonSceneCompilerWorker(): WorkerDef {
  return {
    name: "cartoon_scene_compiler",
    kind: "worker",
    version: "3",
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
          ctx.logger.warn(`[cartoon_scene_compiler] scene ${scriptScene.scene_index}: legacy visual plan is missing this script scene; synthesizing deterministic staging`);
        } else {
          if (plan.template_category !== "cartoon") throw new Error(`scene ${scriptScene.scene_index}: expected template_category=\"cartoon\"`);
          const shallow = compileFromShallow(plan, scriptScene, roster);
          for (const warning of shallow.warnings) {
            ctx.logger.warn(`[cartoon_scene_compiler] scene ${scriptScene.scene_index}: ${warning}`);
          }
          if (shallow.compiled) compiled = shallow.compiled;
          else {
            const legacy = legacyObject(plan);
            if (legacy) {
              compiled = legacy;
              ctx.logger.warn(`[cartoon_scene_compiler] scene ${scriptScene.scene_index}: using legacy template_data compatibility path`);
            } else {
              compiled = deterministicFallback(scriptScene, roster);
              ctx.logger.warn(
                `[cartoon_scene_compiler] scene ${scriptScene.scene_index}: planner staging unusable (${shallow.reason ?? "unknown reason"}); synthesizing deterministic staging`,
              );
            }
          }
        }

        compiled = ensureMotionOffsets(compiled, scriptScene.scene_index);
        return { scene_index: scriptScene.scene_index, source: "template" as const, template_category: "cartoon", template_data: JSON.stringify(compiled) };
      });

      return { payload: { scenes: entries, degraded_count: 0 }, blobs: [] };
    },
  };
}
