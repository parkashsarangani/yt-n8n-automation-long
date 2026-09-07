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

function previousSpokenEnd(alignment: CharacterAlignment, rawIndex: number): number | null {
  for (let i = Math.min(rawIndex - 1, alignment.characters.length - 1); i >= 0; i--) {
    if (!alignment.characters[i]?.trim()) continue;
    const value = alignment.character_end_times_seconds[i];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  }
  return null;
}

const VISUAL_PAUSE_MIN_SEC = 0.25;
const VISUAL_EARLY_ESTABLISH_MAX_SEC = 0.40;

/**
 * If a measured beat boundary is preceded by a genuine speech pause, let the
 * next visual establish during the tail of that pause instead of combining
 * silence + visual reset + new speech. Audio is authoritative and untouched.
 */
function visualBoundaryTime(alignment: CharacterAlignment, rawIndex: number): number {
  const spokenStart = startTime(alignment, rawIndex);
  const previousEnd = previousSpokenEnd(alignment, rawIndex);
  if (previousEnd === null) return spokenStart;
  const gap = spokenStart - previousEnd;
  if (!(gap > VISUAL_PAUSE_MIN_SEC)) return spokenStart;
  return Math.max(previousEnd, spokenStart - Math.min(VISUAL_EARLY_ESTABLISH_MAX_SEC, gap));
}

const MIN_ANCHOR_WORDS = 3;
const MIN_ANCHOR_CHARS = 12;

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
  let dropped = 0;

  for (let index = 0; index < ordered.length; index++) {
    const beat = ordered[index]!;
    const needle = normalizePlain(beat.narration);
    if (!needle) throw new Error(`${beat.id}: narration normalizes to empty text`);
    const located = locateBeatStart(normalizedSpoken.text, needle, cursor);

    if (!located) {
      if (index === 0 || starts.length === 0) {
        throw new Error(`${beat.id}: opening beat narration is not in the ElevenLabs transcript; cannot anchor the scene`);
      }
      dropped++;
      logger?.warn(`[beat-alignment] ${beat.id}: narration not found in transcript; dropping this beat, the previous beat's visual covers its window`);
      continue;
    }

    if (located.anchored) {
      logger?.warn(`[beat-alignment] ${beat.id}: full narration not verbatim in transcript; anchored start on its leading ${located.matchedLen} normalized chars`);
    }
    const raw = normalizedSpoken.rawIndex[located.at];
    if (raw === undefined) throw new Error(`${beat.id}: could not map normalized phrase to character timing`);
    starts.push({ beat, raw });
    cursor = located.at + located.matchedLen;
  }

  if (dropped > 0 && dropped > ordered.length / 2) {
    throw new Error(`scene ${ordered[0]!.scene_index}: ${dropped}/${ordered.length} beat narrations are not in the transcript; the visual plan does not match the voice-over`);
  }

  const safeDuration = Number.isFinite(durationSec) && durationSec > 0
    ? durationSec
    : alignment.character_end_times_seconds.at(-1) ?? 0;
  if (!(safeDuration > 0)) throw new Error("voice clip has no usable duration");

  // One boundary array drives BOTH the previous end and next start. This keeps
  // visual_timeline perfectly contiguous even when a pause lets the next visual
  // begin up to 400 ms before its first spoken character.
  const boundaries = starts.map(({ raw }, index) => index === 0 ? 0 : visualBoundaryTime(alignment, raw));

  return starts.map(({ beat }, index) => {
    const begin = boundaries[index] ?? 0;
    const end = boundaries[index + 1] ?? safeDuration;
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
