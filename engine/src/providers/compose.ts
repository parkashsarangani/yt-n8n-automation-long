/**
 * long-compose media renderer (RFC 0004).
 *
 * Wraps the existing FFmpeg/Remotion service. It is an async job service —
 * POST /compose returns a job id immediately (which is how the original
 * pipeline dodged Cloudflare's proxy timeout), then the caller polls
 * /compose-status until done.
 *
 * ANSWER TO RFC 0004'S OPEN QUESTION: polling stays an implementation detail
 * (the promise resolves when the video is ready), but the job id is surfaced
 * through `onJob` the moment it exists. Hiding the job entirely would make a
 * crashed twenty-minute render unrecoverable and untraceable; putting polling
 * in the interface would leak this service's shape into every caller.
 *
 * NOT YET RUN AGAINST THE REAL SERVICE.
 */

import {
  ProviderError,
  type MediaRenderer,
  type RenderRequest,
  type RenderResult,
  type ThumbnailRequest,
  type ThumbnailResult,
} from "../provider.ts";

export interface ComposeRendererOptions {
  baseUrl: string;
  /** Seconds between polls. The original pipeline used 8s for shorts, 15s long-form. */
  pollIntervalSec?: number;
  /** Give up after this long. A 10-minute video renders in well under 30 min. */
  timeoutSec?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

interface ComposeStatus {
  status: "processing" | "done" | "failed" | "not_found";
  success?: boolean;
  output_path?: string;
  thumbnail_path?: string;
  render_time_sec?: number;
  degraded_scenes?: number;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ComposeRenderer implements MediaRenderer {
  readonly id = "long-compose";
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(opts: ComposeRendererOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.pollIntervalMs = (opts.pollIntervalSec ?? 15) * 1000;
    this.timeoutMs = (opts.timeoutSec ?? 3600) * 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? sleep;
  }

  /**
   * Synchronous, unlike render(): compositing a still is fast enough that a job
   * store and polling would be pure overhead.
   */
  async renderThumbnail(req: ThumbnailRequest): Promise<ThumbnailResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/thumbnail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_base64: req.image ? toBase64(req.image) : null,
        text: req.text,
        accent: req.accent ?? null,
      }),
    });

    if (!res.ok) {
      throw new ProviderError(
        `thumbnail render failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
      );
    }

    const body = (await res.json()) as {
      success?: boolean;
      image_base64?: string;
      media_type?: string;
      width?: number;
      height?: number;
      background?: "supplied" | "gradient";
      error?: string;
    };
    if (!body.success || !body.image_base64) {
      throw new ProviderError(`thumbnail render failed: ${body.error ?? "no image returned"}`);
    }

    return {
      bytes: fromBase64(body.image_base64),
      media_type: body.media_type ?? "image/png",
      width: body.width ?? 1280,
      height: body.height ?? 720,
      background: body.background === "supplied" ? "supplied" : "gradient",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units: 1,
        cost_usd: 0, // self-hosted
        provider: "long-compose",
        model: "ffmpeg-thumbnail",
      },
    };
  }

  async render(
    req: RenderRequest,
    opts: { onJob?: (jobId: string) => void | Promise<void>; signal?: AbortSignal } = {},
  ): Promise<RenderResult> {
    const body = {
      caption_style: req.caption_style ?? "neutral",
      comment_hook: req.comment_hook ?? null,
      ...(req.thumbnail
        ? {
          thumbnail: {
            image_base64: req.thumbnail.image ? toBase64(req.thumbnail.image) : null,
            text: req.thumbnail.text ?? null,
            accent: req.thumbnail.accent ?? null,
          },
        }
        : {}),
      data: req.scenes.map((s) => ({
        scene_index: s.scene_index,
        // The service accepts base64 audio; it already handled ~50 clips this
        // way in the predecessor pipeline (its JSON limit is 50mb).
        audio: {
          audio_base64: toBase64(s.audio),
          ...(s.alignment !== undefined ? { alignment: s.alignment } : {}),
        },
        ...(s.image
          ? { images_base64: [toBase64(s.image)] }
          : { _degraded: true }), // no image: renderer substitutes a placeholder
        ...(s.is_outro ? { visual_source: "template", template_name: "kinetic_text" } : {}),
        // Template scenes: tell long-compose to render via Remotion
        ...(s.template_category && !s.is_outro ? {
          visual_source: "template",
          template_name: s.template_category,
          template_data: s.template_data ?? {},
        } : {}),
      })),
    };

    const submitted = await this.post("/compose", body);
    const jobId = (submitted as { job_id?: string }).job_id;
    if (!jobId) throw new ProviderError(`${this.id} did not return a job_id`);
    if (opts.onJob) await opts.onJob(jobId);

    const deadline = Date.now() + this.timeoutMs;
    for (; ;) {
      if (opts.signal?.aborted) throw new ProviderError(`${this.id} render aborted (job ${jobId})`);
      if (Date.now() > deadline) {
        throw new ProviderError(
          `${this.id} job ${jobId} did not finish within ${this.timeoutMs / 1000}s`,
        );
      }
      await this.sleepImpl(this.pollIntervalMs);

      const status = (await this.get(`/compose-status/${jobId}`)) as ComposeStatus;
      if (status.status === "processing") continue;
      if (status.status !== "done" || status.success === false) {
        throw new ProviderError(
          `${this.id} job ${jobId} failed: ${status.error ?? status.status}`,
        );
      }
      if (!status.output_path) {
        throw new ProviderError(`${this.id} job ${jobId} reported done with no output_path`);
      }

      const video = await this.download(status.output_path);
      const thumbnail = status.thumbnail_path
        ? {
          bytes: await this.download(status.thumbnail_path),
          media_type: "image/png",
        }
        : undefined;

      return {
        video,
        media_type: "video/mp4",
        ...(thumbnail ? { thumbnail } : {}),
        ...(status.render_time_sec !== undefined
          ? { render_time_sec: status.render_time_sec }
          : {}),
        ...(status.degraded_scenes !== undefined
          ? { degraded_scenes: status.degraded_scenes }
          : {}),
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          units: status.render_time_sec ?? null,
          cost_usd: 0, // self-hosted: the cost is wall clock, not a bill
          provider: "long-compose",
          model: "ffmpeg+remotion",
        },
      };
    }
  }

  /** `/app/outputs/x.mp4` is a container path; serve it over the /outputs route. */
  private async download(outputPath: string): Promise<Uint8Array> {
    const name = outputPath.split("/").pop();
    if (!name) throw new ProviderError(`${this.id} returned an unusable path: ${outputPath}`);
    const res = await this.fetchImpl(`${this.baseUrl}/outputs/${name}`);
    if (!res.ok) {
      throw new ProviderError(`${this.id} download of ${name} failed: ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  private async post(pathname: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new ProviderError(
        `${this.id} POST ${pathname} returned ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    return res.json();
  }

  private async get(pathname: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`);
    // The service returns 500 with a JSON body on a failed job; read it rather
    // than throwing on the status alone, so the real error survives.
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError(`${this.id} GET ${pathname} returned ${res.status}: ${text.slice(0, 300)}`);
    }
  }
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  // Zero-copy view: Buffer is a Uint8Array, but returning it directly would
  // leak a Node type through an interface that promises Uint8Array.
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
