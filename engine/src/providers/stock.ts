/**
 * fal.ai image provider adapter.
 *
 * The historical `StockImageProvider` name is kept so service wiring, tests and
 * the `.id` string (`cartoon-art/fal/...`, which the resolver and the deploy
 * guard match on) stay stable. Every call delegates to fal.ai's FLUX.2 provider
 * with reference-conditioned pack support. This is the PAID image path — the
 * resolver tries the free FreeLLMAPI image chain first (see
 * workers/visual-beat-resolver.ts `generateFreeLlmImage`).
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
