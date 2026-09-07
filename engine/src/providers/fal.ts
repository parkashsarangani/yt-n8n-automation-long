/**
 * Fal image provider (RFC 0004).
 *
 * FLUX.2 is the production still-image source. A pack may receive a canonical
 * reference from an earlier scene, so recurring subjects are reference-
 * conditioned across the episode instead of merely sharing prompt text.
 */

import { ProviderError, type Aspect, type ImageProvider, type Usage } from "../provider.ts";
import { assertFalAccountAvailable, recordFalHttpFailure } from "./fal-account-health.ts";

const SIZES: Record<Aspect, { width: number; height: number }> = {
  "9:16": { width: 1024, height: 1792 },
  "16:9": { width: 1792, height: 1024 },
  "1:1": { width: 1024, height: 1024 },
};

export interface FalOptions {
  apiKey?: string;
  model?: string;
  editModel?: string;
  baseUrl?: string;
  outputFormat?: "png" | "jpeg";
  pricePerImage?: number;
  fetchImpl?: typeof fetch;
}

interface FalResponse {
  images?: Array<{ url?: string; content_type?: string }>;
  seed?: number;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  media_type: string;
}

export class FalImageProvider implements ImageProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly editModel: string;
  private readonly baseUrl: string;
  private readonly outputFormat: "png" | "jpeg";
  private readonly pricePerImage: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: FalOptions = {}) {
    const key = opts.apiKey ?? process.env["FAL_KEY"];
    if (!key) throw new ProviderError("FalImageProvider needs an API key (FAL_KEY)");
    this.apiKey = key;
    this.model = opts.model ?? "fal-ai/flux-2";
    this.editModel = opts.editModel ?? `${this.model}/edit`;
    this.baseUrl = opts.baseUrl ?? "https://fal.run";
    this.outputFormat = opts.outputFormat ?? "png";
    this.pricePerImage = opts.pricePerImage ?? 0.025;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    const raw = Number(process.env["FAL_TIMEOUT_MS"]);
    this.timeoutMs = Number.isFinite(raw) && raw >= 5_000 ? raw : 180_000;
    this.id = `fal/${this.model}`;
  }

  private async fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    assertFalAccountAvailable();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...(init ?? {}), signal: controller.signal });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new ProviderError(
        aborted ? `${this.id} request timed out after ${this.timeoutMs}ms` : `${this.id} request failed: ${String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(model: string, input: Record<string, unknown>): Promise<GeneratedImage> {
    assertFalAccountAvailable();
    const res = await this.fetchWithTimeout(`${this.baseUrl}/${model}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      recordFalHttpFailure(res.status, body);
      assertFalAccountAvailable();
      throw new ProviderError(`${this.id} returned ${res.status}: ${body}`);
    }

    const body = (await res.json()) as FalResponse;
    const image = (body.images ?? []).find((item) => item.url);
    if (!image?.url) throw new ProviderError(`${this.id} returned no images (blocked or empty)`);

    const dl = await this.fetchWithTimeout(image.url);
    if (!dl.ok) throw new ProviderError(`${this.id} image download failed: ${dl.status}`);
    return {
      bytes: new Uint8Array(await dl.arrayBuffer()),
      media_type: image.content_type ?? (this.outputFormat === "png" ? "image/png" : "image/jpeg"),
    };
  }

  private t2iInput(prompt: string, aspect: Aspect, seed?: number): Record<string, unknown> {
    return {
      prompt,
      image_size: SIZES[aspect],
      ...(seed !== undefined ? { seed } : {}),
      enable_safety_checker: true,
      output_format: this.outputFormat,
    };
  }

  private dataUri(image: GeneratedImage): string {
    return `data:${image.media_type};base64,${Buffer.from(image.bytes).toString("base64")}`;
  }

  private editInput(prompt: string, reference: GeneratedImage, aspect: Aspect, seed: number): Record<string, unknown> {
    return {
      prompt,
      image_urls: [this.dataUri(reference)],
      image_size: SIZES[aspect],
      seed,
      enable_safety_checker: true,
      output_format: this.outputFormat,
    };
  }

  async generate(req: { prompt: string; aspect: Aspect; count?: number }) {
    const count = Math.max(1, Math.min(5, req.count ?? 1));
    const images: GeneratedImage[] = [];
    for (let i = 0; i < count; i++) images.push(await this.request(this.model, this.t2iInput(req.prompt, req.aspect)));
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

  async generatePack(req: {
    prompts: string[];
    aspect: Aspect;
    seed: number;
    reference?: GeneratedImage;
  }) {
    if (req.prompts.length < 1 || req.prompts.length > 5) {
      throw new ProviderError(`${this.id} generatePack requires 1-5 prompts; received ${req.prompts.length}`);
    }
    if (req.prompts.some((prompt) => !prompt.trim())) {
      throw new ProviderError(`${this.id} generatePack does not accept blank prompts`);
    }
    const prompts = req.prompts.map((prompt) => prompt.trim());

    const anchor = req.reference
      ? await this.request(
          this.editModel,
          this.editInput(
            `${prompts[0]} Preserve the supplied recurring subject identity, wardrobe, proportions, palette and illustration language. Change only the requested physical action, environment state and camera framing.`,
            req.reference,
            req.aspect,
            req.seed,
          ),
        )
      : await this.request(this.model, this.t2iInput(prompts[0]!, req.aspect, req.seed));

    const images: GeneratedImage[] = [anchor];
    for (let i = 1; i < prompts.length; i++) {
      images.push(await this.request(
        this.editModel,
        this.editInput(
          `${prompts[i]} Keep the same characters, wardrobe, facial design, environment design, palette, line weight and illustration style as the supplied scene anchor. Change only the requested camera framing and action.`,
          anchor,
          req.aspect,
          (req.seed + i) & 0x7fffffff,
        ),
      ));
    }

    if (images.length !== prompts.length) {
      throw new ProviderError(`${this.id} generated ${images.length}/${prompts.length} requested pack images`);
    }

    return {
      images,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units: images.length,
        cost_usd: images.length * this.pricePerImage,
        provider: "fal",
        model: `${this.model}+${this.editModel}`,
      } satisfies Usage,
    };
  }
}
