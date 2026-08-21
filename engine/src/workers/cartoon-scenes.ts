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
  visual_event?: string;
  ambient_motion?: string;
  speaker_emphasis?: string;
  cutaway_label?: string;
  template_data?: string;
}

interface ScriptScene { scene_index: number; narration: string; speaker?: string; emotion?: string; point?: string; }
interface CastCharacter { character_id: string; name?: string; rig: string; }
interface CastRoster { characters: CastCharacter[]; }
interface Environment { location: string; variant: string; }
interface DirectionPrimitives { visualEvent: string; ambientMotion: string; speakerEmphasis: string; cutawayLabel: string; }
interface ShallowCompileResult {
  compiled: Record<string, unknown> | null;
  reason?: string;
  warnings: string[];
}
interface CompiledEntry { scene_index: number; source: "template"; template_category: "cartoon"; template_data: string; }

const BACKGROUNDS: Record<string, readonly string[]> = {
  "airplane-cabin": ["day"],
  "airport-gate": ["day"],
  bedroom: ["day", "night", "messy-day", "messy-night"], cafe: ["day"],
  classroom: ["empty", "normal", "exam"], "engineering-lab": ["day"], "generic-room": ["cool-day", "warm-day", "night"],
  "hospital-room": ["day"], kitchen: ["day", "night"], "living-room": ["day", "night"],
  office: ["day"], park: ["day", "evening"], "school-hallway": ["normal"],
  street: ["day", "night", "rain-night"],
};
const EMOTIONS = new Set(["neutral", "happy", "amused", "skeptical", "confused", "concerned", "sad", "angry", "surprised", "scared", "thinking", "annoyed"]);
const GESTURES = new Set(["idle", "explain", "point-left", "point-right", "shrug", "hands-open", "surprised", "thinking", "facepalm", "celebrate"]);
const GAZES = new Set(["auto", "camera", "left", "right", "up", "down", "away"]);
const TONES = new Set(["neutral", "scary", "happy", "dramatic", "cold", "warm"]);
const VISUAL_EVENTS = new Set(["none", "alarm-pulse", "screen-change", "audience-silhouette", "metaphor-cutaway", "prop-tremble", "thought-bubble", "reaction-pop", "callback-card"]);
const AMBIENT_MOTIONS = new Set(["none", "subtle-parallax", "window-light", "monitor-glow", "chart-wiggle", "clock-tick", "rain-window", "dust-float"]);
const SPEAKER_EMPHASIS = new Set(["none", "scale-pop", "rim-glow", "listener-dim", "caption-anchor"]);

const CLOSEUP_SCALE = 1.28;
const PUSH_IN_SCALE = 1.025;
const MAX_STATIC_REPEAT = 4;
const LONG_SCRIPT_SECONDS = 75;
const WORDS_PER_SECOND = 2.6;
const MIN_DYNAMIC_BACKGROUND_SCENES = 13;

function pick(value: unknown, allowed: Set<string>, fallback: string): string {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function cleanLabel(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, 80)
    : "";
}

function canonicalFraming(value: PlanScene["framing"]): "two-shot" | "speaker-closeup" | "listener-closeup" {
  return value === "speaker-closeup" || value === "listener-closeup" ? value : "two-shot";
}

function defaultTone(): string {
  return "neutral";
}

function cameraFor(motion: PlanScene["camera_motion"]): Record<string, unknown> {
  switch (motion) {
    case "push-in": return { type: "zoom", from: 1, to: PUSH_IN_SCALE };
    case "pull-out": return { type: "zoom", from: PUSH_IN_SCALE, to: 1 };
    case "pan-left": return { type: "pan", panFrom: 55, panTo: -55 };
    case "pan-right": return { type: "pan", panFrom: -55, panTo: 55 };
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

function catalogBackground(location: string, variant: string): Environment {
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

function directionFromPlan(plan: PlanScene): DirectionPrimitives {
  const visualEvent = pick(plan.visual_event, VISUAL_EVENTS, "none");
  return {
    visualEvent,
    ambientMotion: pick(plan.ambient_motion, AMBIENT_MOTIONS, "subtle-parallax"),
    speakerEmphasis: pick(plan.speaker_emphasis, SPEAKER_EMPHASIS, "scale-pop"),
    cutawayLabel: ["metaphor-cutaway", "thought-bubble", "callback-card"].includes(visualEvent)
      ? cleanLabel(plan.cutaway_label)
      : "",
  };
}

function directionFromText(script: ScriptScene): DirectionPrimitives {
  const text = script.narration.toLowerCase();
  if (/\b(?:airplane|plane|flight|seat|window|cabin|boarding|passenger)\b/.test(text)) {
    return { visualEvent: "screen-change", ambientMotion: "window-light", speakerEmphasis: "scale-pop", cutawayLabel: "" };
  }
  if (/\b(?:pressure|stress|crack|corner|round|square|engineering|engineer|force|fuselage)\b/.test(text)) {
    return { visualEvent: "metaphor-cutaway", ambientMotion: "chart-wiggle", speakerEmphasis: "scale-pop", cutawayLabel: "STRESS FINDS CORNERS" };
  }
  if (/\b(?:present|presentation|audience|stage|speech|speaking|meeting|watched|room)\b/.test(text)) {
    return { visualEvent: "audience-silhouette", ambientMotion: "monitor-glow", speakerEmphasis: "listener-dim", cutawayLabel: "" };
  }
  if (/\b(?:alarm|panic|danger|threat|scared|fear|afraid|nervous)\b/.test(text)) {
    return { visualEvent: "alarm-pulse", ambientMotion: "subtle-parallax", speakerEmphasis: "rim-glow", cutawayLabel: "" };
  }
  if (/\b(?:wolf|predator|hunted|ancient|cave|caveman|brain)\b/.test(text)) {
    return { visualEvent: "metaphor-cutaway", ambientMotion: "dust-float", speakerEmphasis: "scale-pop", cutawayLabel: "ANCIENT ALARM" };
  }
  if (/\b(?:phone|screen|text|message|email|notification|chart|slide)\b/.test(text)) {
    return { visualEvent: "screen-change", ambientMotion: "monitor-glow", speakerEmphasis: "scale-pop", cutawayLabel: "" };
  }
  return { visualEvent: "none", ambientMotion: "subtle-parallax", speakerEmphasis: "scale-pop", cutawayLabel: "" };
}

function preferredAmbientForEnvironment(environment: Environment, current: string): string {
  if (current !== "none") return current;
  if (environment.location === "airplane-cabin") return "window-light";
  if (environment.location === "engineering-lab") return "chart-wiggle";
  if (environment.location === "airport-gate") return "monitor-glow";
  return "subtle-parallax";
}

function applyDirection(compiled: Record<string, unknown>, direction: DirectionPrimitives): Record<string, unknown> {
  const rawBackground = compiled.background;
  const background = rawBackground && typeof rawBackground === "object" && !Array.isArray(rawBackground)
    ? { ...(rawBackground as Record<string, unknown>), ambientMotion: direction.ambientMotion }
    : rawBackground;
  return {
    ...compiled,
    background,
    visualEvent: { type: direction.visualEvent, label: direction.cutawayLabel },
    speakerEmphasis: direction.speakerEmphasis,
  };
}

function topicEnvironment(script: ScriptScene): Environment | null {
  const text = `${script.point ?? ""} ${script.narration}`.toLowerCase();
  if (/\b(?:pressure|stress|crack|corner|round|square|engineering|engineer|force|fuselage|fail|failure)\b/.test(text)) {
    return catalogBackground("engineering-lab", "day");
  }
  if (/\b(?:airplane|plane|flight|seat|window|cabin|boarding|passenger|sky|lean)\b/.test(text)) {
    return catalogBackground("airplane-cabin", "day");
  }
  if (/\b(?:airport|gate|boarding pass)\b/.test(text)) {
    return catalogBackground("airport-gate", "day");
  }
  return null;
}

function applyStoryAwareEnvironment(compiled: Record<string, unknown>, script: ScriptScene): Record<string, unknown> {
  const environment = topicEnvironment(script);
  if (!environment) return compiled;
  const rawBackground = compiled.background;
  const background = rawBackground && typeof rawBackground === "object" && !Array.isArray(rawBackground)
    ? rawBackground as Record<string, unknown>
    : {};
  const currentAmbient = pick(background.ambientMotion, AMBIENT_MOTIONS, "none");
  return {
    ...compiled,
    background: {
      ...background,
      ...environment,
      tone: pick(background.tone, TONES, defaultTone()),
      ambientMotion: preferredAmbientForEnvironment(environment, currentAmbient),
    },
  };
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

  const framing = canonicalFraming(plan.framing);
  let characters: Array<Record<string, unknown>>;
  if (framing === "speaker-closeup") characters = [{ ...speakerChar, x: 710, y: 365, scale: CLOSEUP_SCALE }];
  else if (framing === "listener-closeup" && listenerChar) characters = [{ ...listenerChar, x: 710, y: 365, scale: CLOSEUP_SCALE }];
  else characters = listenerChar ? [speakerChar, listenerChar] : [speakerChar];

  const camera = cameraFor(plan.camera_motion ?? "static");

  const compiled = {
    background: { location, variant, tone: pick(plan.background_tone, TONES, defaultTone()) },
    camera,
    characters,
    shot: { framing },
  };

  return {
    compiled: applyStoryAwareEnvironment(applyDirection(compiled, directionFromPlan(plan)), script),
    warnings,
  };
}

function explicitFallbackEnvironment(script: ScriptScene): Environment | null {
  const text = script.narration.toLowerCase();
  if (/\b(?:airplane|plane|flight|seat|window|cabin|boarding|passenger|sky|lean)\b/.test(text)) return catalogBackground("airplane-cabin", "day");
  if (/\b(?:pressure|stress|crack|corner|round|square|engineering|engineer|force|fuselage)\b/.test(text)) return catalogBackground("engineering-lab", "day");
  if (/\b(?:airport|gate|boarding pass)\b/.test(text)) return catalogBackground("airport-gate", "day");
  if (/\b(?:sleep|bed|bedroom|wake|woke|awake|alarm clock)\b|\b[23]\s*a\.?m\.?/.test(text)) return catalogBackground("bedroom", "night");
  if (/\b(?:boss|meeting|email|work|office|presentation|deadline)\b/.test(text)) return catalogBackground("office", "day");
  if (/\b(?:exam|class|school|teacher|student|test)\b/.test(text)) return catalogBackground("classroom", "exam");
  if (/\b(?:coffee|cafe|date|table)\b/.test(text)) return catalogBackground("cafe", "day");
  if (/\b(?:walk|outside|park|bench)\b/.test(text)) return catalogBackground("park", "day");
  if (/\b(?:street|traffic|car|bus|train)\b/.test(text)) return catalogBackground("street", "day");
  if (/\b(?:cook|kitchen|fridge|food|dinner)\b/.test(text)) return catalogBackground("kitchen", "day");
  return null;
}

function fallbackEnvironment(script: ScriptScene, previous?: Environment): Environment {
  return explicitFallbackEnvironment(script) ?? previous ?? catalogBackground("living-room", "day");
}

function deterministicFallback(script: ScriptScene, roster: CastRoster, previousEnvironment?: Environment): Record<string, unknown> {
  const speaker = script.speaker ? resolveCastCharacter(roster, script.speaker) ?? roster.characters[0] : roster.characters[0];
  if (!speaker) throw new Error(`scene ${script.scene_index}: cartoon compiler has no cast member to stage`);
  const listener = roster.characters.find((c) => c.character_id !== speaker.character_id);
  const baseOffset = script.scene_index * 41;
  const gesture = script.scene_index % 4 === 1 ? "explain" : script.scene_index % 7 === 3 ? "thinking" : "idle";
  const speakerChar = baseCharacter(roster.characters, speaker, true, pick(script.emotion, EMOTIONS, "neutral"), gesture, "auto", baseOffset);
  const listenerChar = listener ? baseCharacter(roster.characters, listener, false, "neutral", "idle", "auto", baseOffset + 17) : null;
  const environment = fallbackEnvironment(script, previousEnvironment);
  const direction = directionFromText(script);
  const beat = script.scene_index % 7;

  if (beat === 2) {
    return applyStoryAwareEnvironment(applyDirection({
      background: { ...environment, tone: defaultTone() },
      camera: { type: "zoom", from: 1, to: 1.018 },
      characters: [{ ...speakerChar, x: 710, y: 365, scale: CLOSEUP_SCALE }],
      shot: { framing: "speaker-closeup" },
    }, direction), script);
  }
  if (beat === 5 && listenerChar) {
    return applyStoryAwareEnvironment(applyDirection({
      background: { ...environment, tone: defaultTone() },
      camera: { type: "static" },
      characters: [
        { ...speakerChar, x: 230, y: 385, scale: 0.96 },
        { ...listenerChar, x: 1060, y: 365, scale: 1.08 },
      ],
      shot: { framing: "two-shot" },
    }, direction), script);
  }
  return applyStoryAwareEnvironment(applyDirection({
    background: { ...environment, tone: defaultTone() },
    camera: { type: "static" },
    characters: listenerChar ? [speakerChar, listenerChar] : [speakerChar],
    shot: { framing: "two-shot" },
  }, direction), script);
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

function environmentFromCompiled(compiled: Record<string, unknown>): Environment | undefined {
  const raw = compiled.background;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const background = raw as Record<string, unknown>;
  const location = typeof background.location === "string" ? background.location : "";
  const variant = typeof background.variant === "string" ? background.variant : "";
  return validBackground(location, variant) ? { location, variant } : undefined;
}

function backgroundKey(compiled: Record<string, unknown>): string | null {
  const raw = compiled.background;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const background = raw as Record<string, unknown>;
  const location = typeof background.location === "string" ? background.location : "";
  const variant = typeof background.variant === "string" ? background.variant : "";
  return location && variant ? `${location}/${variant}` : null;
}

function compiledSceneKey(compiled: Record<string, unknown>): string | null {
  const rawBackground = compiled.background;
  if (!rawBackground || typeof rawBackground !== "object" || Array.isArray(rawBackground)) return null;
  const background = rawBackground as Record<string, unknown>;
  const location = typeof background.location === "string" ? background.location : "";
  const variant = typeof background.variant === "string" ? background.variant : "";
  if (!location || !variant) return null;

  const rawShot = compiled.shot;
  const shot = rawShot && typeof rawShot === "object" && !Array.isArray(rawShot)
    ? rawShot as Record<string, unknown>
    : {};
  const framing = typeof shot.framing === "string" ? shot.framing : "legacy";
  return `${location}/${variant}/${framing}`;
}

function visualEventType(compiled: Record<string, unknown>): string {
  const raw = compiled.visualEvent;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "none";
  const value = (raw as Record<string, unknown>).type;
  return typeof value === "string" ? value : "none";
}

function assertNoTemplateBoredom(entries: CompiledEntry[]): void {
  let streakKey: string | null = null;
  let streakStart = 0;
  let streakLength = 0;

  for (const entry of entries) {
    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const key = visualEventType(compiled) === "none" ? compiledSceneKey(compiled) : null;
    if (!key) {
      streakKey = null;
      streakLength = 0;
      continue;
    }
    if (key === streakKey) {
      streakLength += 1;
    } else {
      streakKey = key;
      streakStart = entry.scene_index;
      streakLength = 1;
    }
    if (streakLength > MAX_STATIC_REPEAT) {
      throw new Error(
        `cartoon_scene_compiler rejected repetitive staging: scenes ${streakStart}-${entry.scene_index} repeat ${key} without visual_event; vary background, framing, or add a visual_event`,
      );
    }
  }
}

function assertBackgroundVariety(entries: CompiledEntry[]): void {
  if (entries.length < MIN_DYNAMIC_BACKGROUND_SCENES) return;
  const keys = new Set<string>();
  for (const entry of entries) {
    const compiled = JSON.parse(entry.template_data) as Record<string, unknown>;
    const key = backgroundKey(compiled);
    if (key) keys.add(key);
  }
  if (keys.size < 2) {
    const only = [...keys][0] ?? "unknown/unknown";
    throw new Error(
      `cartoon visual plan is too static: all content scenes use ${only}. Long cartoon episodes require at least two distinct visible environments; dynamic overlays alone do not satisfy this gate.`,
    );
  }
}

function requiresV3ScriptContract(scriptArtifact: unknown): boolean {
  const producedBy = (scriptArtifact as { produced_by?: { transformation?: unknown; version?: unknown } }).produced_by;
  return producedBy?.transformation === "dialogue_script_writer"
    && typeof producedBy.version === "string"
    && Number.parseInt(producedBy.version, 10) >= 3;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function assertV3ScriptContract(scenes: ScriptScene[]): void {
  if (!scenes.length) return;
  const ordered = scenes.slice().sort((a, b) => a.scene_index - b.scene_index);
  const estimatedDurationSec = ordered.reduce((sum, scene) => sum + wordCount(scene.narration), 0) / WORDS_PER_SECOND;
  const pointLines = ordered.map((scene) => (scene.point ?? "").toLowerCase());
  const finalPoint = pointLines[pointLines.length - 1] ?? "";

  if (!/(payoff|resolve|resolution|return|opening|final|lands|closes)/.test(finalPoint)) {
    throw new Error("dialogue_script_writer@3 contract violated: final scene point must mark a payoff/resolution of the opening situation");
  }

  if (estimatedDurationSec < LONG_SCRIPT_SECONDS) return;

  if (!pointLines.some((point) => /(midpoint|turn|reframe|reversal)/.test(point))) {
    throw new Error("dialogue_script_writer@3 contract violated: long scripts must include a midpoint turn/reframe point");
  }
  const engagementCount = pointLines.filter((point) => /(engagement|joke|callback|contradiction|visual.?gag|punchline|absurd|pun)/.test(point)).length;
  if (engagementCount < 2) {
    throw new Error("dialogue_script_writer@3 contract violated: long scripts must include at least two engagement beats in scene points");
  }
}

export function makeCartoonSceneCompilerWorker(): WorkerDef {
  return {
    name: "cartoon_scene_compiler",
    kind: "worker",
    version: "6",
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
      if (requiresV3ScriptContract(inputs["script"])) assertV3ScriptContract(scriptScenes);
      const planByIndex = new Map(planScenes.map((scene) => [scene.scene_index, scene]));
      if (planByIndex.size !== planScenes.length) throw new Error("cartoon visual plan contains duplicate scene_index values");

      let previousEnvironment: Environment | undefined;
      const entries: CompiledEntry[] = scriptScenes.slice().sort((a, b) => a.scene_index - b.scene_index).map((scriptScene) => {
        const plan = planByIndex.get(scriptScene.scene_index);
        let compiled: Record<string, unknown>;

        if (!plan) {
          compiled = deterministicFallback(scriptScene, roster, previousEnvironment);
          ctx.logger.warn(`[cartoon_scene_compiler] scene ${scriptScene.scene_index}: legacy visual plan is missing this script scene; synthesizing continuity-preserving staging`);
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
              compiled = applyStoryAwareEnvironment(applyDirection(legacy, directionFromText(scriptScene)), scriptScene);
              ctx.logger.warn(`[cartoon_scene_compiler] scene ${scriptScene.scene_index}: using legacy template_data compatibility path`);
            } else {
              compiled = deterministicFallback(scriptScene, roster, previousEnvironment);
              ctx.logger.warn(
                `[cartoon_scene_compiler] scene ${scriptScene.scene_index}: planner staging unusable (${shallow.reason ?? "unknown reason"}); synthesizing continuity-preserving staging`,
              );
            }
          }
        }

        compiled = ensureMotionOffsets(compiled, scriptScene.scene_index);
        previousEnvironment = environmentFromCompiled(compiled) ?? previousEnvironment;
        return { scene_index: scriptScene.scene_index, source: "template" as const, template_category: "cartoon", template_data: JSON.stringify(compiled) };
      });

      assertNoTemplateBoredom(entries);
      assertBackgroundVariety(entries);
      return { payload: { scenes: entries, degraded_count: 0 }, blobs: [] };
    },
  };
}
