import { runMedia } from "./exec-bounded.ts";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";


import type { QaImage } from "../visual-beat-qa.ts";



/**
 * Vision QA sends candidate frames to a multimodal model as base64 data URIs.
 * A raw fal.ai still is ~1792x1024 PNG, ~1-3 MB; two of them (candidate +
 * continuity reference) is a 5-8 MB request that the shared vision route and
 * the direct OpenAI fallback both reject / drop ("fetch failed") from inside
 * the isolated benchmark container, and that pointlessly slows every call.
 *
 * Downscale to 960px JPEG (the same size the video/render frame samplers
 * already produce) before it ever reaches a vision model. `detail: "low"` on
 * the request is a model hint; this actually shrinks the bytes on the wire.
 *
 * Results are memoised by content hash for the run: the previous/continuity
 * image is reused across many beats and must only be transcoded once.
 */

const MAX_WIDTH = 960;
const cache = new Map<string, QaImage>();

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function prepareVisionImage(image: QaImage): Promise<QaImage> {
  // Too small to be a real still worth transcoding (covers test fixtures).
  if (image.bytes.byteLength < 2_048) return image;
  // Frame samplers already emit small JPEGs; skip those.
  if (image.media_type === "image/jpeg" && image.bytes.byteLength <= 220_000) return image;

  const key = sha(image.bytes);
  const hit = cache.get(key);
  if (hit) return hit;

  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-vision-img-"));
  const input = path.join(dir, "in");
  const output = path.join(dir, "out.jpg");
  try {
    await writeFile(input, image.bytes);
    await runMedia("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", input,
      "-vf", `scale='min(${MAX_WIDTH},iw)':-2:flags=lanczos`,
      "-q:v", "4", "-y", output,
    ]);
    const result: QaImage = { bytes: new Uint8Array(await readFile(output)), media_type: "image/jpeg" };
    cache.set(key, result);
    return result;
  } catch {
    // ffmpeg missing or a non-image blob: fall back to the original bytes
    // rather than dropping QA entirely.
    return image;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function prepareVisionImages(images: QaImage[]): Promise<QaImage[]> {
  return Promise.all(images.map(prepareVisionImage));
}

/** Test hook. */
export function _clearVisionImageCache(): void {
  cache.clear();
}
