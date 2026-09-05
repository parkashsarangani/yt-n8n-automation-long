import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { QaImage } from "../visual-beat-qa.ts";

const execFileAsync = promisify(execFile);

export interface TimedFrame extends QaImage { at_sec: number }

/** Extract many specific frames while writing the source MP4 only once. */
export async function sampleRenderedFrames(
  video: Uint8Array,
  timesSec: number[],
): Promise<TimedFrame[]> {
  const clean = timesSec.map((time) => Math.max(0, time));
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-render-qa-"));
  const input = path.join(dir, "render.mp4");
  try {
    await writeFile(input, video);
    const output: TimedFrame[] = [];
    for (let i = 0; i < clean.length; i++) {
      const target = path.join(dir, `frame-${String(i).padStart(4, "0")}.jpg`);
      await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-ss", clean[i]!.toFixed(3), "-i", input,
        "-frames:v", "1", "-vf", "scale=960:-2:flags=lanczos", "-q:v", "3", "-y", target,
      ]);
      output.push({
        at_sec: clean[i]!,
        bytes: new Uint8Array(await readFile(target)),
        media_type: "image/jpeg",
      });
    }
    return output;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
