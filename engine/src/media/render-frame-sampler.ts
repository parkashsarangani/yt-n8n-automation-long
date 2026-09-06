import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runMedia } from "./exec-bounded.ts";
import { probeVideoDuration } from "./video-analysis.ts";
import type { QaImage } from "../visual-beat-qa.ts";

export interface TimedFrame extends QaImage { at_sec: number }

/**
 * Extract many specific frames while writing the source MP4 only once.
 *
 * Robust against a requested timestamp landing at/after the real end of the
 * clip (the timeline's declared duration and the actual encoded duration can
 * differ by a frame or two): times are clamped to the probed duration, a
 * failed extraction retries slightly earlier, and a frame that still cannot be
 * produced reuses the previous one rather than aborting the whole QA pass.
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
    const cap = duration > 0.2 ? duration - 0.08 : Number.POSITIVE_INFINITY;
    const clean = timesSec.map((time) => Math.min(Math.max(0, time), cap));

    const output: TimedFrame[] = [];
    for (let i = 0; i < clean.length; i++) {
      const target = path.join(dir, `frame-${String(i).padStart(4, "0")}.jpg`);
      let bytes: Uint8Array | null = null;
      for (const at of [clean[i]!, Math.max(0, clean[i]! - 0.4), Math.max(0, clean[i]! - 1)]) {
        try {
          await runMedia("ffmpeg", [
            "-hide_banner", "-loglevel", "error",
            "-ss", at.toFixed(3), "-i", input,
            "-frames:v", "1", "-vf", "scale=960:-2:flags=lanczos", "-q:v", "3", "-y", target,
          ]);
          if (existsSync(target)) { bytes = new Uint8Array(await readFile(target)); break; }
        } catch { /* try an earlier offset */ }
      }
      if (!bytes) bytes = output[output.length - 1]?.bytes ?? new Uint8Array();
      output.push({ at_sec: clean[i]!, bytes, media_type: "image/jpeg" });
    }
    return output;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
