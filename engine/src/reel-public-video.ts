/**
 * A temporarily public, Reels-safe copy of a Short, for Instagram -- which
 * only publishes a video it downloads from a public URL (see meta-reels.ts).
 * Verified live 2026-09-30: re-encode -> public Drive file -> Instagram
 * FINISHED -> published -> file deleted.
 *
 * Re-encode: editor cuts arrive as HEVC in a QuickTime container, variable
 * frame rate, index (moov) at the END. Instagram's spec wants 23-60 fps and
 * the index first, so every copy is normalised to H.264 High, constant
 * 30 fps, AAC-LC 48 kHz, +faststart, keeping 1080x1920.
 *
 * Hosting: the engine's own Google Drive (no new service or public
 * endpoint). The file lives in a `_public-reels-tmp` folder, is shared
 * "anyone with the link" only for the few minutes Instagram needs, then
 * deleted. A crash between share and delete is covered by a sweep that
 * deletes leftovers older than STALE_AFTER_MS on every publish.
 */

import type { PublicVideo } from "./crosspost.ts";
import { ffmpegTransform } from "./ffmpeg-file.ts";

export const PUBLIC_REELS_FOLDER = "_public-reels-tmp";
export const STALE_AFTER_MS = 2 * 3600_000;
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** ffmpeg arguments for the Reels-safe re-encode. */
export function reelEncodeArgs(input: string, output: string): string[] {
  return [
    "-v", "error", "-y", "-i", input,
    "-c:v", "libx264", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "19",
    "-fps_mode", "cfr", "-r", "30",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    output,
  ];
}

export async function reelSafeMp4(video: Uint8Array, ffmpeg?: string): Promise<Uint8Array> {
  return ffmpegTransform(video, { inName: "in.mp4", outName: "reel.mp4", args: reelEncodeArgs, timeoutMs: 600_000, ...(ffmpeg ? { ffmpeg } : {}) });
}

export interface DrivePublicVideoOptions {
  token: () => Promise<string>;
  /** The Drive folder the temporary folder is created under. */
  parentFolderId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Temporarily public video files on the engine's Google Drive. */
export class DrivePublicVideoHost {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private folderId: string | undefined;

  constructor(private readonly opts: DrivePublicVideoOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(300_000),
      headers: { Authorization: `Bearer ${await this.opts.token()}`, ...(init.headers as Record<string, string> | undefined) },
    });
    if (!res.ok && res.status !== 404) throw new Error(`drive ${init.method ?? "GET"} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  private async folder(): Promise<string> {
    if (this.folderId) return this.folderId;
    const q = `name = '${PUBLIC_REELS_FOLDER}' and mimeType = '${FOLDER_MIME}' and '${this.opts.parentFolderId}' in parents and trashed = false`;
    const found = (await (await this.call(`https://www.googleapis.com/drive/v3/files?fields=files(id)&q=${encodeURIComponent(q)}`)).json()) as { files?: Array<{ id: string }> };
    this.folderId = found.files?.[0]?.id ?? ((await (await this.call("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: PUBLIC_REELS_FOLDER, mimeType: FOLDER_MIME, parents: [this.opts.parentFolderId] }),
    })).json()) as { id: string }).id;
    return this.folderId;
  }

  private async remove(fileId: string): Promise<void> {
    await this.call(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: "DELETE" });
  }

  /** Delete leftovers a crash may have left public. */
  async sweep(): Promise<number> {
    const folderId = await this.folder();
    const q = `'${folderId}' in parents and trashed = false`;
    const list = (await (await this.call(`https://www.googleapis.com/drive/v3/files?fields=files(id,createdTime)&q=${encodeURIComponent(q)}`)).json()) as { files?: Array<{ id: string; createdTime?: string }> };
    const stale = (list.files ?? []).filter((f) => !f.createdTime || this.now() - Date.parse(f.createdTime) > STALE_AFTER_MS);
    for (const f of stale) await this.remove(f.id);
    return stale.length;
  }

  async publish(name: string, video: Uint8Array): Promise<PublicVideo> {
    await this.sweep().catch(() => 0);
    const folderId = await this.folder();
    const boundary = `reel-${this.now()}-${Math.random().toString(36).slice(2)}`;
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`;
    const uploaded = (await (await this.call("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: new Blob([head, video, `\r\n--${boundary}--`]),
    })).json()) as { id?: string };
    if (!uploaded.id) throw new Error("drive upload returned no id");
    const release = () => this.remove(uploaded.id!);
    try {
      await this.call(`https://www.googleapis.com/drive/v3/files/${uploaded.id}/permissions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "reader", type: "anyone" }),
      });
    } catch (err) {
      await release().catch(() => {});
      throw err;
    }
    return { url: `https://drive.usercontent.google.com/download?id=${uploaded.id}&export=download&confirm=t`, release };
  }
}
