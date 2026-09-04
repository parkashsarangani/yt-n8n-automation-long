/**
 * Experimental FreeLLMAPI media providers.
 *
 * These reuse the same shared FreeLLMAPI instance already used for reasoning
 * and vision QA. They intentionally implement only the common ImageProvider /
 * SpeechProvider contracts. In particular, the image provider does not expose
 * Fal's reference-conditioned generatePack extension, so the experiment can be
 * compared honestly against the existing continuity-preserving Fal path.
 */

import { ProviderError, type Aspect, type ImageProvider, type SpeechProvider, type Usage } from "../provider.ts";

const IMAGE_SIZES: Record<Aspect, string> = {
  "16:9": "1792x1024",
  "9:16": "1024x1792",
  "1:1": "1024x1024",
};

function cleanBaseUrl(value: string | undefined): string {
  return (value?.trim() || "http://freellmapi:3001/v1").replace(/\/+$/, "");
}

function positiveTimeout(value: number | undefined, envValue: string | undefined): number {
  const parsed = value ?? Number(envValue || 120_000);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 120_000;
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export interface FreeLLMImageOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface FreeLLMImageResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  model?: string;
  provider?: string;
}

export class FreeLLMImageProvider implements ImageProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FreeLLMImageOptions = {}) {
    const key = opts.apiKey ?? process.env["FREELLMAPI_API_KEY"];
    if (!key?.trim()) throw new ProviderError("FreeLLMImageProvider needs FREELLMAPI_API_KEY");
    this.apiKey = key.trim();
    this.baseUrl = cleanBaseUrl(opts.baseUrl ?? process.env["FREELLMAPI_BASE_URL"]);
    // Pollinations `flux` is deliberately pinned for the experiment: it is
    // keyless behind FreeLLMAPI and honors width/height, unlike several free
    // adapters that currently force square output. Operators can override it.
    this.model = opts.model?.trim() || process.env["FREELLMAPI_IMAGE_MODEL"]?.trim() || "flux";
    this.timeoutMs = positiveTimeout(opts.timeoutMs, process.env["FREELLMAPI_MEDIA_TIMEOUT_MS"]);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.id = `freellmapi-image/${this.model}`;
  }

  async generate(req: { prompt: string; aspect: Aspect; count?: number }) {
    const count = Math.max(1, Math.min(4, req.count ?? 1));
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          prompt: req.prompt,
          n: count,
          size: IMAGE_SIZES[req.aspect],
          response_format: "b64_json",
        }),
        signal: timeoutSignal(this.timeoutMs),
      });
    } catch (err) {
      throw new ProviderError(`${this.id} request failed: ${String(err)}`);
    }
    if (!res.ok) {
      throw new ProviderError(`${this.id} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const body = (await res.json()) as FreeLLMImageResponse;
    const images: Array<{ bytes: Uint8Array; media_type: string }> = [];
    for (const item of body.data ?? []) {
      if (item.b64_json) {
        images.push({ bytes: Uint8Array.from(Buffer.from(item.b64_json, "base64")), media_type: "image/png" });
      } else if (item.url) {
        const dl = await this.fetchImpl(item.url, { signal: timeoutSignal(this.timeoutMs) });
        if (!dl.ok) throw new ProviderError(`${this.id} image download failed: ${dl.status}`);
        images.push({
          bytes: new Uint8Array(await dl.arrayBuffer()),
          media_type: dl.headers.get("content-type") || "image/png",
        });
      }
    }
    if (images.length === 0) throw new ProviderError(`${this.id} returned no images`);

    const actualModel = body.provider && body.model
      ? `${body.provider}/${body.model}`
      : body.model || body.provider || this.model;
    const usage: Usage = {
      input_tokens: 0,
      output_tokens: 0,
      units: images.length,
      cost_usd: 0,
      provider: "freellmapi",
      model: actualModel,
    };
    return { images, usage };
  }
}

export interface FreeLLMSpeechOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  format?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class FreeLLMSpeechProvider implements SpeechProvider {
  readonly id: string;
  readonly defaultVoice: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly format: "mp3";
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FreeLLMSpeechOptions = {}) {
    const key = opts.apiKey ?? process.env["FREELLMAPI_API_KEY"];
    if (!key?.trim()) throw new ProviderError("FreeLLMSpeechProvider needs FREELLMAPI_API_KEY");
    this.apiKey = key.trim();
    this.baseUrl = cleanBaseUrl(opts.baseUrl ?? process.env["FREELLMAPI_BASE_URL"]);
    // Pin one model for the whole episode. `openai-audio` is the v0.9.5
    // Pollinations adapter, works without an upstream key, returns MP3, and
    // preserves a single OpenAI-style voice name across every scene.
    this.model = opts.model?.trim() || process.env["FREELLMAPI_SPEECH_MODEL"]?.trim() || "openai-audio";
    this.defaultVoice = opts.voice?.trim() || process.env["FREELLMAPI_SPEECH_VOICE"]?.trim() || "onyx";
    const configuredFormat = opts.format?.trim().toLowerCase()
      || process.env["FREELLMAPI_SPEECH_FORMAT"]?.trim().toLowerCase()
      || "mp3";
    // The current voice artifact/render contract does not persist per-clip media
    // type and the renderer reads narration as MP3. Refuse a misleading WAV/PCM
    // configuration instead of generating valid bytes that are later mislabeled.
    if (configuredFormat !== "mp3") {
      throw new ProviderError(`FreeLLMSpeechProvider currently requires mp3 output; received '${configuredFormat}'`);
    }
    this.format = "mp3";
    this.timeoutMs = positiveTimeout(opts.timeoutMs, process.env["FREELLMAPI_MEDIA_TIMEOUT_MS"]);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.id = `freellmapi-speech/${this.model}`;
  }

  async synthesize(req: { text: string; voice: string; context?: { prev?: string; next?: string } }) {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: req.text,
          // The worker passes the effective configured FreeLLM voice. Keep this
          // provider deterministic even if called directly with another value.
          voice: this.defaultVoice,
          response_format: this.format,
        }),
        signal: timeoutSignal(this.timeoutMs),
      });
    } catch (err) {
      throw new ProviderError(`${this.id} request failed: ${String(err)}`);
    }
    if (!res.ok) {
      throw new ProviderError(`${this.id} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const audio = new Uint8Array(await res.arrayBuffer());
    if (!audio.length) throw new ProviderError(`${this.id} returned empty audio`);
    const mediaType = res.headers.get("content-type") || "audio/mpeg";
    const provider = res.headers.get("x-provider");
    const actualModel = provider ? `${provider}/${this.model}` : this.model;
    const usage: Usage = {
      input_tokens: 0,
      output_tokens: 0,
      units: req.text.length,
      cost_usd: 0,
      provider: "freellmapi",
      model: actualModel,
    };
    return {
      audio,
      media_type: mediaType,
      usage,
    };
  }
}
