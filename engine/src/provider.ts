/**
 * Provider abstraction (RFC 0004).
 *
 * Agents declare a capability ("reasoning_high"), never a vendor or model id.
 * A profile maps capabilities to concrete providers, so swapping models is
 * configuration. Cost accounting happens here and nowhere else.
 */

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  /** Non-token providers (TTS characters, images, render seconds). */
  units?: number | null;
  cost_usd: number;
  provider: string;
  model: string;
}

export interface CompletionRequest {
  prompt: string;
  /** JSON Schema the response must satisfy. Relaxed per provider capability. */
  outputSchema: Record<string, unknown>;
  maxOutputTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface CompletionResult {
  value: unknown;
  usage: Usage;
  /** Concrete "vendor/model" actually used, recorded on the artifact. */
  providerRef: string;
}

export interface ProviderCapabilities {
  structuredOutput: "native" | "emulated" | "none";
  maxOutputTokens: number;
}

export interface ModelProvider {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** Text to speech, for the voice worker (RFC 0004). */
export interface SpeechProvider {
  readonly id: string;
  synthesize(req: {
    text: string;
    voice: string;
    /** Neighbouring narration, for prosody continuity across many clips. */
    context?: { prev?: string; next?: string };
  }): Promise<{
    audio: Uint8Array;
    media_type: string;
    /** Word/character timings, when the provider returns them. */
    alignment?: unknown;
    duration_sec?: number;
    usage: Usage;
  }>;
}

/** Image generation, for the asset collector worker (RFC 0004). */
export type Aspect = "9:16" | "16:9" | "1:1";

export interface ImageProvider {
  readonly id: string;
  generate(req: {
    prompt: string;
    aspect: Aspect;
    count?: number;
  }): Promise<{
    images: Array<{ bytes: Uint8Array; media_type: string }>;
    usage: Usage;
  }>;
  /**
   * Optional: a provider that can also supply real stock video b-roll for the
   * same search terms. Returns null (not a rejected promise) when the source
   * has no video for this query, so the asset collector can fall through to
   * a still image the same way it already falls through primary -> fallback.
   */
  generateVideo?(req: {
    prompt: string;
    aspect: Aspect;
  }): Promise<{
    video: { bytes: Uint8Array; media_type: string };
    usage: Usage;
  } | null>;
}

/** One scene as the renderer needs it: audio, optional image, timing data. */
export interface RenderScene {
  scene_index: number;
  audio: Uint8Array;
  audio_media_type: string;
  /** Absent for a degraded scene; the renderer substitutes a house placeholder. */
  image?: Uint8Array;
  image_media_type?: string;
  /** Real stock footage for this scene, mutually exclusive with `image`. */
  video?: Uint8Array;
  video_media_type?: string;
  /** Word/character timings, for burned-in captions. */
  alignment?: unknown;
  is_outro?: boolean;
  /** If set, the renderer uses a motion graphics template for this scene. */
  template_category?: string;
  template_data?: Record<string, unknown>;
  /** Active speaker's cast name/color, for caption speaker attribution. Cartoon runs only. */
  speaker_name?: string;
  speaker_color?: string;
}

export interface RenderRequest {
  scenes: RenderScene[];
  caption_style?: string;
  comment_hook?: string;
  thumbnail?: { image?: Uint8Array; text?: string; accent?: string };
}

export interface RenderResult {
  video: Uint8Array;
  media_type: string;
  thumbnail?: { bytes: Uint8Array; media_type: string };
  duration_sec?: number;
  render_time_sec?: number;
  degraded_scenes?: number;
  usage: Usage;
}

/**
 * Video assembly (RFC 0004).
 *
 * Polling is an implementation detail — the promise resolves when the render is
 * done. But the JOB IDENTITY is exposed via `onJob`, because a 20-minute render
 * that dies with the process is unrecoverable if nobody wrote the job id down.
 * See the RFC 0004 note in engine/README.md.
 */
/**
 * Performance data for a published episode (RFC 0004, layer 6).
 *
 * Metrics are split deliberately. The core set is guaranteed by the platform's
 * deprecation policy; the discovery set — thumbnail impressions and click rate —
 * is the one that actually tells you whether a thumbnail worked, and its
 * availability is not something we can assume. Providers report which of the
 * requested metrics came back so downstream reasoning can tell "the number was
 * zero" from "the number does not exist here".
 */
export interface EpisodeMetrics {
  views: number;
  estimated_minutes_watched: number;
  average_view_duration_sec: number;
  average_view_percentage: number | null;
  subscribers_gained: number;
  likes: number;
  comments: number;
  shares: number;
  /** Thumbnail impressions, when the platform exposes them. */
  impressions: number | null;
  /** Click-through rate as a fraction (0..1), when exposed. */
  click_through_rate: number | null;
  /** Metrics that were asked for and not returned, with the reason. */
  unavailable: string[];
}

export interface AnalyticsWindow {
  /** ISO date, inclusive. */
  start_date: string;
  end_date: string;
}

export type Visibility = "public" | "unlisted" | "private" | "unknown";

export interface AnalyticsProvider {
  readonly id: string;
  fetchEpisodeMetrics(
    externalId: string,
    window: AnalyticsWindow,
  ): Promise<{ metrics: EpisodeMetrics; usage: Usage }>;
  /**
   * Current visibility of each video, batched.
   *
   * Must be read live rather than taken from the published_episode artifact:
   * episodes are uploaded private on purpose and made public by hand later, so
   * the value recorded at publish time is stale almost immediately and would
   * permanently exclude everything.
   */
  fetchVisibility(externalIds: string[]): Promise<Record<string, Visibility>>;
}

export interface ThumbnailRequest {
  /** Background photo. Omitted or unusable, the renderer falls back to a gradient. */
  image?: Uint8Array;
  text: string;
  /** Contiguous phrase within `text` set large in the accent colour. */
  emphasis?: string;
  accent?: string;
}

export interface ThumbnailResult {
  bytes: Uint8Array;
  media_type: string;
  width: number;
  height: number;
  /** What the renderer actually used — "supplied" or "gradient". */
  background: "supplied" | "gradient";
  usage: Usage;
}

export interface MediaRenderer {
  readonly id: string;

  /**
   * Composite a thumbnail without rendering a video.
   *
   * Separate from render() on purpose. A thumbnail is the highest-leverage
   * asset and the cheapest to make; tying it to a ten-minute encode would mean
   * a five-word text change costs a full re-render.
   */
  renderThumbnail(req: ThumbnailRequest): Promise<ThumbnailResult>;

  render(
    req: RenderRequest,
    opts?: { onJob?: (jobId: string) => void | Promise<void>; signal?: AbortSignal },
  ): Promise<RenderResult>;
}

/**
 * What a destination will accept. The rest of the system reads THIS rather than
 * knowing anything about a specific platform — that is what makes YouTube a
 * plugin instead of a privileged destination (RFC 0001, Distribution layer).
 */
export interface TargetRequirements {
  aspects: Aspect[];
  max_duration_sec?: number;
  max_title_chars: number;
  max_description_chars?: number;
  /** Maximum number of tags. */
  max_tags?: number;
  /**
   * Total characters across all tags combined.
   *
   * Distinct from max_tags and the one that actually bites: YouTube's documented
   * limit is 500 characters in aggregate, not 500 tags. Fifteen 40-character
   * tags is a legal tag *count* and an illegal upload.
   */
  max_tag_chars?: number;
  /** Platform requires declaring AI-generated content. */
  requires_synthetic_media_disclosure?: boolean;
  supports_custom_thumbnail?: boolean;
}

export interface PublishMetadata {
  title: string;
  description?: string;
  tags?: string[];
  privacy?: "public" | "unlisted" | "private";
  made_for_kids?: boolean;
}

export interface PublishRequest {
  video: Uint8Array;
  media_type: string;
  thumbnail?: { bytes: Uint8Array; media_type: string };
  metadata: PublishMetadata;
  duration_sec?: number;
}

export interface PublishResult {
  external_id: string;
  url: string;
  /** False when the platform refused the thumbnail (e.g. unverified channel). */
  thumbnail_set: boolean;
  synthetic_media_disclosed: boolean;
  usage: Usage;
}

export interface PublishTarget {
  readonly id: string;
  requirements(): TargetRequirements;
  publish(
    req: PublishRequest,
    opts?: { onProgress?: (detail: string) => void | Promise<void> },
  ): Promise<PublishResult>;
}

export class ProviderError extends Error {
  override name = "ProviderError";
}

/** Raised when a provider's safety layer declines the request (RFC 0004). */
export class ProviderRefusal extends ProviderError {
  override name = "ProviderRefusal";
  constructor(
    message: string,
    readonly category: string | null,
  ) {
    super(message);
  }
}

/** Maps capability names to providers. The whole of "models are swappable". */
export class ProviderRouter {
  constructor(private readonly profiles: Record<string, ModelProvider>) { }

  forCapability(capability: string): ModelProvider {
    const p = this.profiles[capability];
    if (!p) {
      throw new ProviderError(
        `no provider configured for capability "${capability}" ` +
        `(have: ${Object.keys(this.profiles).join(", ") || "none"})`,
      );
    }
    return p;
  }
}

/**
 * Project a registry schema onto the subset structured outputs can enforce.
 *
 * Structured outputs reject numeric, string-length, array-length and conditional
 * constraints. Our registry schemas use all of them, so the schema sent to the
 * provider is a relaxed projection while the registry schema remains the strict
 * validator on write (RFC 0007). Stripped scalar constraints are appended to the
 * field's `description`; conditional branches are omitted entirely because the
 * provider grammar cannot compile `if`/`then`/`else`.
 */
const STRIPPED: Record<string, (v: unknown) => string> = {
  minimum: (v) => `minimum ${String(v)}`,
  maximum: (v) => `maximum ${String(v)}`,
  exclusiveMinimum: (v) => `greater than ${String(v)}`,
  exclusiveMaximum: (v) => `less than ${String(v)}`,
  multipleOf: (v) => `a multiple of ${String(v)}`,
  minLength: (v) => `at least ${String(v)} characters`,
  maxLength: (v) => `at most ${String(v)} characters`,
  pattern: (v) => `matching /${String(v)}/`,
  minItems: (v) => `at least ${String(v)} items`,
  maxItems: (v) => `at most ${String(v)} items`,
  uniqueItems: () => `all items distinct`,
};

const CONDITIONAL_KEYS = new Set(["if", "then", "else"]);

function containsConditional(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsConditional);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) => CONDITIONAL_KEYS.has(key) || containsConditional(nested),
  );
}

export function relaxForStructuredOutput(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(relaxForStructuredOutput);
  if (schema === null || typeof schema !== "object") return schema;

  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const notes: string[] = [];

  for (const [key, value] of Object.entries(src)) {
    const describe = STRIPPED[key];
    if (describe) {
      notes.push(describe(value));
      continue;
    }

    // Anthropic structured outputs reject conditional JSON Schema keywords.
    // Drop a whole allOf branch when it carries an if/then/else condition; doing
    // so avoids leaving a meaningless `{}` branch behind. The original registry
    // schema is untouched and remains authoritative after model generation.
    if (CONDITIONAL_KEYS.has(key)) continue;
    if (key === "allOf" && Array.isArray(value)) {
      const branches = value
        .filter((branch) => !containsConditional(branch))
        .map(relaxForStructuredOutput);
      if (branches.length > 0) out[key] = branches;
      continue;
    }

    out[key] = relaxForStructuredOutput(value);
  }

  if (notes.length > 0) {
    const existing = typeof out["description"] === "string" ? `${out["description"]} ` : "";
    out["description"] = `${existing}(${notes.join(", ")})`;
  }
  return out;
}

/**
 * Wrap a payload schema so the model returns confidence alongside it.
 *
 * Confidence belongs to the envelope, not the payload (RFC 0002 — it must not
 * affect the content hash), but it has to come back from the same call. The
 * provider therefore sees `{payload, confidence}` and the runner unwraps.
 */
export function wrapWithConfidence(
  payloadSchema: unknown,
  dimensions: string[] = [],
): Record<string, unknown> {
  const dimProps: Record<string, unknown> = {};
  for (const d of dimensions) {
    dimProps[d] = { type: "number", description: `Self-assessed ${d} in [0,1].` };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["payload", "confidence"],
    properties: {
      payload: payloadSchema,
      confidence: {
        type: "object",
        additionalProperties: false,
        required: ["overall"],
        properties: {
          overall: {
            type: "number",
            description:
              "Your honest self-assessment in [0,1]. A low score on weak input is " +
              "more useful than false certainty; it routes the work to a human.",
          },
          ...(dimensions.length > 0
            ? {
              dimensions: {
                type: "object",
                additionalProperties: false,
                required: dimensions,
                properties: dimProps,
              },
            }
            : {}),
        },
      },
    },
  };
}
