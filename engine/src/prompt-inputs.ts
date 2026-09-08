import { watchabilityPolicyForDuration } from "./watchability-policy.ts";

type JsonObject = Record<string, unknown>;

interface CompactLimits {
  maxDepth: number;
  maxArrayItems: number;
  maxStringLength: number;
}

const DEFAULT_LIMITS: CompactLimits = {
  maxDepth: 6,
  maxArrayItems: 40,
  maxStringLength: 900,
};

const SHORT_LIMITS: CompactLimits = {
  maxDepth: 5,
  maxArrayItems: 24,
  maxStringLength: 420,
};

/**
 * script/creativeDirection/visualPlan views must all cap scenes the same way
 * for the legacy cartoon agents. visual_director is deliberately exempt: its
 * hard coverage contract requires every approved scene and exact narration.
 */
const MAX_LONG_EPISODE_SCENES = 48;

/**
 * Build prompt-only views of upstream artifacts.
 *
 * Artifacts remain immutable and full-fidelity in storage. This function only
 * trims what an agent sees in its prompt, removing fields that are irrelevant to
 * the next decision and bounding repeated arrays/long prose before they become
 * input-token cost.
 */
export function promptInputView(agentName: string, inputName: string, payload: unknown): unknown {
  if (agentName === "visual_director") {
    switch (inputName) {
      case "script": return visualDirectorScriptView(payload);
      case "voice": return visualDirectorVoiceView(payload);
      case "growth": return visualDirectorGrowthView(payload);
      case "intent": return visualDirectorIntentView(payload);
      default: break;
    }
  }

  if ((agentName === "narration_script_writer" || agentName === "watchability_critic") && inputName === "intent") {
    return watchabilityIntentView(payload);
  }

  switch (inputName) {
    case "intent":
      return compactPayload(payload, SHORT_LIMITS);
    case "history":
    case "insights":
      return compactPayload(payload, SHORT_LIMITS);
    case "performance":
      return performanceWindowView(payload);
    case "story":
      return storyView(payload);
    case "script":
      return scriptView(payload, agentName === "seo_optimizer" ? 12 : MAX_LONG_EPISODE_SCENES);
    case "cast":
    case "cast_roster":
      return castView(payload);
    case "creative_direction":
      return creativeDirectionView(payload);
    case "visual_plan":
      return visualPlanView(payload);
    default:
      return compactPayload(payload, DEFAULT_LIMITS);
  }
}

/**
 * visual_director must reproduce narration byte-for-byte, so narration is the
 * one field that must never be clipped. Everything else is a compact visual
 * decision aid rather than a second copy of upstream artifacts.
 */
function visualDirectorScriptView(value: unknown): unknown {
  const obj = asObject(value);
  if (!obj) return value;
  return pruneEmpty({
    scene_count: asArray(obj.scenes).length,
    scenes: asArray(obj.scenes).map((scene) => {
      const s = asObject(scene);
      if (!s) return scene;
      return pruneEmpty({
        scene_index: s.scene_index,
        is_outro: s.is_outro,
        narration: s.narration,
        point: clip(s.point, 180),
        visual_intent: clip(s.visual_intent, 180),
      });
    }),
  });
}

function visualDirectorVoiceView(value: unknown): unknown {
  const obj = asObject(value);
  if (!obj) return compactPayload(value, SHORT_LIMITS);
  return pruneEmpty({
    total_duration_sec: obj.total_duration_sec,
    clips: asArray(obj.clips).map((clipValue) => {
      const clipObj = asObject(clipValue);
      if (!clipObj) return compactPayload(clipValue, SHORT_LIMITS);
      return pruneEmpty({
        scene_index: clipObj.scene_index,
        duration_sec: clipObj.duration_sec,
      });
    }),
  });
}

function visualDirectorGrowthView(value: unknown): unknown {
  const obj = asObject(value);
  if (!obj) return compactPayload(value, SHORT_LIMITS);
  const firstThirty = asObject(obj.first_30_seconds);
  return pruneEmpty({
    premise: clip(obj.premise, 360),
    curiosity_gap: clip(obj.curiosity_gap, 260),
    emotional_engine: clip(obj.emotional_engine, 220),
    selected_title: clip(obj.selected_title, 180),
    selected_thumbnail_concept: clip(obj.selected_thumbnail_concept, 260),
    opening_visual: clip(obj.opening_visual, 320),
    opening_promise: firstThirty ? clip(firstThirty.promise, 280) : undefined,
    next_video_bridge: clip(obj.next_video_bridge, 260),
    hero_motion_eligible: obj.hero_motion_eligible,
  });
}

function visualDirectorIntentView(value: unknown): unknown {
  const obj = asObject(value);
  if (!obj) return compactPayload(value, SHORT_LIMITS);
  return pruneEmpty({
    brief: clip(obj.brief, 320),
    target_duration_sec: obj.target_duration_sec,
    constraints: compactPayload(obj.constraints, { ...SHORT_LIMITS, maxArrayItems: 16, maxStringLength: 220 }),
    genre: obj.genre,
    image_style: obj.image_style,
  });
}

/**
 * The critic, writer revision prompt and deterministic release gate must see the
 * same duration-aware release surface. This is derived prompt context only; the
 * immutable intent artifact remains unchanged.
 */
function watchabilityIntentView(value: unknown): unknown {
  const obj = asObject(value);
  if (!obj) return compactPayload(value, SHORT_LIMITS);
  const policy = watchabilityPolicyForDuration(obj.target_duration_sec);
  return pruneEmpty({
    brief: clip(obj.brief, 320),
    target_duration_sec: obj.target_duration_sec,
    genre: obj.genre,
    constraints: compactPayload(obj.constraints, { ...SHORT_LIMITS, maxArrayItems: 16, maxStringLength: 220 }),
    watchability_release_profile: {
      profile: policy.profile,
      thresholds: policy.thresholds,
      average_threshold: policy.averageThreshold,
    },
  });
}

function storyView(value: unknown): unknown {
  const obj = asObject(value);
  if (!obj) return compactPayload(value, DEFAULT_LIMITS);
  return pruneEmpty({
    topic: obj.topic,
    title: obj.title,
    hook: clip(obj.hook, 520),
    premise: clip(obj.premise, 520),
    acts: asArray(obj.acts).slice(0, 8).map((act) => pickObject(act, [
      "act_index",
      "act_title",
      "title",
      "premise",
      "target_words",
      "story_function",
    ], SHORT_LIMITS)),
    beats: asArray(obj.beats).slice(0, 18).map((beat) => compactPayload(beat, SHORT_LIMITS)),
    characters: asArray(obj.characters).slice(0, 8).map((character) => compactPayload(character, SHORT_LIMITS)),
    payoff: clip(obj.payoff, 520),
    comment_hook: clip(obj.comment_hook, 320),
    outro_line: clip(obj.outro_line, 240),
  });
}

function scriptView(value: unknown, maxScenes: number): unknown {
  const obj = asObject(value);
  if (!obj) return compactPayload(value, DEFAULT_LIMITS);
  return pruneEmpty({
    word_count: obj.word_count,
    scenes: asArray(obj.scenes).slice(0, maxScenes).map(sceneView),
  });
}

function sceneView(scene: unknown): unknown {
  const obj = asObject(scene);
  if (!obj) return compactPayload(scene, SHORT_LIMITS);
  return pruneEmpty({
    scene_index: obj.scene_index,
    act_index: obj.act_index,
    is_outro: obj.is_outro,
    speaker: obj.speaker,
    emotion: obj.emotion,
    speaker_id: obj.speaker_id,
    speaker_name: obj.speaker_name,
    character_id: obj.character_id,
    point: clip(obj.point, 260),
    narration: clip(obj.narration, 360),
    dialogue: compactPayload(obj.dialogue, { ...SHORT_LIMITS, maxArrayItems: 8 }),
    visual_intent: clip(obj.visual_intent, 260),
  });
}

function castView(value: unknown): unknown {
  const obj = asObject(value);
  if (!obj) return compactPayload(value, SHORT_LIMITS);
  return pruneEmpty({
    cast_id: obj.cast_id,
    style: obj.style,
    characters: asArray(obj.characters).slice(0, 8).map((character) =>
      pickObject(character, [
        "character_id",
        "name",
        "role",
        "comic_role",
        "visual_role",
        "voice_markers",
        "reaction_pattern",
        "personality",
        "worldview",
        "comic_style",
        "speech_rhythm",
        "strength",
        "blind_spot",
        "scene_drive",
        "relationship_dynamic",
        "color",
        "avatar",
      ], SHORT_LIMITS),
    ),
  });
}

function creativeDirectionView(value: unknown): unknown {
  const obj = asObject(value);
  if (!obj) return compactPayload(value, DEFAULT_LIMITS);
  return pruneEmpty({
    character_roles: asArray(obj.character_roles).slice(0, 8).map((role) =>
      pickObject(role, ["character_id", "comic_role", "voice_markers", "reaction_pattern"], SHORT_LIMITS),
    ),
    callback: compactPayload(obj.callback, SHORT_LIMITS),
    scenes: asArray(obj.scenes).slice(0, MAX_LONG_EPISODE_SCENES).map((scene) => {
      const s = asObject(scene);
      if (!s) return compactPayload(scene, SHORT_LIMITS);
      return pruneEmpty({
        scene_index: s.scene_index,
        scene_function: s.scene_function,
        energy_beat: s.energy_beat,
        foreground_prop: compactPayload(s.foreground_prop, SHORT_LIMITS),
        blocking: compactPayload(s.blocking, SHORT_LIMITS),
        metaphor: compactPayload(s.metaphor, SHORT_LIMITS),
        callback_role: s.callback_role,
        performance_note: clip(s.performance_note, 260),
      });
    }),
  });
}

function visualPlanView(value: unknown): unknown {
  const obj = asObject(value);
  if (!obj) return compactPayload(value, DEFAULT_LIMITS);
  return pruneEmpty({
    scenes: asArray(obj.scenes).slice(0, MAX_LONG_EPISODE_SCENES).map((scene) => {
      const s = asObject(scene);
      if (!s) return compactPayload(scene, SHORT_LIMITS);
      return pickObject(s, [
        "scene_index",
        "background_location",
        "background_variant",
        "camera",
        "characters",
        "foreground_prop",
        "visual_event",
        "shotType",
        "visualStyle",
      ], SHORT_LIMITS);
    }),
  });
}

function performanceWindowView(value: unknown): unknown {
  const obj = asObject(value);
  if (!obj) return compactPayload(value, DEFAULT_LIMITS);
  return pruneEmpty({
    generated_at: obj.generated_at,
    episode_count: obj.episode_count,
    ctr_available: obj.ctr_available,
    aggregates: compactPayload(obj.aggregates, SHORT_LIMITS),
    episodes: asArray(obj.episodes).slice(0, 80).map((episode) =>
      pickObject(episode, [
        "external_id",
        "title",
        "primary_keyword",
        "thumbnail_text",
        "published_at",
        "window_days",
        "metrics",
      ], SHORT_LIMITS),
    ),
  });
}

function pickObject(value: unknown, keys: string[], limits: CompactLimits): unknown {
  const obj = asObject(value);
  if (!obj) return compactPayload(value, limits);
  const out: JsonObject = {};
  for (const key of keys) {
    if (key in obj) out[key] = compactPayload(obj[key], limits);
  }
  return pruneEmpty(out);
}

function compactPayload(value: unknown, limits: CompactLimits, depth = 0): unknown {
  if (typeof value === "string") return clip(value, limits.maxStringLength);
  if (value === null || typeof value !== "object") return value;
  if (depth >= limits.maxDepth) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, limits.maxArrayItems).map((item) => compactPayload(item, limits, depth + 1));
  }
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(value as JsonObject)) {
    out[key] = compactPayload(nested, limits, depth + 1);
  }
  return pruneEmpty(out);
}

function clip(value: unknown, max: number): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max - 14).trimEnd()}… [truncated]`;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pruneEmpty(obj: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}
