/**
 * Free-first video generation through the shared FreeLLMAPI media gateway.
 *
 * `FREELLMAPI_VIDEO_MODELS` is a FREE-VIDEO ALLOWLIST: only concrete model ids
 * that have been verified to generate at zero out-of-pocket cost for the
 * current account may be listed. There is no default. `auto` is rejected.
 *
 * The gateway (`POST /v1/videos/generations`) presents one bounded request and
 * returns the finished MP4 bytes plus `X-Provider` / `X-Model` headers. This
 * client never polls a provider itself.
 *
 * A "payment required" / "top up" / "insufficient balance" response means the
 * model is NOT a free route right now — it is skipped and recorded, never
 * escalated into a paid call. When every configured free video model fails the
 * caller falls back to a semantic non-video representation. Paid Kling/Fal
 * video generation stays blocked by `PAID_VIDEO_FALLBACK=false`.
 */

import { ProviderError } from "../provider.ts";
import { FreeMediaAuthError } from "../free-media-policy.ts";
import {
  freeLlmMediaBaseUrl,
  resolveFreeVideoDurationSec,
  resolveFreeVideoModels,
} from "../freellm-media-models.ts";

const MIN_VIDEO_BYTES = 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

const PAYMENT_REQUIRED = /payment required|top ?up|insufficient (?:paid )?balance|billing (?:required|enabled)|paid[_ -]?only|add (?:a )?payment|requires? (?:a )?paid|out of credits?|purchase credits?/i;

export interface FreeLlmVideoResult {
  bytes: Uint8Array;
  media_type: string;
  /** Gateway abstraction + routed upstream provider, e.g. "pollinations". */
  upstream_provider: string;
  /** Routed upstream model id from the X-Model header. */
  routed_model: string;
  /** Requested model id (the entry from FREELLMAPI_VIDEO_MODELS). */
  requested_model: string;
  duration_sec?: number;
}

export interface FreeLlmVideoAttempt {
  requested_model: string;
  status: "success" | "failed";
  http_status?: number;
  failure_reason?: string;
  /** True when the failure means "this model is not currently a free route". */
  not_free?: boolean;
}

export interface FreeLlmVideoOptions {
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  durationSec?: number;
  aspectRatio?: "16:9" | "9:16";
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * The gateway's `/v1/videos/generations` contract is MP4. Enforce it fail-closed
 * so a WebM/other container can never be written as `video/mp4` downstream and
 * can never be promoted by the bake-off. Returns "video/mp4" only for a real
 * MP4/QuickTime `ftyp` box (with an MP4-compatible content-type or none);
 * anything else — including `video/webm` — returns null and the model is
 * treated as unavailable.
 */
function mp4MediaTypeOrNull(contentType: string | null, bytes: Uint8Array): string | null {
  const ct = (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (ct && !["video/mp4", "video/quicktime", "application/mp4", "application/octet-stream", "binary/octet-stream"].includes(ct)) {
    return null;
  }
  if (bytes.length > 12) {
    const tag = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
    if (tag === "ftyp") {
      const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!).toLowerCase();
      // Reject an ftyp whose major brand is a non-MP4 family (e.g. "webm").
      if (/^(isom|iso2|iso5|iso6|mp4[12]|avc1|dash|m4v |mmp4|qt {2}|f4v )$/.test(brand) || brand.startsWith("iso") || brand.startsWith("mp4")) {
        return "video/mp4";
      }
      return null;
    }
  }
  return null;
}

export class FreeLlmVideoProvider {
  readonly id: string;
  readonly models: string[];
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly durationSec: number | undefined;
  private readonly aspectRatio: "16:9" | "9:16";
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** Every attempt made by the most recent generate() call, for the bake-off report. */
  lastAttempts: FreeLlmVideoAttempt[] = [];

  constructor(opts: FreeLlmVideoOptions = {}) {
    const key = opts.apiKey ?? process.env["FREELLMAPI_API_KEY"];
    if (!key?.trim()) throw new ProviderError("FreeLlmVideoProvider needs FREELLMAPI_API_KEY");
    this.apiKey = key.trim();
    this.baseUrl = (opts.baseUrl ?? freeLlmMediaBaseUrl()).replace(/\/+$/, "");
    this.models = opts.models ?? resolveFreeVideoModels();
    this.durationSec = opts.durationSec ?? resolveFreeVideoDurationSec();
    this.aspectRatio = opts.aspectRatio ?? "16:9";
    const raw = Number(opts.timeoutMs ?? process.env["FREELLMAPI_MEDIA_TIMEOUT_MS"] ?? 300_000);
    this.timeoutMs = Number.isFinite(raw) && raw >= 5_000 ? raw : 300_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.id = `freellmapi-video/[${this.models.join(",")}]`;
  }

  private async requestModel(model: string, prompt: string): Promise<FreeLlmVideoResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/videos/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: prompt.slice(0, 2400),
          aspect_ratio: this.aspectRatio,
          ...(this.durationSec !== undefined ? { duration: this.durationSec } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ProviderError(`freellmapi-video/${model} request failed: ${err instanceof Error ? err.name : "network error"}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      if (res.status === 401 || res.status === 403) {
        throw new FreeMediaAuthError(`freellmapi media gateway rejected the unified key (${res.status}): ${body}`);
      }
      if (res.status === 402 || PAYMENT_REQUIRED.test(body)) {
        const err = new ProviderError(`freellmapi-video/${model} is not a free route right now: ${body}`);
        (err as ProviderError & { notFree?: boolean }).notFree = true;
        (err as ProviderError & { httpStatus?: number }).httpStatus = res.status;
        throw err;
      }
      const err = new ProviderError(`freellmapi-video/${model} unavailable (${res.status}): ${body}`);
      (err as ProviderError & { httpStatus?: number }).httpStatus = res.status;
      throw err;
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < MIN_VIDEO_BYTES || bytes.length > MAX_VIDEO_BYTES) {
      throw new ProviderError(`freellmapi-video/${model} returned an empty or implausible video body (${bytes.length} bytes)`);
    }
    const media = mp4MediaTypeOrNull(res.headers.get("content-type"), bytes);
    if (!media) {
      throw new ProviderError(
        `freellmapi-video/${model} did not return an MP4 (content-type ${res.headers.get("content-type") ?? "none"}); the gateway video contract is MP4-only`,
      );
    }
    const durationHeader = Number(res.headers.get("x-duration") ?? res.headers.get("x-video-duration") ?? "");
    return {
      bytes,
      media_type: media,
      upstream_provider: (res.headers.get("x-provider") ?? "freellmapi").trim() || "freellmapi",
      routed_model: (res.headers.get("x-model") ?? model).trim() || model,
      requested_model: model,
      ...(Number.isFinite(durationHeader) && durationHeader > 0 ? { duration_sec: durationHeader } : {}),
    };
  }

  /** Walk the free-video allowlist. Returns null when every model is unavailable/not-free. */
  async generate(prompt: string): Promise<FreeLlmVideoResult | null> {
    this.lastAttempts = [];
    if (this.models.length === 0) return null;
    for (const model of this.models) {
      try {
        const out = await this.requestModel(model, prompt);
        this.lastAttempts.push({ requested_model: model, status: "success", http_status: 200 });
        return out;
      } catch (err) {
        if (err instanceof FreeMediaAuthError) throw err;
        const notFree = Boolean((err as { notFree?: boolean }).notFree);
        this.lastAttempts.push({
          requested_model: model,
          status: "failed",
          ...(typeof (err as { httpStatus?: number }).httpStatus === "number" ? { http_status: (err as { httpStatus?: number }).httpStatus } : {}),
          failure_reason: err instanceof Error ? err.message : String(err),
          ...(notFree ? { not_free: true } : {}),
        });
        console.warn(
          notFree
            ? `[freellm-media] free video model ${model} is not a free route right now; skipping and not escalating to paid`
            : `[freellm-media] free video model ${model} unavailable; trying next configured model`,
        );
      }
    }
    return null;
  }
}
