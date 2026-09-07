import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Every ffmpeg/ffprobe call in the visual pipeline runs on a partially-trusted
 * input (a stock clip download, a fal still, a rendered mp4). A malformed or
 * truncated input can wedge ffmpeg indefinitely; an unattended benchmark/smoke
 * then hangs forever. All media subprocesses must go through this so they are
 * hard-killed on the deadline.
 */
const TIMEOUT_MS = (() => {
  const raw = Number(process.env["FFMPEG_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw >= 5_000 ? raw : 90_000;
})();

export async function runMedia(
  cmd: "ffmpeg" | "ffprobe",
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, {
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
}
