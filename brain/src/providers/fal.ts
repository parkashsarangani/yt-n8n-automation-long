/**
 * Fal image provider (RFC 0004).
 *
 * The only file that knows Fal exists. Model and request shape carried over
 * from the long-form pipeline (`fal-ai/flux/dev`, 1024x1792 for 9:16).
 *
 * NOT YET RUN AGAINST THE REAL API.
 */

import { ProviderError, type Aspect, type ImageProvider, type Usage } from "../provider.ts";

const SIZES: Record<Aspect, { width: number; height: number }> = {
  "9:16": { width: 1024, height: 1792 },
  "16:9": { width: 1280, height: 720 },
  "1:1": { width: 1024, height: 1024 },
};

export interface FalOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  steps?: number;
  /** USD per generated image, for cost accounting. */
  pricePerImage?: number;
  fetchImpl?: typeof fetch;
}

interface FalResponse {
  images?: Array<{ url?: string; content_type?: string }>;
}

export class FalImageProvider implements ImageProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly steps: number;
  private readonly pricePerImage: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: FalOptions = {}) {
    const key = opts.apiKey ?? process.env["FAL_KEY"];
    if (!key) throw new ProviderError("FalImageProvider needs an API key (FAL_KEY)");
    this.apiKey = key;
    this.model = opts.model ?? "fal-ai/flux-2-pro";
    this.baseUrl = opts.baseUrl ?? "https://fal.run";
    this.steps = opts.steps ?? 28;
    this.pricePerImage = opts.pricePerImage ?? 0.04;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.id = `fal/${this.model}`;
  }

  async generate(req: { prompt: string; aspect: Aspect; count?: number }) {
    const count = req.count ?? 1;
    const size = SIZES[req.aspect];

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/${this.model}`, {
        method: "POST",
        headers: {
          Authorization: `Key ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: req.prompt,
          image_size: size,
          num_images: count,
          num_inference_steps: this.steps,
          enable_safety_checker: true,
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

    const body = (await res.json()) as FalResponse;
    const urls = (body.images ?? []).filter((i) => i.url);
    if (urls.length === 0) {
      // Usually a safety-checker block. The asset worker's fallback rung
      // handles this; it must surface as an error, not an empty success.
      throw new ProviderError(`${this.id} returned no images (blocked or empty)`);
    }

    const images = await Promise.all(
      urls.map(async (img) => {
        const dl = await this.fetchImpl(img.url!);
        if (!dl.ok) throw new ProviderError(`${this.id} image download failed: ${dl.status}`);
        return {
          bytes: new Uint8Array(await dl.arrayBuffer()),
          media_type: img.content_type ?? "image/png",
        };
      }),
    );

    const usage: Usage = {
      input_tokens: 0,
      output_tokens: 0,
      units: images.length,
      cost_usd: images.length * this.pricePerImage,
      provider: "fal",
      model: this.model,
    };

    return { images, usage };
  }
}
