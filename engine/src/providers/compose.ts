/**
 * long-compose media renderer (RFC 0004).
 *
 * Wraps the async FFmpeg/Remotion service. POST /compose returns a job id;
 * polling remains an implementation detail while onJob exposes recoverable job
 * identity to the engine immediately.
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
  pollIntervalSec?: number;
  timeoutSec?: number;
  outroLine?: string;
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

interface ThumbnailResponse {
  success?: boolean;
  image_base64?: string;
  media_type?: string;
  width?: number;
  height?: number;
  background?: "supplied" | "gradient";
  error?: string;
}

type HybridScene = RenderRequest["scenes"][number] & {
  images?: Uint8Array[];
  visual_mode?: "motion_graphic" | "ai_broll";
  continuity_group?: string;
  shot_types?: string[];
};

export interface DiagnosticThumbnailResult extends ThumbnailResult {
  degradation_reason?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * long-compose's historic `explanation` category deliberately whitelists
 * renderer props instead of spreading arbitrary template_data. Keep that
 * boundary: it owns Rhubarb lip-sync, explanation audio handling, SFX and
 * mix shaping. Semantic representation arrived later, so carry the new fields
 * through one reserved renderer-extension envelope inside `entityIcons`, an
 * object the bridge already passes intact. Remotion unwraps the envelope and
 * never presents it to icon lookup. This is preferable to switching semantic
 * scenes to a literal composition ID, which would silently bypass all of the
 * explanation-specific production behavior above.
 */
export const SEMANTIC_RENDER_EXTENSION_KEY = "__semanticRepresentationV1";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function bridgeSemanticTemplateData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data || typeof data["representationMode"] !== "string") return data;
  const existingIcons = asRecord(data["entityIcons"]) ?? {};
  return {
    ...data,
    entityIcons: {
      ...existingIcons,
      [SEMANTIC_RENDER_EXTENSION_KEY]: {
        representationMode: data["representationMode"],
        sceneBlueprint: data["sceneBlueprint"],
        visualClaim: data["visualClaim"],
        semanticActionWindows: Array.isArray(data["semanticActionWindows"]) ? data["semanticActionWindows"] : [],
        semanticEntities: Array.isArray(data["semanticEntities"]) ? data["semanticEntities"] : [],
        semanticFallback: data["semanticFallback"] === true,
      },
    },
  };
}

function diagnosticText(text: string, limit = 1200): string {
  const clean = text.trim();
  if (clean.length <= limit) return clean;
  const head = Math.min(260, Math.floor(limit * 0.25));
  const tail = limit - head - 80;
  return `${clean.slice(0, head)} … [${clean.length - head - tail} chars omitted] … ${clean.slice(-tail)}`;
}

export class ComposeRenderer implements MediaRenderer {
  readonly id = "long-compose";
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly outroLine: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(opts: ComposeRendererOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.pollIntervalMs = (opts.pollIntervalSec ?? 15) * 1000;
    this.timeoutMs = (opts.timeoutSec ?? 3600) * 1000;
    this.outroLine = opts.outroLine ?? "What should we explain next? Subscribe.";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? sleep;
  }

  async renderThumbnail(req: ThumbnailRequest): Promise<DiagnosticThumbnailResult> {
    try {
      return await this.renderThumbnailOnce(req, req.image);
    } catch (first) {
      if (!req.image) throw first;
      const firstMessage = first instanceof Error ? first.message : String(first);
      try {
        const result = await this.renderThumbnailOnce(req, undefined);
        console.warn(`[long-compose] thumbnail artwork compositing failed, degraded to gradient: ${firstMessage}`);
        return { ...result, degradation_reason: firstMessage };
      } catch (second) {
        throw new ProviderError(
          `thumbnail render failed with supplied artwork and gradient fallback; artwork: ${firstMessage}; gradient: ${second instanceof Error ? second.message : String(second)}`,
        );
      }
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
    try {
      body = JSON.parse(text) as ThumbnailResponse;
    } catch {
      throw new ProviderError(`thumbnail render returned non-JSON (${res.status}): ${diagnosticText(text)}`);
    }
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
        cost_usd: 0,
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
      outro_line: this.outroLine,
      ...(req.thumbnail
        ? {
          thumbnail: {
            image_base64: req.thumbnail.image ? toBase64(req.thumbnail.image) : null,
            text: req.thumbnail.text ?? null,
            accent: req.thumbnail.accent ?? null,
          },
        }
        : {}),
      data: req.scenes.map((scene) => {
        const s = scene as HybridScene;
        const packedImages = s.images?.length ? s.images : s.image ? [s.image] : [];
        const bridgedTemplateData = s.template_category === "explanation"
          ? bridgeSemanticTemplateData(s.template_data)
          : s.template_data;
        return {
          scene_index: s.scene_index,
          audio: {
            audio_base64: toBase64(s.audio),
            ...(s.alignment !== undefined ? { alignment: s.alignment } : {}),
          },
          ...(s.video
            ? { video_base64: toBase64(s.video) }
            : packedImages.length
              ? { images_base64: packedImages.map(toBase64) }
              : { _degraded: true }),
          ...(s.is_outro ? { visual_source: "template", template_name: "kinetic_text" } : {}),
          ...(s.template_category && !s.is_outro ? {
            visual_source: "template",
            template_name: s.template_category,
            template_data: bridgedTemplateData ?? {},
          } : {}),
          ...(s.speaker_name ? { speaker_name: s.speaker_name, speaker_color: s.speaker_color } : {}),
          ...(s.visual_mode ? { visual_mode: s.visual_mode } : {}),
          ...(s.continuity_group ? { continuity_group: s.continuity_group } : {}),
          ...(s.shot_types ? { shot_types: s.shot_types } : {}),
        };
      }),
    };

    const submitted = await this.post("/compose", body);
    const jobId = (submitted as { job_id?: string }).job_id;
    if (!jobId) throw new ProviderError(`${this.id} did not return a job_id`);
    if (opts.onJob) await opts.onJob(jobId);

    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (opts.signal?.aborted) throw new ProviderError(`${this.id} render aborted (job ${jobId})`);
      if (Date.now() > deadline) {
        throw new ProviderError(`${this.id} job ${jobId} did not finish within ${this.timeoutMs / 1000}s`);
      }
      await this.sleepImpl(this.pollIntervalMs);
      const status = (await this.get(`/compose-status/${jobId}`)) as ComposeStatus;
      if (status.status === "processing") continue;
      if (status.status !== "done" || status.success === false) {
        throw new ProviderError(`${this.id} job ${jobId} failed: ${status.error ?? status.status}`);
      }
      if (!status.output_path) {
        throw new ProviderError(`${this.id} job ${jobId} reported done with no output_path`);
      }

      const video = await this.download(status.output_path);
      const thumbnail = status.thumbnail_path
        ? { bytes: await this.download(status.thumbnail_path), media_type: "image/png" }
        : undefined;
      return {
        video,
        media_type: "video/mp4",
        ...(thumbnail ? { thumbnail } : {}),
        ...(status.render_time_sec !== undefined ? { render_time_sec: status.render_time_sec } : {}),
        ...(status.degraded_scenes !== undefined ? { degraded_scenes: status.degraded_scenes } : {}),
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          units: status.render_time_sec ?? null,
          cost_usd: 0,
          provider: "long-compose",
          model: "ffmpeg+remotion",
        },
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
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new ProviderError(`${this.id} POST ${pathname} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
  }

  private async get(pathname: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathname}`);
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
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
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
