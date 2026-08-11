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
  constructor(private readonly profiles: Record<string, ModelProvider>) {}

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
 * Structured outputs reject numeric, string-length, and array-length
 * constraints. Our registry schemas use all three, so the schema sent to the
 * provider is a relaxed projection while the registry schema remains the strict
 * validator on write (RFC 0007). Stripped constraints are appended to the
 * field's `description`, so the model still receives them as instruction — the
 * difference is that they become guidance rather than a hard grammar
 * constraint, enforced by validate-and-retry instead.
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
