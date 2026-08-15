/**
 * Deterministic in-memory provider for tests and dry runs.
 *
 * Exists so the runner, agents, and graph can be tested with zero network and
 * zero cost — which is only possible because agents are pure functions of their
 * inputs (RFC 0003 rule 2).
 */

import { createHash } from "node:crypto";
import {
  ProviderError,
  ProviderRefusal,
  type Aspect,
  type CompletionRequest,
  type CompletionResult,
  type AnalyticsProvider,
  type AnalyticsWindow,
  type EpisodeMetrics,
  type ImageProvider,
  type MediaRenderer,
  type ModelProvider,
  type ProviderCapabilities,
  type PublishRequest,
  type PublishTarget,
  type RenderRequest,
  type ThumbnailRequest,
  type ThumbnailResult,
  type SpeechProvider,
  type TargetRequirements,
} from "../provider.ts";

export type FakeHandler = (
  req: CompletionRequest,
  attempt: number,
) => unknown | { __refuse: string };

export class FakeProvider implements ModelProvider {
  readonly id: string;
  /** Every request received, in order — assert against this in tests. */
  readonly calls: CompletionRequest[] = [];
  private attempt = 0;

  constructor(
    private readonly handler: FakeHandler,
    id = "fake/deterministic",
  ) {
    this.id = id;
  }

  capabilities(): ProviderCapabilities {
    return { structuredOutput: "native", maxOutputTokens: 64_000 };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    const value = this.handler(req, this.attempt++);
    if (value && typeof value === "object" && "__refuse" in value) {
      throw new ProviderRefusal(
        `fake provider refused: ${String((value as { __refuse: string }).__refuse)}`,
        String((value as { __refuse: string }).__refuse),
      );
    }
    return {
      value,
      usage: {
        input_tokens: Math.ceil(req.prompt.length / 4),
        output_tokens: 100,
        cost_usd: 0,
        provider: "fake",
        model: this.id,
      },
      providerRef: this.id,
    };
  }
}

/** Deterministic bytes derived from the input, so identical inputs dedup. */
function fakeBytes(seed: string, size = 64): Uint8Array {
  const out = new Uint8Array(size);
  let digest = createHash("sha256").update(seed).digest();
  for (let i = 0; i < size; i++) {
    if (i % 32 === 0 && i > 0) digest = createHash("sha256").update(digest).digest();
    out[i] = digest[i % 32]!;
  }
  return out;
}

export class FakeSpeechProvider implements SpeechProvider {
  readonly id = "fake/speech";
  readonly calls: Array<{ text: string; voice: string; prev?: string; next?: string }> = [];
  /** Texts that should fail, to exercise worker error paths. */
  constructor(private readonly failOn: (text: string) => boolean = () => false) {}

  async synthesize(req: {
    text: string;
    voice: string;
    context?: { prev?: string; next?: string };
  }) {
    this.calls.push({
      text: req.text,
      voice: req.voice,
      ...(req.context?.prev !== undefined ? { prev: req.context.prev } : {}),
      ...(req.context?.next !== undefined ? { next: req.context.next } : {}),
    });
    if (this.failOn(req.text)) throw new ProviderError(`fake speech failed for: ${req.text}`);
    return {
      audio: fakeBytes(`audio:${req.voice}:${req.text}`),
      media_type: "audio/mpeg",
      alignment: { characters: [...req.text], note: "fake alignment" },
      duration_sec: Math.max(1, req.text.split(/\s+/).length / 2.5),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units: req.text.length,
        cost_usd: 0,
        provider: "fake",
        model: this.id,
      },
    };
  }
}

export class FakeImageProvider implements ImageProvider {
  readonly id = "fake/image";
  readonly prompts: string[] = [];
  constructor(private readonly failOn: (prompt: string) => boolean = () => false) {}

  async generate(req: { prompt: string; aspect: Aspect; count?: number }) {
    this.prompts.push(req.prompt);
    if (this.failOn(req.prompt)) throw new ProviderError(`fake image failed for: ${req.prompt}`);
    const n = req.count ?? 1;
    return {
      images: Array.from({ length: n }, (_, i) => ({
        bytes: fakeBytes(`image:${req.aspect}:${req.prompt}:${i}`, 128),
        media_type: "image/png",
      })),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units: n,
        cost_usd: 0,
        provider: "fake",
        model: this.id,
      },
    };
  }
}

export class FakeRenderer implements MediaRenderer {
  readonly id = "fake/renderer";
  readonly requests: RenderRequest[] = [];
  readonly thumbnailRequests: ThumbnailRequest[] = [];
  readonly jobIds: string[] = [];
  constructor(private readonly failWith?: string) {}

  async renderThumbnail(req: ThumbnailRequest): Promise<ThumbnailResult> {
    this.thumbnailRequests.push(req);
    if (this.failWith) throw new ProviderError(this.failWith);
    return {
      // Deterministic in the text, so an identical brief yields an identical
      // artifact id — the property the artifact model depends on.
      bytes: fakeBytes(`thumb:${req.text}`, 96),
      media_type: "image/png",
      width: 1280,
      height: 720,
      background: req.image ? "supplied" : "gradient",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units: 1,
        cost_usd: 0,
        provider: this.id,
        model: "fake-thumbnail",
      },
    };
  }

  async render(
    req: RenderRequest,
    opts: { onJob?: (jobId: string) => void | Promise<void> } = {},
  ) {
    this.requests.push(req);
    const jobId = `fakejob_${this.requests.length}`;
    this.jobIds.push(jobId);
    // Surface the job id before doing the work, exactly as a real async job
    // service would, so the caller can record it.
    if (opts.onJob) await opts.onJob(jobId);
    if (this.failWith) throw new ProviderError(this.failWith);

    const seed = req.scenes.map((s) => s.scene_index).join(",");
    return {
      video: fakeBytes(`video:${seed}`, 256),
      media_type: "video/mp4",
      thumbnail: req.thumbnail
        ? { bytes: fakeBytes(`thumb:${seed}`, 96), media_type: "image/png" }
        : undefined,
      duration_sec: req.scenes.length * 12,
      render_time_sec: 42,
      degraded_scenes: req.scenes.filter((s) => !s.image).length,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units: 42,
        cost_usd: 0,
        provider: "fake",
        model: this.id,
      },
    };
  }
}

export class FakePublishTarget implements PublishTarget {
  readonly id: string;
  readonly published: PublishRequest[] = [];

  constructor(
    private readonly opts: {
      id?: string;
      requirements?: Partial<TargetRequirements>;
      /** Simulate a platform refusing the thumbnail (unverified channel). */
      rejectThumbnail?: boolean;
      failWith?: string;
    } = {},
  ) {
    this.id = opts.id ?? "fake-target";
  }

  requirements(): TargetRequirements {
    return {
      aspects: ["16:9"],
      max_title_chars: 100,
      max_description_chars: 5000,
      max_tags: 50,
      requires_synthetic_media_disclosure: true,
      supports_custom_thumbnail: true,
      ...this.opts.requirements,
    };
  }

  async publish(req: PublishRequest) {
    this.published.push(req);
    if (this.opts.failWith) throw new ProviderError(this.opts.failWith);
    const id = `fakevid_${this.published.length}`;
    return {
      external_id: id,
      url: `https://example.test/${id}`,
      thumbnail_set: Boolean(req.thumbnail) && !this.opts.rejectThumbnail,
      synthetic_media_disclosed: true,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units: 1,
        cost_usd: 0,
        provider: "fake",
        model: this.id,
      },
    };
  }
}

/**
 * Deterministic analytics, derived from the video id so a given episode always
 * reports the same numbers.
 */
export class FakeAnalyticsProvider implements AnalyticsProvider {
  readonly id = "fake/analytics";
  readonly calls: Array<{ externalId: string; window: AnalyticsWindow }> = [];

  constructor(
    private readonly opts: {
      /** Simulate a platform that does not expose thumbnail impressions. */
      withoutDiscoveryMetrics?: boolean;
      failWith?: string;
      overrides?: Partial<EpisodeMetrics>;
    } = {},
  ) {}

  async fetchEpisodeMetrics(externalId: string, window: AnalyticsWindow) {
    this.calls.push({ externalId, window });
    if (this.opts.failWith) throw new ProviderError(this.opts.failWith);

    const seed = createHash("sha256").update(externalId).digest();
    const n = (i: number, mod: number) => seed[i]! % mod;

    const views = n(0, 5000) + 50;
    const noDiscovery = this.opts.withoutDiscoveryMetrics === true;

    return {
      metrics: {
        views,
        estimated_minutes_watched: views * (n(1, 6) + 1),
        average_view_duration_sec: n(2, 400) + 60,
        average_view_percentage: (n(3, 60) + 10),
        subscribers_gained: n(4, 50),
        likes: n(5, 300),
        comments: n(6, 60),
        shares: n(7, 40),
        impressions: noDiscovery ? null : views * (n(8, 20) + 5),
        click_through_rate: noDiscovery ? null : (n(9, 90) + 10) / 1000,
        unavailable: noDiscovery
          ? ["videoThumbnailImpressions, videoThumbnailImpressionsClickRate (not supported)"]
          : [],
        ...this.opts.overrides,
      } satisfies EpisodeMetrics,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        units: 1,
        cost_usd: 0,
        provider: "fake",
        model: this.id,
      },
    };
  }
}
