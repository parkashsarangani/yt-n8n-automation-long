/**
 * Channel call to action (operator decision 2026-09-28: both spoken and in
 * the description, on every episode -- season and custom alike).
 *
 * Deterministic on purpose. Before this, the only CTA was whatever the SEO
 * model happened to write: season episodes had none, custom episodes got a
 * generic "like and subscribe", and no episode ever said it out loud.
 * Model-written scripts are still barred from generic engagement asks
 * (agent-validators GENERIC_ENGAGEMENT); this is added after them, once.
 * Change the wording here; nothing else hard-codes it.
 */

/** Narrated as its own closing scene, after the story and any next-episode teaser. */
export const SPOKEN_CTA =
  "If this was useful, subscribe for more everyday psychology — and tell me in the comments where you've noticed this in your own life.";

/** Appended to every YouTube description, ahead of chapters and credits. */
export const DESCRIPTION_CTA =
  "Subscribe for more everyday psychology, and tell us in the comments where you've noticed this in your own life.";

const CTA_POINT = "[cta] Subscribe";

interface Scene { scene_index?: number; act_index?: number; point?: string; narration?: string; is_outro?: boolean }

/** Append the spoken CTA as the final scene. Idempotent: never adds a second one. */
export function appendSpokenCta(scriptPayload: unknown): unknown {
  const script = scriptPayload as { scenes?: Scene[] } | null;
  if (!script || typeof script !== "object" || !Array.isArray(script.scenes) || script.scenes.length === 0) return scriptPayload;
  const last = script.scenes[script.scenes.length - 1]!;
  if (typeof last.point === "string" && last.point.startsWith("[cta]")) return scriptPayload;
  const maxIndex = script.scenes.reduce((max, s) => typeof s?.scene_index === "number" ? Math.max(max, s.scene_index) : max, -1);
  const scene: Scene = {
    scene_index: maxIndex + 1,
    ...(typeof last.act_index === "number" ? { act_index: last.act_index } : {}),
    point: CTA_POINT,
    narration: SPOKEN_CTA,
  };
  const scenes = [...script.scenes, scene];
  const wordCount = scenes.reduce((n, s) => n + (s.narration ?? "").trim().split(/\s+/).filter(Boolean).length, 0);
  return { ...script, scenes, ...("word_count" in script ? { word_count: wordCount } : {}) };
}

/**
 * The description with exactly one CTA: ours. A trailing subscribe ask the
 * SEO model added (or copied from the manual story's stock outro line) is
 * dropped rather than doubled up.
 */
export function withDescriptionCta(description: string): string {
  const lines = description.trimEnd().split("\n");
  // Drop trailing lines that ARE a subscribe ask -- never a content line that
  // merely ends with one (the sentence rule below trims that).
  const isAskLine = (line: string) =>
    /^\s*(?:thanks for watching|don't forget to|please (?:like|subscribe)|(?:like and )?subscribe)\b/i.test(line) && /\bsubscribe\b/i.test(line);
  while (lines.length > 0 && isAskLine(lines[lines.length - 1]!)) lines.pop();
  // A subscribe ask glued onto the end of the last paragraph.
  const body = lines.join("\n").trimEnd()
    .replace(/\s*(?:Thanks for watching\s*[—–-]\s*)?(?:don't forget to |please )?(?:like and )?subscribe\b[^.!?\n]*[.!?]?$/i, "")
    .trimEnd();
  return body ? `${body}\n\n${DESCRIPTION_CTA}` : DESCRIPTION_CTA;
}
