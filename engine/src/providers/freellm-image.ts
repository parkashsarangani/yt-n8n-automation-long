/**
 * Free-first image generation through the shared FreeLLMAPI media gateway.
 *
 * FreeLLMAPI owns every upstream provider credential (Cloudflare, Pollinations,
 * NVIDIA, SiliconFlow, ...). This client only knows the gateway URL, the
 * unified key, and an explicit ordered list of concrete image model ids
 * (`FREELLMAPI_IMAGE_MODELS`). For each id it calls the OpenAI-compatible
 * `POST /v1/images/generations` and advances to the next id on an availability
 * failure. A gateway-wide auth failure (the unified key itself is bad) stops
 * the chain — retrying other models with the same broken credential is
 * pointless and hides a config error.
 *
 * Cost is always $0: these are the free routes. When they are all exhausted the
 * caller decides whether `PAID_IMAGE_FALLBACK` permits paid fal generation.
 */

import { ProviderError, type Aspect, type ImageProvider, type Usage } from "../provider.ts";
import {
  freeImagePrompt,
  FreeMediaTerminalError,
  isDailyFreeImageCapacityMessage,
} from "../free-media-policy.ts";
import { freeLlmMediaBaseUrl, resolveFreeImageModels } from "../freellm-media-models.ts";

const SIZES: Record<Aspect, string> = { "9:16": "1024x1792", "16:9": "1792x1024", "1:1": "1024x1024" };
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

interface GenImage { bytes: Uint8Array; media_type: string }

interface FreeLlmImageResponse {
  data?: Array<{ b64_json?: string | null; url?: string | null }>;
  model?: string;
  provider?: string;
}

export interface FreeLlmImageOptions {
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Best-effort format sniff. Returns null when the bytes are not a known image. */
function sniffImageMediaType(bytes: Uint8Array): string | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  return null;
}

/** A media-availability failure means "try the next model". */
function isRetryableModelFailure(status: number): boolean {
  return status === 404 || status === 408 || status === 409 || status === 413 || status === 429 || status >= 500;
}

/** The unified FreeLLMAPI key itself is rejected — a config error, not a model outage. */
function isGatewayAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

export class FreeLlmImageProvider implements ImageProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly models: string[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FreeLlmImageOptions = {}) {
    const key = opts.apiKey ?? process.env["FREELLMAPI_API_KEY"];
    if (!key?.trim()) throw new ProviderError("FreeLlmImageProvider needs FREELLMAPI_API_KEY");
    this.apiKey = key.trim();
    this.baseUrl = (opts.baseUrl ?? freeLlmMediaBaseUrl()).replace(/\/+$/, "");
    this.models = opts.models ?? resolveFreeImageModels();
    if (this.models.length === 0) {
      throw new ProviderError("FreeLlmImageProvider needs at least one FREELLMAPI_IMAGE_MODELS id");
    }
    const raw = Number(opts.timeoutMs ?? process.env["FREELLMAPI_MEDIA_TIMEOUT_MS"] ?? 60_000);
    this.timeoutMs = Number.isFinite(raw) && raw >= 5_000 ? raw : 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.id = `freellmapi-image/[${this.models.join(",")}]`;
  }

  private async decodeImage(item: { b64_json?: string | null; url?: string | null }): Promise<GenImage> {
    if (item.b64_json) {
      const bytes = new Uint8Array(Buffer.from(item.b64_json, "base64"));
      const media = sniffImageMediaType(bytes);
      if (!media || bytes.length < 128) throw new ProviderError("free image payload is not a recognizable image");
      return { bytes, media_type: media };
    }
    if (item.url) {
      // No SSRF-guard utility exists in this package, so the URL fetch is
      // deliberately narrow: https only, no private/loopback literals, bounded
      // size, magic-byte validated.
      const parsed = new URL(item.url);
      if (parsed.protocol !== "https:") throw new ProviderError("free image url must be https");
      if (/^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(parsed.hostname)) {
        throw new ProviderError("free image url resolves to a disallowed host");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(parsed.toString(), { signal: controller.signal });
        if (!res.ok) throw new ProviderError(`free image download failed (${res.status})`);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) throw new ProviderError("free image download was empty or too large");
        const media = sniffImageMediaType(buf);
        if (!media) throw new ProviderError("free image download is not a recognizable image");
        return { bytes: buf, media_type: media };
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ProviderError("free image response item had neither b64_json nor url");
  }

  private async requestModel(model: string, prompt: string, aspect: Aspect, count: number): Promise<{ images: GenImage[]; provider: string; model: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: freeImagePrompt(prompt),
          n: Math.max(1, Math.min(4, count)),
          size: SIZES[aspect],
          response_format: "b64_json",
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderError(`freellmapi-image/${model} request failed: ${err instanceof Error ? err.name : "network error"}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      if (isGatewayAuthFailure(res.status)) {
        throw new FreeMediaTerminalError(`freellmapi media gateway rejected the unified key (${res.status}): ${body}`);
      }
      if (isDailyFreeImageCapacityMessage(body)) {
        throw new FreeMediaTerminalError(`freellmapi-image/${model} daily free allocation exhausted: ${body}`);
      }
      if (isRetryableModelFailure(res.status)) {
        throw new ProviderError(`freellmapi-image/${model} unavailable (${res.status}): ${body}`);
      }
      throw new ProviderError(`freellmapi-image/${model} returned ${res.status}: ${body}`);
    }

    const json = (await res.json()) as FreeLlmImageResponse;
    const items = (json.data ?? []).filter((i) => i.b64_json || i.url);
    if (items.length === 0) throw new ProviderError(`freellmapi-image/${model} returned no usable image`);
    const images: GenImage[] = [];
    for (const item of items.slice(0, count)) images.push(await this.decodeImage(item));
    return {
      images,
      provider: typeof json.provider === "string" && json.provider.trim() ? json.provider.trim() : "freellmapi",
      model: typeof json.model === "string" && json.model.trim() ? json.model.trim() : model,
    };
  }

  async generate(req: { prompt: string; aspect: Aspect; count?: number; tier?: "hero" | "standard" }): Promise<{ images: GenImage[]; usage: Usage }> {
    const count = Math.max(1, Math.min(4, req.count ?? 1));
    const attempted: string[] = [];
    let lastError: unknown;
    for (const model of this.models) {
      try {
        const out = await this.requestModel(model, req.prompt, req.aspect, count);
        return {
          images: out.images,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            units: out.images.length,
            cost_usd: 0,
            provider: "freellmapi",
            // provider/model provenance: gateway abstraction + routed upstream.
            model: `${out.provider}/${out.model}`,
          },
        };
      } catch (err) {
        // A bad unified key or an exhausted hard daily ceiling is terminal —
        // do not keep hammering other models with the same broken condition.
        if (err instanceof FreeMediaTerminalError) throw err;
        attempted.push(model);
        lastError = err;
        console.warn(`[freellm-media] free image model ${model} unavailable; trying next configured model`);
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new ProviderError(
      `all ${attempted.length} configured free image model(s) unavailable [${attempted.join(", ")}]: ${detail}`,
    );
  }
}
