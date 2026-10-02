/**
 * Run ffmpeg on bytes via a throwaway temp folder: write the input, run,
 * read the output, always clean up. Shared by the Reels re-encode
 * (reel-public-video.ts) and the beat-image frame crop (beat-images.ts).
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export function ffmpegBinary(): string {
  return process.env["FFMPEG_PATH"] || "ffmpeg";
}

export async function ffmpegTransform(input: Uint8Array, opts: {
  /** Input and output file names; their extensions tell ffmpeg the formats. */
  inName: string;
  outName: string;
  args: (input: string, output: string) => string[];
  timeoutMs: number;
  ffmpeg?: string;
}): Promise<Uint8Array> {
  const dir = await mkdtemp(path.join(tmpdir(), "ffmpeg-"));
  try {
    const inPath = path.join(dir, opts.inName), outPath = path.join(dir, opts.outName);
    await writeFile(inPath, input);
    await run(opts.ffmpeg ?? ffmpegBinary(), opts.args(inPath, outPath), { timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return new Uint8Array(await readFile(outPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether ffmpeg can be started at all -- checked before paying for work that needs it. */
export async function ffmpegAvailable(ffmpeg = ffmpegBinary()): Promise<boolean> {
  try {
    await run(ffmpeg, ["-version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
