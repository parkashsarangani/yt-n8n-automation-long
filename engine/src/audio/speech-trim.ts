import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LEAD_PAD_SEC = 0.06;
const TAIL_PAD_SEC = 0.10;

interface AlignmentLike {
  character_start_times_seconds?: unknown;
  character_end_times_seconds?: unknown;
  [key: string]: unknown;
}

export interface SpeechTrimWindow {
  start_sec: number;
  end_sec: number;
  duration_sec: number;
}

/**
 * Compute a conservative speech window from ElevenLabs character timing.
 * Keeping ~60ms before the first character and ~100ms after the last produces
 * a natural ~160ms turn gap when separately generated dialogue clips are joined,
 * while preserving consonant attacks and line-ending breaths.
 */
export function speechTrimWindow(alignment: unknown): SpeechTrimWindow | null {
  if (!alignment || typeof alignment !== "object" || Array.isArray(alignment)) return null;
  const raw = alignment as AlignmentLike;
  const starts = Array.isArray(raw.character_start_times_seconds)
    ? raw.character_start_times_seconds
    : [];
  const ends = Array.isArray(raw.character_end_times_seconds)
    ? raw.character_end_times_seconds
    : [];
  if (!starts.length || !ends.length) return null;

  const numericStarts = starts.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const numericEnds = ends.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!numericStarts.length || !numericEnds.length) return null;

  const first = Math.min(...numericStarts);
  const last = Math.max(...numericEnds);
  if (last <= first) return null;

  const start = Math.max(0, first - LEAD_PAD_SEC);
  const end = last + TAIL_PAD_SEC;
  if (end - start < 0.12) return null;
  return {
    start_sec: Number(start.toFixed(4)),
    end_sec: Number(end.toFixed(4)),
    duration_sec: Number((end - start).toFixed(4)),
  };
}

/** Shift the provider timing to match the trimmed audio timeline. */
export function shiftSpeechAlignment(alignment: unknown, trimStartSec: number): unknown {
  if (!alignment || typeof alignment !== "object" || Array.isArray(alignment)) return alignment;
  const raw = alignment as AlignmentLike;
  const shift = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value)
      ? Number(Math.max(0, value - trimStartSec).toFixed(4))
      : value;
  return {
    ...raw,
    ...(Array.isArray(raw.character_start_times_seconds)
      ? { character_start_times_seconds: raw.character_start_times_seconds.map(shift) }
      : {}),
    ...(Array.isArray(raw.character_end_times_seconds)
      ? { character_end_times_seconds: raw.character_end_times_seconds.map(shift) }
      : {}),
  };
}

export async function trimMp3ToSpeechWindow(
  audio: Uint8Array,
  alignment: unknown,
  ffmpegPath = process.env["FFMPEG_PATH"] || "ffmpeg",
): Promise<{ audio: Uint8Array; alignment: unknown; duration_sec: number } | null> {
  const window = speechTrimWindow(alignment);
  if (!window) return null;

  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-voice-trim-"));
  const input = path.join(dir, "input.mp3");
  const output = path.join(dir, "output.mp3");
  try {
    await writeFile(input, audio);
    await execFileAsync(
      ffmpegPath,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", input,
        "-af", `atrim=start=${window.start_sec}:end=${window.end_sec},asetpts=PTS-STARTPTS`,
        "-vn", "-c:a", "libmp3lame", "-b:a", "192k",
        output,
      ],
      { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const trimmed = await readFile(output);
    return {
      audio: new Uint8Array(trimmed),
      alignment: shiftSpeechAlignment(alignment, window.start_sec),
      duration_sec: window.duration_sec,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
