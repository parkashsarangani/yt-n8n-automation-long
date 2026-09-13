/** HTTP client for the audio-first long-compose service. */
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
  pollIntervalSec?: number;
  timeoutSec?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

interface ComposeStatus {
  status: "processing" | "done" | "failed" | "not_found";
  success?: boolean;
  output_path?: string;
  thumbnail_path?: string;
  duration_sec?: number;
  render_time_sec?: number;
  error?: string;
}

interface ThumbnailResponse {
  success?: boolean;
  image_base64?: string;
  media_type?: string;
  width?: number;
  height?: number;
  background?: "supplied" | "gradient";
  error?: string;
}

type ContinuationRenderRequest = RenderRequest & { outro_line?: string };
export interface DiagnosticThumbnailResult extends ThumbnailResult { degradation_reason?: string }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

  async renderThumbnail(req: ThumbnailRequest): Promise<DiagnosticThumbnailResult> {
    try {
      return await this.renderThumbnailOnce(req, req.image);
    } catch (first) {
      if (!req.image) throw first;
      const firstMessage = first instanceof Error ? first.message : String(first);
      const result = await this.renderThumbnailOnce(req, undefined);
      console.warn(`[long-compose] thumbnail artwork failed; using generated background: ${firstMessage}`);
      return { ...result, degradation_reason: firstMessage };
    }
  }

  private async renderThumbnailOnce(req: ThumbnailRequest, image: Uint8Array | undefined): Promise<ThumbnailResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/thumbnail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_base64: image ? toBase64(image) : null,
        text: req.text,
        emphasis: req.emphasis ?? null,
        accent: req.accent ?? null,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new ProviderError(`thumbnail render failed (${res.status}): ${diagnosticText(text)}`);
    let body: ThumbnailResponse;
    try { body = JSON.parse(text) as ThumbnailResponse; }
    catch { throw new ProviderError(`thumbnail render returned non-JSON: ${diagnosticText(text)}`); }
    if (!body.success || !body.image_base64) throw new ProviderError(`thumbnail render failed: ${body.error ?? "no image returned"}`);
    return {
      bytes: fromBase64(body.image_base64),
      media_type: body.media_type ?? "image/png",
      width: body.width ?? 1280,
      height: body.height ?? 720,
      background: body.background === "supplied" ? "supplied" : "gradient",
      usage: { input_tokens: 0, output_tokens: 0, units: 1, cost_usd: 0, provider: "long-compose", model: "ffmpeg-thumbnail" },
    };
  }

  async render(
    req: RenderRequest,
    opts: { onJob?: (jobId: string) => void | Promise<void>; signal?: AbortSignal } = {},
  ): Promise<RenderResult> {
    const continuation = req as ContinuationRenderRequest;
    const body = {
      caption_style: req.caption_style ?? "neutral",
      ...(req.background_image ? { image_base64: toBase64(req.background_image) } : {}),
      ...(req.lesson_title ? { lesson_title: req.lesson_title } : {}),
      ...(continuation.outro_line?.trim() ? { outro_line: continuation.outro_line.trim() } : {}),
      data: req.scenes.map((scene) => ({
        scene_index: scene.scene_index,
        ...(scene.narration ? { narration: scene.narration } : {}),
        ...(scene.point ? { point: scene.point } : {}),
        ...(scene.visual ? { visual: scene.visual } : {}),
        audio: {
          audio_base64: toBase64(scene.audio),
          media_type: scene.audio_media_type,
          ...(scene.alignment !== undefined ? { alignment: scene.alignment } : {}),
        },
        ...(scene.is_outro ? { is_outro: true } : {}),
      })),
    };

    const submitted = await this.post("/compose", body);
    const jobId = (submitted as { job_id?: string }).job_id;
    if (!jobId) throw new ProviderError(`${this.id} did not return a job_id`);
    if (opts.onJob) await opts.onJob(jobId);

    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (opts.signal?.aborted) throw new ProviderError(`${this.id} render aborted (job ${jobId})`);
      if (Date.now() > deadline) throw new ProviderError(`${this.id} job ${jobId} timed out`);
      await this.sleepImpl(this.pollIntervalMs);
      const status = (await this.get(`/compose-status/${jobId}`)) as ComposeStatus;
      if (status.status === "processing") continue;
      if (status.status !== "done" || status.success === false) {
        throw new ProviderError(`${this.id} job ${jobId} failed: ${status.error ?? status.status}`);
      }
      if (!status.output_path) throw new ProviderError(`${this.id} job ${jobId} completed without output_path`);
      const video = await this.download(status.output_path);
      return {
        video,
        media_type: "video/mp4",
        ...(status.duration_sec !== undefined ? { duration_sec: status.duration_sec } : {}),
        ...(status.render_time_sec !== undefined ? { render_time_sec: status.render_time_sec } : {}),
        degraded_scenes: 0,
        usage: { input_tokens: 0, output_tokens: 0, units: status.render_time_sec ?? null, cost_usd: 0, provider: "long-compose", model: "ffmpeg-audio-first" },
      };
    }
  }

  private async download(outputPath: string): Promise<Uint8Array> {
    const name = outputPath.split("/").pop();
    if (!name) throw new ProviderError(`${this.id} returned an unusable path: ${outputPath}`);
    const res = await this.fetchImpl(`${this.baseUrl}/outputs/${name}`);
    if (!res.ok) throw new ProviderError(`${this.id} download of ${name} failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async post(pathname: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new ProviderError(`${this.id} POST ${pathname} returned ${res.status}: ${diagnosticText(await res.text())}`);
    return res.json();
  }

  private async get(pathname: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`);
    const text = await res.text();
    try { return JSON.parse(text) as unknown; }
    catch { throw new ProviderError(`${this.id} GET ${pathname} returned ${res.status}: ${diagnosticText(text)}`); }
  }
}

function diagnosticText(text: string, limit = 800): string {
  const clean = text.trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}
function toBase64(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64"); }
function fromBase64(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
