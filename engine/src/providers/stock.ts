/**
 * Cartoon-first image provider compatibility adapter.
 *
 * IMAGE_PROVIDER_MODE selects the concrete generator without changing the graph:
 *   - freellmapi: shared FreeLLMAPI media endpoint (production experiment)
 *   - fal: existing FLUX.2 + reference-conditioned edit path
 *
 * Unset mode stays on Fal for backward-compatible local/test behavior. Production
 * explicitly sets freellmapi in Compose/deploy. FreeLLMAPI intentionally cannot
 * preserve the canonical-reference edit contract; generatePack therefore
 * generates each requested shot independently when the experiment is enabled.
 */

import type { Aspect, ImageProvider, Usage } from "../provider.ts";
import { FalImageProvider, type GeneratedImage } from "./fal.ts";
import { FreeLLMImageProvider } from "./freellmapi-media.ts";

export interface StockImageOptions {
  falKey?: string;
  model?: string;
  editModel?: string;
  /** USD per generated image, for cost accounting. Passed through to FalImageProvider. */
  pricePerImage?: number;
  fetchImpl?: typeof fetch;
  pexelsKey?: string;
  unsplashKey?: string;
  pixabayKey?: string;
}

type PackCapable = ImageProvider & {
  generatePack?: (req: {
    prompts: string[];
    aspect: Aspect;
    seed: number;
    reference?: GeneratedImage;
  }) => Promise<{ images: GeneratedImage[]; usage?: Usage }>;
};

function imageProviderMode(): "freellmapi" | "fal" {
  return process.env["IMAGE_PROVIDER_MODE"]?.trim().toLowerCase() === "freellmapi"
    ? "freellmapi"
    : "fal";
}

export class StockImageProvider implements ImageProvider {
  readonly id: string;
  private readonly delegate: PackCapable;

  constructor(opts: StockImageOptions = {}) {
    if (imageProviderMode() === "fal") {
      this.delegate = new FalImageProvider({
        ...(opts.falKey ? { apiKey: opts.falKey } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.editModel ? { editModel: opts.editModel } : {}),
        ...(opts.pricePerImage !== undefined ? { pricePerImage: opts.pricePerImage } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    } else {
      this.delegate = new FreeLLMImageProvider({
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    }
    this.id = `cartoon-art/${this.delegate.id}`;
  }

  generate(req: { prompt: string; aspect: Aspect; count?: number }) {
    return this.delegate.generate(req);
  }

  async generatePack(req: { prompts: string[]; aspect: Aspect; seed: number; reference?: GeneratedImage }) {
    if (this.delegate.generatePack) return this.delegate.generatePack(req);

    const images: GeneratedImage[] = [];
    let units = 0;
    for (const prompt of req.prompts) {
      const out = await this.delegate.generate({ prompt, aspect: req.aspect, count: 1 });
      const image = out.images[0];
      if (!image) throw new Error(`${this.delegate.id} returned no image for shot pack`);
      images.push(image);
      units += out.usage.units ?? out.images.length;
    }
    return {
      images,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units,
        cost_usd: 0,
        provider: "freellmapi",
        model: process.env["FREELLMAPI_IMAGE_MODEL"]?.trim() || "flux",
      } satisfies Usage,
    };
  }
}
