import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runMedia } from "./exec-bounded.ts";
import { probeVideoDuration } from "./video-analysis.ts";
import type { QaImage } from "../visual-beat-qa.ts";

export interface TimedFrame extends QaImage {
  /** The timestamp these pixels were actually decoded from. */
  at_sec: number;
  /** The timestamp the caller asked for, before clamping to the real duration. */
  requested_sec: number;
  /**
   * False when no frame could be produced for this timestamp. `bytes` is then
   * empty and the frame must NOT be scored — it is a QA-availability failure,
   * not visual evidence.
   */
  ok: boolean;
}

/**
 * How far earlier than the requested timestamp we will accept a frame.
 *
 * ffmpeg's `-ss` seek can land a frame or two off, and the timeline's declared
 * duration and the encoded duration routinely differ by that much. 150ms is
 * ~4 frames at 30fps: honest seek jitter within the same shot. Anything beyond
 * it is a different moment of the video, and reporting it as the requested
 * timestamp would be a lie the QA gate cannot detect.
 */
const SEEK_TOLERANCE_SEC = 0.15;

/**
 * Extract specific frames from a rendered MP4, writing the source only once.
 *
 * Honesty rule: a frame is either the pixels at (approximately) the requested
 * timestamp, or it is `ok:false`. The previous version fell back through
 * -0.4s and -1.0s offsets and, failing that, silently reused the PREVIOUS
 * frame's bytes while still reporting the requested `at_sec` — so a beat could
 * be scored on a neighbouring beat's pixels and nothing downstream could tell.
 * That turns an infrastructure failure into fabricated visual evidence, in
 * both directions: a good beat scored on a bad neighbour's frame, or a bad
 * beat scored on a good one's.
 */
export async function sampleRenderedFrames(
  video: Uint8Array,
  timesSec: number[],
): Promise<TimedFrame[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-render-qa-"));
  const input = path.join(dir, "render.mp4");
  try {
    await writeFile(input, video);

    let duration = 0;
    try { duration = await probeVideoDuration(video); } catch { /* fall back to raw times */ }
    // Clamping to the real encoded end is not a substitution: the last frame
    // IS the video at that point. It is recorded in `at_sec` either way.
    const cap = duration > 0.2 ? duration - 0.08 : Number.POSITIVE_INFINITY;

    const output: TimedFrame[] = [];
    for (let i = 0; i < timesSec.length; i++) {
      const requested = timesSec[i]!;
      const clamped = Math.min(Math.max(0, requested), cap);
      const target = path.join(dir, `frame-${String(i).padStart(4, "0")}.jpg`);
      let bytes: Uint8Array | null = null;
      let at = clamped;

      for (const attempt of [clamped, Math.max(0, clamped - 0.08), Math.max(0, clamped - SEEK_TOLERANCE_SEC)]) {
        try {
          await runMedia("ffmpeg", [
            "-hide_banner", "-loglevel", "error",
            "-ss", attempt.toFixed(3), "-i", input,
            "-frames:v", "1", "-vf", "scale=960:-2:flags=lanczos", "-q:v", "3", "-y", target,
          ]);
          if (existsSync(target)) {
            bytes = new Uint8Array(await readFile(target));
            at = attempt;
            break;
          }
        } catch { /* try one frame earlier, within tolerance */ }
      }

      output.push(bytes
        ? { at_sec: Number(at.toFixed(3)), requested_sec: requested, bytes, media_type: "image/jpeg", ok: true }
        : { at_sec: Number(clamped.toFixed(3)), requested_sec: requested, bytes: new Uint8Array(), media_type: "image/jpeg", ok: false });
    }
    return output;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A beat's frames are usable only when every one of them was really decoded.
 * Scoring a partial group means scoring the beat on fewer/other pixels than
 * the caller believes, so the whole group is treated as unavailable instead.
 */
export function framesUsable(frames: TimedFrame[]): boolean {
  return frames.length > 0 && frames.every((frame) => frame.ok && frame.bytes.byteLength > 0);
}
