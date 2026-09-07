/**
 * Backward-compatible image provider adapter.
 *
 * RFC 0010 removes FreeLLMAPI image generation entirely. The historical
 * StockImageProvider name remains temporarily so existing service wiring and
 * tests do not need an unrelated rename, but every real image generation call
 * is delegated directly to fal.ai's FLUX.2 provider with reference-conditioned
 * pack support.
 */

import type { Aspect, ImageProvider } from "../provider.ts";
import { FalImageProvider, type GeneratedImage } from "./fal.ts";

export interface StockImageOptions {
  falKey?: string;
  model?: string;
  editModel?: string;
  /** USD per generated image, for cost accounting. Passed through to FalImageProvider. */
  pricePerImage?: number;
  fetchImpl?: typeof fetch;
  // Historical stock credentials are retained in the option shape only to
  // avoid breaking old/manual callers. They are not used for image generation.
  pexelsKey?: string;
  unsplashKey?: string;
  pixabayKey?: string;
}

export class StockImageProvider implements ImageProvider {
  readonly id: string;
  private readonly delegate: FalImageProvider;

  constructor(opts: StockImageOptions = {}) {
    this.delegate = new FalImageProvider({
      ...(opts.falKey ? { apiKey: opts.falKey } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.editModel ? { editModel: opts.editModel } : {}),
      ...(opts.pricePerImage !== undefined ? { pricePerImage: opts.pricePerImage } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this.id = `cartoon-art/${this.delegate.id}`;
  }

  generate(req: { prompt: string; aspect: Aspect; count?: number; tier?: "hero" | "standard" }) {
    return this.delegate.generate(req);
  }

  generatePack(req: {
    prompts: string[];
    aspect: Aspect;
    seed: number;
    reference?: GeneratedImage;
    tier?: "hero" | "standard";
  }) {
    return this.delegate.generatePack(req);
  }
}
