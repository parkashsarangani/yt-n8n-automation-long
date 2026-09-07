/**
 * Standalone free-only image provider for deployments with NO fal credential.
 *
 * When `FAL_KEY` is absent but `FREELLMAPI_IMAGE_MODELS` is configured, the
 * generated-image stage is still satisfied: every generated-image beat is
 * produced through the FreeLLMAPI media gateway and there is simply no paid
 * last resort. It exposes only `generate()` — continuity beats need the
 * reference-conditioned fal pack path and fall back to a declared alternate
 * when that is unavailable.
 *
 * When `FAL_KEY` IS present, `service.ts` wires the fal-backed provider instead
 * and the free-first attempt happens inside the resolver before any fal spend.
 */

import type { Aspect, ImageProvider, Usage } from "../provider.ts";
import { FreeLlmImageProvider } from "./freellm-image.ts";

export class FreeMediaImageProvider implements ImageProvider {
  readonly id = "free-media-image";
  private readonly inner: FreeLlmImageProvider;

  constructor(opts: { apiKey?: string; baseUrl?: string; models?: string[]; fetchImpl?: typeof fetch } = {}) {
    this.inner = new FreeLlmImageProvider(opts);
  }

  generate(req: { prompt: string; aspect: Aspect; count?: number; tier?: "hero" | "standard" }): Promise<{ images: Array<{ bytes: Uint8Array; media_type: string }>; usage: Usage }> {
    return this.inner.generate(req);
  }
}
