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

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1_000, timeoutMs));
}

function wavDurationSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.length < 44) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE") return undefined;

  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = text(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + size > bytes.length) break;
    if (id === "fmt " && size >= 16) byteRate = view.getUint32(payload + 8, true);
    if (id === "data") {
      dataBytes = size;
      break;
    }
    offset = payload + size + (size % 2);
  }
  if (!byteRate || dataBytes === undefined) return undefined;
  return Number((dataBytes / byteRate).toFixed(3));
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
    this.timeoutMs = opts.timeoutMs ?? Number(process.env["FREELLMAPI_MEDIA_TIMEOUT_MS"] || 120_000);
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
  private readonly format: string;
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
    this.format = opts.format?.trim() || process.env["FREELLMAPI_SPEECH_FORMAT"]?.trim() || "mp3";
    this.timeoutMs = opts.timeoutMs ?? Number(process.env["FREELLMAPI_MEDIA_TIMEOUT_MS"] || 120_000);
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
          // Do not forward ELEVENLABS_VOICE_ID from the unchanged voice worker.
          // FreeLLM has its own explicitly configured episode narrator.
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
    const mediaType = res.headers.get("content-type") || (this.format === "wav" ? "audio/wav" : "audio/mpeg");
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
      ...(mediaType.includes("wav") && wavDurationSeconds(audio) !== undefined
        ? { duration_sec: wavDurationSeconds(audio)! }
        : {}),
      usage,
    };
  }
}
