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
 * Build prompt-only views of upstream artifacts.
 *
 * Artifacts remain immutable and full-fidelity in storage. This function only
 * trims what an agent sees in its prompt, removing fields that are irrelevant to
 * the next decision and bounding repeated arrays/long prose before they become
 * input-token cost.
 */
export function promptInputView(agentName: string, inputName: string, payload: unknown): unknown {
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
      // 24 matches creativeDirectionView/visualPlanView's cap below: script scenes
      // and creative_direction scenes are the same array, 1:1 by scene_index, and
      // assertCreativeSceneCoverage requires creative_direction to cover every
      // script scene regardless of what the model saw. A cap below the real scene
      // count silently blinds the model to a scene it must still produce output
      // for — usually the payoff, since it's last. 18 was below the standard
      // 19-scene long-episode fixture used throughout this project's tests.
      return scriptView(payload, agentName === "seo_optimizer" ? 12 : 24);
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
    scenes: asArray(obj.scenes).slice(0, 24).map((scene) => {
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
    scenes: asArray(obj.scenes).slice(0, 24).map((scene) => {
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
