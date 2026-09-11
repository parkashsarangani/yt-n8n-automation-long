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

// script/1.7.0's narration field allows up to 2000 chars and point up to 420
// (schemas/script/1.7.0.json). On the audio-first channel narration IS the
// deliverable being judged -- clipping it below its schema ceiling silently
// truncates real scenes mid-sentence before the watchability_critic ever sees
// them. Production incident: a 360-char clip cut a ~450-char scene at
// "...introduce yourself, then f[…]", and the critic (correctly, given what it
// was shown) reported "cut-off" scenes and missing endings for the longest
// (payoff/outro) scenes, docking watchability/payoff on a script that was
// actually complete. Clip at the schema ceiling so scoring never happens on a
// mutilated scene; scenes at the true schema max are rare, so this changes
// nothing for the common case.
const MAX_NARRATION_CHARS = 2000;
const MAX_POINT_CHARS = 420;

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
    point: clip(obj.point, MAX_POINT_CHARS),
    narration: clip(obj.narration, MAX_NARRATION_CHARS),
    dialogue: compactPayload(obj.dialogue, { ...SHORT_LIMITS, maxArrayItems: 8 }),
    visual_intent: clip(obj.visual_intent, 260),
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
