/**
 * Config-selectable speech provider facade.
 *
 * SPEECH_PROVIDER_MODE selects:
 *   - freellmapi (experimental default): shared FreeLLMAPI /audio/speech
 *   - elevenlabs: existing ElevenLabs with timestamps/prosody context
 *
 * The exported class name stays stable so the service/graph does not need to
 * know which vendor serves the speech capability.
 */

import { ProviderError, type SpeechProvider, type Usage } from "../provider.ts";
import { FreeLLMSpeechProvider } from "./freellmapi-media.ts";

export interface ElevenLabsOptions {
  apiKey?: string;
  modelId?: string;
  baseUrl?: string;
  /** USD per 1000 characters, for cost accounting. Default: $0.30/kchar (Scale plan). */
  pricePerKChar?: number;
  voiceSettings?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

interface TimestampsResponse {
  audio_base64?: string;
  alignment?: unknown;
  normalized_alignment?: unknown;
}

class DirectElevenLabsProvider implements SpeechProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly baseUrl: string;
  private readonly pricePerKChar: number;
  private readonly voiceSettings: Record<string, unknown>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ElevenLabsOptions = {}) {
    const key = opts.apiKey ?? process.env["ELEVENLABS_API_KEY"];
    if (!key) throw new ProviderError("ElevenLabsProvider needs an API key");
    this.apiKey = key;
    this.modelId = opts.modelId ?? "eleven_multilingual_v2";
    this.baseUrl = opts.baseUrl ?? "https://api.elevenlabs.io";
    this.pricePerKChar = opts.pricePerKChar ?? 0.30;
    this.voiceSettings = opts.voiceSettings ?? {
      stability: 0.45,
      similarity_boost: 0.8,
      style: 0.35,
      use_speaker_boost: true,
    };
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.id = `elevenlabs/${this.modelId}`;
  }

  async synthesize(req: {
    text: string;
    voice: string;
    context?: { prev?: string; next?: string };
  }) {
    const url = `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(req.voice)}/with-timestamps`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: req.text,
          model_id: this.modelId,
          ...(req.context?.prev ? { previous_text: req.context.prev } : {}),
          ...(req.context?.next ? { next_text: req.context.next } : {}),
          voice_settings: this.voiceSettings,
        }),
      });
    } catch (err) {
      throw new ProviderError(`${this.id} request failed: ${String(err)}`);
    }

    if (!res.ok) {
      throw new ProviderError(
        `${this.id} returned ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }

    const body = (await res.json()) as TimestampsResponse;
    if (!body.audio_base64) {
      throw new ProviderError(`${this.id} response is missing audio_base64`);
    }
    const audio = Uint8Array.from(Buffer.from(body.audio_base64, "base64"));
    const alignment = body.alignment ?? body.normalized_alignment;

    const usage: Usage = {
      input_tokens: 0,
      output_tokens: 0,
      units: req.text.length,
      cost_usd: (req.text.length / 1000) * this.pricePerKChar,
      provider: "elevenlabs",
      model: this.modelId,
    };

    return {
      audio,
      media_type: "audio/mpeg",
      ...(alignment !== undefined ? { alignment } : {}),
      ...(durationFromAlignment(alignment) !== undefined
        ? { duration_sec: durationFromAlignment(alignment)! }
        : {}),
      usage,
    };
  }
}

function speechProviderMode(): "freellmapi" | "elevenlabs" {
  return process.env["SPEECH_PROVIDER_MODE"]?.trim().toLowerCase() === "elevenlabs"
    ? "elevenlabs"
    : "freellmapi";
}

export class ElevenLabsProvider implements SpeechProvider {
  readonly id: string;
  private readonly delegate: SpeechProvider;

  constructor(opts: ElevenLabsOptions = {}) {
    this.delegate = speechProviderMode() === "elevenlabs"
      ? new DirectElevenLabsProvider(opts)
      : new FreeLLMSpeechProvider({ ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    this.id = this.delegate.id;
  }

  synthesize(req: { text: string; voice: string; context?: { prev?: string; next?: string } }) {
    return this.delegate.synthesize(req);
  }
}

/** Last character end time, when the alignment payload carries one. */
export function durationFromAlignment(alignment: unknown): number | undefined {
  if (!alignment || typeof alignment !== "object") return undefined;
  const ends = (alignment as { character_end_times_seconds?: unknown })
    .character_end_times_seconds;
  if (!Array.isArray(ends) || ends.length === 0) return undefined;
  const last = ends[ends.length - 1];
  return typeof last === "number" ? last : undefined;
}
