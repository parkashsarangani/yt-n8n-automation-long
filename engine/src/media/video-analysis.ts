import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SampledFrame {
  at_sec: number;
  bytes: Uint8Array;
  media_type: "image/jpeg";
}

async function withVideo<T>(video: Uint8Array, fn: (file: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-rfc0010-"));
  const input = path.join(dir, "input.mp4");
  try {
    await writeFile(input, video);
    return await fn(input, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function probeVideoDuration(video: Uint8Array): Promise<number> {
  return withVideo(video, async (input) => {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input,
    ]);
    const n = Number(stdout.trim());
    if (!Number.isFinite(n) || n <= 0) throw new Error(`ffprobe returned invalid duration '${stdout.trim()}'`);
    return n;
  });
}

/** Sample actual source frames from a candidate window. */
export async function sampleVideoFrames(
  video: Uint8Array,
  startSec: number,
  endSec: number,
  count = 5,
): Promise<SampledFrame[]> {
  if (!(endSec > startSec)) throw new Error("sampleVideoFrames requires endSec > startSec");
  const safeCount = Math.max(3, Math.min(6, Math.floor(count)));
  return withVideo(video, async (input, dir) => {
    const span = endSec - startSec;
    const times = Array.from({ length: safeCount }, (_, i) =>
      startSec + span * ((i + 0.5) / safeCount),
    );
    const frames: SampledFrame[] = [];
    for (let i = 0; i < times.length; i++) {
      const out = path.join(dir, `frame-${i}.jpg`);
      await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-ss", times[i]!.toFixed(3), "-i", input,
        "-frames:v", "1", "-vf", "scale=960:-2:flags=lanczos", "-q:v", "3", "-y", out,
      ]);
      frames.push({ at_sec: times[i]!, bytes: new Uint8Array(await readFile(out)), media_type: "image/jpeg" });
    }
    return frames;
  });
}

/** Extract the exact source segment selected by the multimodal judge. */
export async function extractVideoSegment(
  video: Uint8Array,
  startSec: number,
  endSec: number,
): Promise<Uint8Array> {
  if (!(endSec > startSec)) throw new Error("extractVideoSegment requires endSec > startSec");
  return withVideo(video, async (input, dir) => {
    const out = path.join(dir, "segment.mp4");
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-ss", startSec.toFixed(3), "-i", input,
      "-t", (endSec - startSec).toFixed(3),
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-y", out,
    ]);
    return new Uint8Array(await readFile(out));
  });
}

/**
 * Candidate windows cover the whole clip instead of judging one arbitrary
 * thumbnail. Adjacent windows overlap enough to identify a strong action inside
 * a longer source clip, while keeping the search bounded.
 */
export function candidateWindows(sourceDurationSec: number, beatDurationSec: number, maxWindows = 6): Array<{ start: number; end: number }> {
  if (!(sourceDurationSec > 0) || !(beatDurationSec > 0)) return [];
  const length = Math.min(sourceDurationSec, Math.max(beatDurationSec, 2.5));
  if (sourceDurationSec <= length + 0.1) return [{ start: 0, end: sourceDurationSec }];
  const count = Math.max(2, Math.min(maxWindows, Math.ceil(sourceDurationSec / Math.max(length * 0.65, 1))));
  const lastStart = sourceDurationSec - length;
  return Array.from({ length: count }, (_, i) => {
    const start = count === 1 ? 0 : lastStart * (i / (count - 1));
    return { start: Number(start.toFixed(3)), end: Number((start + length).toFixed(3)) };
  });
}
