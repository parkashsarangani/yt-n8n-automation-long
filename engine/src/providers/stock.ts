/**
 * Cartoon-first image provider compatibility adapter.
 *
 * `service.ts` historically imports `StockImageProvider`. The production path
 * no longer uses stock photography: cartoon scenes are deterministic SVG
 * templates and the only generated image normally needed is episode-specific
 * thumbnail artwork. Keep the exported class name temporarily so the provider
 * wiring can migrate without changing artifact/worker interfaces, but delegate
 * all image generation to the existing Fal provider.
 *
 * The legacy Pexels/Unsplash/Pixabay credentials remain accepted in config only
 * for old/manual deployments; they do not enable this provider.
 */

import type { Aspect, ImageProvider } from "../provider.ts";
import { FalImageProvider } from "./fal.ts";

export interface StockImageOptions {
  /** Preferred explicit key; otherwise FAL_KEY is read by FalImageProvider. */
  falKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  // Legacy fields retained so old construction code still type-checks while
  // the stock pipeline is retired.
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
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this.id = `cartoon-art/${this.delegate.id}`;
  }

  generate(req: { prompt: string; aspect: Aspect; count?: number }) {
    return this.delegate.generate(req);
  }
}
