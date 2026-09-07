/**
 * FreeLLMAPI speech provider — the optional `SPEECH_PROVIDER_MODE=freellmapi`
 * narration rollback path (production speech is ElevenLabs). Selected in
 * providers/elevenlabs.ts. Image and video generation now have their own
 * free-first clients (providers/freellm-image.ts, providers/freellm-video.ts).
 */

import { ProviderError, type SpeechProvider, type Usage } from "../provider.ts";
import { FreeMediaTerminalError } from "../free-media-policy.ts";

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

const SPEECH_QUOTA_EXHAUSTED = /(?:exceeded (?:your )?current quota|quota.{0,40}(?:exhaust|exceed)|resource[_ -]?exhausted|check your plan and billing)/i;
let speechCapacityReason = "";

/** Test-only: speech quota is intentionally process-lifetime in production. */
export function __resetFreeLLMSpeechCircuitForTests(): void {
  speechCapacityReason = "";
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
    // Speech remains allowed to use FreeLLM's media catalog auto route. RFC
    // 0010's model pin applies to creative text/reasoning, not TTS selection.
    this.model = opts.model?.trim() || process.env["FREELLMAPI_SPEECH_MODEL"]?.trim() || "auto";
    this.defaultVoice = opts.voice?.trim() || process.env["FREELLMAPI_SPEECH_VOICE"]?.trim() || "onyx";
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
