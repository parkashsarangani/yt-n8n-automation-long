import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function extension(mediaType: string): string {
  switch (mediaType) {
    case "audio/wav": return ".wav";
    case "audio/ogg": return ".ogg";
    case "audio/aac": return ".aac";
    case "audio/flac": return ".flac";
    default: return ".mp3";
  }
}

/**
 * Slice an exact scene-relative narration window. The comparison render emits
 * MP3 regardless of source type so every beat scene has one stable audio
 * contract. This is benchmark-only; the production voice artifact is immutable.
 */
export async function sliceAudioWindow(
  audio: Uint8Array,
  mediaType: string,
  startSec: number,
  endSec: number,
): Promise<{ bytes: Uint8Array; media_type: "audio/mpeg" }> {
  if (!(endSec > startSec) || startSec < 0) throw new Error(`invalid audio window ${startSec}-${endSec}`);
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-beat-audio-"));
  const input = path.join(dir, `input${extension(mediaType)}`);
  const output = path.join(dir, "beat.mp3");
  try {
    await writeFile(input, audio);
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-ss", startSec.toFixed(3), "-i", input,
      "-t", (endSec - startSec).toFixed(3),
      "-vn", "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", "-ac", "1",
      "-y", output,
    ]);
    const bytes = new Uint8Array(await readFile(output));
    if (!bytes.length) throw new Error("ffmpeg produced an empty beat audio clip");
    return { bytes, media_type: "audio/mpeg" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
