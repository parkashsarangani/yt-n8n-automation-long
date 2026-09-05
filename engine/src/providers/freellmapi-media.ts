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
import {
  FreeMediaTerminalError,
  freeImagePrompt,
  isDailyFreeImageCapacityMessage,
  nextUtcDailyReset,
} from "../free-media-policy.ts";

// Free routes should spend capacity on content, not oversized source frames.
// The renderer scales these to 1080p; 1024-class source images are sufficient
// for illustrated stills and materially cheaper on providers that bill/limit by
// generated pixels or compute.
const IMAGE_SIZES: Record<Aspect, string> = {
  "16:9": "1024x576",
  "9:16": "576x1024",
  "1:1": "1024x1024",
};

function cleanBaseUrl(value: string | undefined): string {
  return (value?.trim() || "http://freellmapi:3001/v1").replace(/\/+$/, "");
}

function positiveTimeout(value: number | undefined, envValue: string | undefined): number {
  const parsed = value ?? Number(envValue || 120_000);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 120_000;
}

function positiveInteger(value: number | undefined, envValue: string | undefined, fallback: number): number {
  const parsed = value ?? Number(envValue || fallback);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

/**
 * Some OpenAI-compatible image bridges impose a much smaller string ceiling
 * than the native image model itself. Preserve both the scene instruction at
 * the front and the visual/exclusion contract at the tail rather than blindly
 * chopping off whichever half happens to be last.
 */
export function compactImagePrompt(value: string, maxChars: number): string {
  const prompt = value.replace(/\s+/g, " ").trim();
  if (prompt.length <= maxChars) return prompt;
  const budget = Math.max(128, maxChars);
  const separator = " … ";
  const tailBudget = Math.max(96, Math.floor(budget * 0.38));
  const headBudget = Math.max(1, budget - separator.length - tailBudget);
  return `${prompt.slice(0, headBudget).trimEnd()}${separator}${prompt.slice(-tailBudget).trimStart()}`.slice(0, budget);
}

function imageMediaType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12
      && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF"
      && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 6) {
    const sig = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  return null;
}

function validatedImage(bytes: Uint8Array, id: string): { bytes: Uint8Array; media_type: string } {
  const mediaType = imageMediaType(bytes);
  if (!mediaType) throw new ProviderError(`${id} returned an unsupported or unrecognized image binary`);
  return { bytes, media_type: mediaType };
}

function normalizeAudioMediaType(raw: string | null): string {
  const value = (raw || "").split(";", 1)[0]!.trim().toLowerCase();
  if (["audio/wav", "audio/x-wav", "audio/vnd.wave", "audio/wave"].includes(value)) return "audio/wav";
  if (["audio/mpeg", "audio/mp3"].includes(value)) return "audio/mpeg";
  if (value === "audio/ogg") return value;
  if (["audio/aac", "audio/flac", "audio/l16"].includes(value)) return value;
  throw new ProviderError(`FreeLLM speech returned unsupported content-type '${value || "unknown"}'`);
}

function wavDurationSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.length < 44) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, length: number) => Buffer.from(bytes.subarray(offset, offset + length)).toString("ascii");
  if (tag(0, 4) !== "RIFF" || tag(8, 4) !== "WAVE") return undefined;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = tag(offset, 4);
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

const TRANSIENT_IMAGE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const SPEECH_QUOTA_EXHAUSTED = /(?:exceeded (?:your )?current quota|quota.{0,40}(?:exhaust|exceed)|resource[_ -]?exhausted|check your plan and billing)/i;
let imageCapacityBlockedUntil = 0;
let imageCapacityReason = "";
let speechCapacityReason = "";

// A hosted hero-tier model (e.g. a trial API) typically has a small total
// call allowance with no rate-limit headers exposing the remaining count.
// Track spend for the whole process lifetime -- not per run, not daily reset
// -- and stop trying once the configured ceiling is reached, so a run of bad
// luck across many episodes can never quietly exhaust a real account limit.
// Reserved optimistically (before the call, not after success) because a
// failed hosted request may still count against the provider's own quota.
let heroCallsUsed = 0;

/** Test-only: reset the shared hero-call counter between test cases. */
export function __resetFreeLLMHeroBudgetForTests(): void {
  heroCallsUsed = 0;
}

/** Test-only: speech quota is intentionally process-lifetime in production. */
export function __resetFreeLLMSpeechCircuitForTests(): void {
  speechCapacityReason = "";
}

export interface FreeLLMImageOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** Total Long->FreeLLM attempts. FreeLLM itself already fails over providers. */
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * A separately-registered FreeLLM model reserved for RFC 0009 hero shots
   * only (e.g. a hosted trial API routed through its own custom row). Unset
   * by default: operators opt in deliberately, since this is meant to be a
   * scarce, quota-bounded escalation, never the default image route.
   */
  heroModel?: string;
  /** Hard, process-lifetime ceiling on hero-model calls. Default 10. */
  heroMaxCalls?: number;
  /**
   * Request-string ceiling for the hero bridge. Default 1000 characters: the
   * current OpenAI-compatible bridge rejected the full style bundle with a
   * string_too_long 422, even though NVIDIA's native endpoint accepts more.
   * This is configurable without weakening the standard image route.
   */
  heroPromptMaxChars?: number;
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
  private readonly heroModel: string;
  private readonly heroMaxCalls: number;
  private readonly heroPromptMaxChars: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(opts: FreeLLMImageOptions = {}) {
    const key = opts.apiKey ?? process.env["FREELLMAPI_API_KEY"];
    if (!key?.trim()) throw new ProviderError("FreeLLMImageProvider needs FREELLMAPI_API_KEY");
    this.apiKey = key.trim();
    this.baseUrl = cleanBaseUrl(opts.baseUrl ?? process.env["FREELLMAPI_BASE_URL"]);
    // `auto` is safe only while all enabled image rows are fungible. Once a
    // separately-metered hero model is configured, FreeLLM's own auto failover
    // could route ordinary shots to that same scarce row without Long seeing or
    // accounting for the call. Require an explicit, different standard model.
    this.model = opts.model?.trim() || process.env["FREELLMAPI_IMAGE_MODEL"]?.trim() || "auto";
    this.heroModel = opts.heroModel?.trim() || process.env["FREELLMAPI_HERO_IMAGE_MODEL"]?.trim() || "";
    if (this.heroModel && (this.model === "auto" || this.model === this.heroModel)) {
      throw new ProviderError(
        "FreeLLM hero image escalation requires FREELLMAPI_IMAGE_MODEL to be pinned to a different standard image model; model=auto can silently route ordinary shots through the quota-limited hero row",
      );
    }
    this.heroMaxCalls = Math.max(0, Math.floor(opts.heroMaxCalls ?? Number(process.env["FREELLMAPI_HERO_IMAGE_MAX_CALLS"] ?? 10)));
    this.heroPromptMaxChars = Math.max(256, positiveInteger(
      opts.heroPromptMaxChars,
      process.env["FREELLMAPI_HERO_IMAGE_PROMPT_MAX_CHARS"],
      1000,
    ));
    this.timeoutMs = positiveTimeout(opts.timeoutMs, process.env["FREELLMAPI_MEDIA_TIMEOUT_MS"]);
    this.maxAttempts = Math.max(1, Math.min(3, opts.maxAttempts ?? 2));
    this.retryDelayMs = Math.max(0, opts.retryDelayMs ?? 600);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.id = `freellmapi-image/${this.model}`;
  }

  async generate(req: { prompt: string; aspect: Aspect; count?: number; tier?: "hero" | "standard" }) {
    if (req.tier === "hero" && this.heroModel) {
      if (heroCallsUsed < this.heroMaxCalls) {
        heroCallsUsed += 1;
        const spent = heroCallsUsed;
        try {
          const result = await this.requestOnce(this.heroModel, req);
          console.warn(`[freellmapi-image] hero call ${spent}/${this.heroMaxCalls} succeeded via ${result.usage.model}`);
          return result;
        } catch (err) {
          console.warn(`[freellmapi-image] hero model '${this.heroModel}' failed (${spent}/${this.heroMaxCalls} spent); falling back to the standard model: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        console.warn(`[freellmapi-image] hero model call ceiling reached (${this.heroMaxCalls}); using the standard model for this shot`);
      }
    }
    return this.requestStandard(req);
  }

  private async requestStandard(req: { prompt: string; aspect: Aspect; count?: number }) {
    const now = this.now();
    if (now < imageCapacityBlockedUntil) {
      throw new FreeMediaTerminalError(
        `${this.id} daily image capacity is circuit-broken until ${new Date(imageCapacityBlockedUntil).toISOString()}: ${imageCapacityReason}`,
      );
    }
    if (now >= imageCapacityBlockedUntil) {
      imageCapacityBlockedUntil = 0;
      imageCapacityReason = "";
    }
    return this.requestOnce(this.model, req);
  }

  private async requestOnce(model: string, req: { prompt: string; aspect: Aspect; count?: number }) {
    const count = Math.max(1, Math.min(4, req.count ?? 1));
    const expandedPrompt = freeImagePrompt(req.prompt);
    const prompt = this.heroModel && model === this.heroModel
      ? compactImagePrompt(expandedPrompt, this.heroPromptMaxChars)
      : expandedPrompt;
    if (prompt.length < expandedPrompt.length) {
      console.warn(`[freellmapi-image] compacted hero prompt ${expandedPrompt.length}->${prompt.length} chars for '${model}'`);
    }
    const providerRef = `freellmapi-image/${model}`;
    let res: Response | undefined;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        res = await this.fetchImpl(`${this.baseUrl}/images/generations`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            prompt,
            n: count,
            size: IMAGE_SIZES[req.aspect],
            response_format: "b64_json",
          }),
          signal: timeoutSignal(this.timeoutMs),
        });
      } catch (err) {
        lastError = new ProviderError(`${providerRef} request failed: ${err instanceof Error ? err.name : "network error"}`);
        if (attempt < this.maxAttempts) {
          await this.sleepImpl(this.retryDelayMs * attempt);
          continue;
        }
        throw lastError;
      }

      if (res.ok) break;
      const body = (await res.text()).slice(0, 500);
      if (res.status === 429 && isDailyFreeImageCapacityMessage(body)) {
        imageCapacityBlockedUntil = nextUtcDailyReset(this.now());
        imageCapacityReason = body.slice(0, 240);
        throw new FreeMediaTerminalError(
          `${providerRef} exhausted the daily free image allocation; no further image calls will be made before ${new Date(imageCapacityBlockedUntil).toISOString()}`,
        );
      }
      lastError = new ProviderError(`${providerRef} returned ${res.status}: ${body.slice(0, 300)}`);
      if (attempt < this.maxAttempts && TRANSIENT_IMAGE_STATUSES.has(res.status)) {
        await this.sleepImpl(this.retryDelayMs * attempt);
        continue;
      }
      throw lastError;
    }

    if (!res?.ok) throw lastError ?? new ProviderError(`${providerRef} request failed`);
    const body = (await res.json()) as FreeLLMImageResponse;
    const images: Array<{ bytes: Uint8Array; media_type: string }> = [];
    for (const item of body.data ?? []) {
      if (item.b64_json) {
        images.push(validatedImage(Uint8Array.from(Buffer.from(item.b64_json, "base64")), providerRef));
      } else if (item.url) {
        const dl = await this.fetchImpl(item.url, { signal: timeoutSignal(this.timeoutMs) });
        if (!dl.ok) throw new ProviderError(`${providerRef} image download failed: ${dl.status}`);
        images.push(validatedImage(new Uint8Array(await dl.arrayBuffer()), providerRef));
      }
    }
    if (images.length === 0) throw new ProviderError(`${providerRef} returned no images`);

    const actualModel = body.provider && body.model
      ? `${body.provider}/${body.model}`
      : body.model || body.provider || model;
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
  private readonly requestedFormat: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FreeLLMSpeechOptions = {}) {
    const key = opts.apiKey ?? process.env["FREELLMAPI_API_KEY"];
    if (!key?.trim()) throw new ProviderError("FreeLLMSpeechProvider needs FREELLMAPI_API_KEY");
    this.apiKey = key.trim();
    this.baseUrl = cleanBaseUrl(opts.baseUrl ?? process.env["FREELLMAPI_BASE_URL"]);
    // The live shared v0.9.5 instance has already proven `auto` routes to a
    // working Google TTS row. Provider-native ids vary with the media catalog,
    // so do not guess one here.
    this.model = opts.model?.trim() || process.env["FREELLMAPI_SPEECH_MODEL"]?.trim() || "auto";
    this.defaultVoice = opts.voice?.trim() || process.env["FREELLMAPI_SPEECH_VOICE"]?.trim() || "onyx";
    // Keep requesting MP3 when a provider can supply it, but trust and persist
    // the response's real content type. Google/Gemini legitimately returns WAV
    // even when this preference is MP3.
    this.requestedFormat = opts.format?.trim().toLowerCase()
      || process.env["FREELLMAPI_SPEECH_FORMAT"]?.trim().toLowerCase()
      || "mp3";
    this.timeoutMs = positiveTimeout(opts.timeoutMs, process.env["FREELLMAPI_MEDIA_TIMEOUT_MS"]);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.id = `freellmapi-speech/${this.model}`;
  }

  async synthesize(req: { text: string; voice: string; context?: { prev?: string; next?: string } }) {
    if (speechCapacityReason) {
      throw new FreeMediaTerminalError(
        `${this.id} speech quota is circuit-broken for this process: ${speechCapacityReason}`,
      );
    }

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
          voice: this.defaultVoice,
          response_format: this.requestedFormat,
        }),
        signal: timeoutSignal(this.timeoutMs),
      });
    } catch (err) {
      throw new ProviderError(`${this.id} request failed: ${String(err)}`);
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      if (SPEECH_QUOTA_EXHAUSTED.test(body)) {
        speechCapacityReason = body.slice(0, 240);
        throw new FreeMediaTerminalError(
          `${this.id} speech quota exhausted; no further speech calls will be made by this process: ${speechCapacityReason}`,
        );
      }
      throw new ProviderError(`${this.id} returned ${res.status}: ${body.slice(0, 300)}`);
    }

    const audio = new Uint8Array(await res.arrayBuffer());
    if (!audio.length) throw new ProviderError(`${this.id} returned empty audio`);
    const mediaType = normalizeAudioMediaType(res.headers.get("content-type"));
    const provider = res.headers.get("x-provider");
    const actualModel = provider ? `${provider}/${this.model}` : this.model;
    const duration = mediaType === "audio/wav" ? wavDurationSeconds(audio) : undefined;
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
      ...(duration !== undefined ? { duration_sec: duration } : {}),
      usage,
    };
  }
}
