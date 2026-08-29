/**
 * Cartoon-first image provider compatibility adapter.
 *
 * The exported class name remains for compatibility with service wiring, but
 * production image generation is Fal-backed. Hybrid scene generation may use
 * the optional generatePack extension and pass a canonical reference image so
 * continuity persists across scene boundaries as well as inside a shot pack.
 */

import type { Aspect, ImageProvider } from "../provider.ts";
import { FalImageProvider, type GeneratedImage } from "./fal.ts";

export interface StockImageOptions {
  falKey?: string;
  model?: string;
  editModel?: string;
  fetchImpl?: typeof fetch;
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
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this.id = `cartoon-art/${this.delegate.id}`;
  }

  generate(req: { prompt: string; aspect: Aspect; count?: number }) {
    return this.delegate.generate(req);
  }

  generatePack(req: { prompts: string[]; aspect: Aspect; seed: number; reference?: GeneratedImage }) {
    return this.delegate.generatePack(req);
  }
}
