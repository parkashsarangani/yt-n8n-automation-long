import type { VisualBeat, VisualBeatPlan } from "../visual-routing.ts";

export interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export interface VoiceClipForAlignment {
  scene_index: number;
  duration_sec: number;
  alignment?: unknown;
}

export interface AlignedBeat extends VisualBeat {
  /** Actual scene-relative audio boundaries, replacing provisional LLM timing. */
  start_sec: number;
  end_sec: number;
}

interface NormalizedText {
  text: string;
  rawIndex: number[];
}

function canonicalChar(ch: string): string {
  return ch
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, "-")
    .toLowerCase();
}

/**
 * Normalize for robust substring matching while retaining an index back into
 * the exact TTS character stream. Punctuation is ignored; whitespace collapses.
 */
function normalizeMapped(raw: string): NormalizedText {
  let text = "";
  const rawIndex: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < raw.length; i++) {
    const canonical = canonicalChar(raw[i]!);
    for (const ch of canonical) {
      if (/\p{L}|\p{N}/u.test(ch)) {
        text += ch;
        rawIndex.push(i);
        lastSpace = false;
      } else if (/\s/u.test(ch) || /['"-]/.test(ch)) {
        if (!lastSpace && text.length) {
          text += " ";
          rawIndex.push(i);
          lastSpace = true;
        }
      }
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    rawIndex.pop();
  }
  return { text, rawIndex };
}

function normalizePlain(raw: string): string {
  return normalizeMapped(raw).text;
}

export function parseCharacterAlignment(value: unknown): CharacterAlignment | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const characters = v["characters"];
  const starts = v["character_start_times_seconds"];
  const ends = v["character_end_times_seconds"];
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  if (characters.length === 0 || characters.length !== starts.length || starts.length !== ends.length) return null;
  if (!characters.every((x) => typeof x === "string") || !starts.every((x) => typeof x === "number" && Number.isFinite(x)) || !ends.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  return {
    characters: characters as string[],
    character_start_times_seconds: starts as number[],
    character_end_times_seconds: ends as number[],
  };
}

function startTime(alignment: CharacterAlignment, rawIndex: number): number {
  for (let i = Math.max(0, rawIndex); i < alignment.character_start_times_seconds.length; i++) {
    const value = alignment.character_start_times_seconds[i];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  }
  return 0;
}

/** Minimum distinctive opening a beat must share with the transcript to be
 * anchored when its full narration is not a verbatim contiguous phrase. The
 * search is always forward of the previous beat's match, so a modest anchor
 * still lands on the correct sequential position; these bounds just stop a
 * one- or two-word fragment from anchoring anywhere. */
const MIN_ANCHOR_WORDS = 3;
const MIN_ANCHOR_CHARS = 12;

/**
 * Locate a beat's start in the normalized transcript, at or after `cursor`.
 *
 * Preferred: the whole beat narration is a contiguous phrase (verbatim).
 * Fallback: the Visual Director dropped/changed a word mid- or end-phrase, or
 * TTS text normalization diverged from the script it was told to quote. In that
 * case we anchor on the longest verbatim *opening* of the beat (>= 4 words and
 * >= 16 chars), which still gives a measured start time rather than a guessed
 * one. Only a beat whose very opening cannot be found sequentially — a genuine
 * paraphrase — fails closed.
 *
 * Returns the match offset and the matched length (so the cursor advances past
 * exactly what matched, not past text that was never found).
 */
function locateBeatStart(
  haystack: string,
  needle: string,
  cursor: number,
): { at: number; matchedLen: number; anchored: boolean } | null {
  const exact = haystack.indexOf(needle, cursor);
  if (exact >= 0) return { at: exact, matchedLen: needle.length, anchored: false };

  const words = needle.split(" ");
  for (let count = words.length - 1; count >= MIN_ANCHOR_WORDS; count--) {
    const prefix = words.slice(0, count).join(" ");
    if (prefix.length < MIN_ANCHOR_CHARS) break;
    const at = haystack.indexOf(prefix, cursor);
    if (at >= 0) return { at, matchedLen: prefix.length, anchored: true };
  }
  return null;
}

/**
 * Align all beats in one narration scene in sequence. Every beat start is a
 * real position in the measured voice transcript; we fail closed rather than
 * inventing a timestamp when the Visual Director genuinely paraphrases.
 */
export function alignSceneBeats(
  beats: VisualBeat[],
  alignment: CharacterAlignment,
  durationSec: number,
  logger?: { warn(msg: string): void },
): AlignedBeat[] {
  const ordered = [...beats].sort((a, b) => a.beat_index - b.beat_index);
  const spoken = alignment.characters.join("");
  const normalizedSpoken = normalizeMapped(spoken);
  let cursor = 0;
  const starts: Array<{ beat: VisualBeat; raw: number }> = [];

  for (const beat of ordered) {
    const needle = normalizePlain(beat.narration);
    if (!needle) throw new Error(`${beat.id}: narration normalizes to empty text`);
    const located = locateBeatStart(normalizedSpoken.text, needle, cursor);
    if (!located) {
      throw new Error(`${beat.id}: narration is not an exact sequential phrase in the ElevenLabs transcript; refusing guessed timing`);
    }
    if (located.anchored) {
      logger?.warn(`[beat-alignment] ${beat.id}: full narration not verbatim in transcript; anchored start on its leading ${located.matchedLen} normalized chars`);
    }
    const raw = normalizedSpoken.rawIndex[located.at];
    if (raw === undefined) throw new Error(`${beat.id}: could not map normalized phrase to character timing`);
    starts.push({ beat, raw });
    cursor = located.at + located.matchedLen;
  }

  const safeDuration = Number.isFinite(durationSec) && durationSec > 0
    ? durationSec
    : alignment.character_end_times_seconds.at(-1) ?? 0;
  if (!(safeDuration > 0)) throw new Error("voice clip has no usable duration");

  return starts.map(({ beat, raw }, index) => {
    const begin = index === 0 ? 0 : startTime(alignment, raw);
    const nextRaw = starts[index + 1]?.raw;
    const end = nextRaw === undefined ? safeDuration : startTime(alignment, nextRaw);
    if (!(end > begin)) throw new Error(`${beat.id}: aligned audio window is non-positive (${begin.toFixed(3)}-${end.toFixed(3)})`);
    return { ...beat, start_sec: Number(begin.toFixed(3)), end_sec: Number(Math.min(safeDuration, end).toFixed(3)) };
  });
}

export function alignVisualBeatPlan(
  plan: VisualBeatPlan,
  clips: VoiceClipForAlignment[],
  logger?: { warn(msg: string): void },
): VisualBeatPlan {
  const byScene = new Map<number, VisualBeat[]>();
  for (const beat of plan.beats) {
    const list = byScene.get(beat.scene_index) ?? [];
    list.push(beat);
    byScene.set(beat.scene_index, list);
  }
  const clipBy = new Map(clips.map((clip) => [clip.scene_index, clip]));
  const aligned: VisualBeat[] = [];
  for (const [sceneIndex, beats] of [...byScene.entries()].sort((a, b) => a[0] - b[0])) {
    const clip = clipBy.get(sceneIndex);
    if (!clip) throw new Error(`scene ${sceneIndex}: visual plan has no matching voice clip`);
    const parsed = parseCharacterAlignment(clip.alignment);
    if (!parsed) throw new Error(`scene ${sceneIndex}: voice clip has no usable character alignment; RFC 0010 benchmark requires measured timing`);
    aligned.push(...alignSceneBeats(beats, parsed, clip.duration_sec, logger));
  }
  return { beats: aligned };
}
