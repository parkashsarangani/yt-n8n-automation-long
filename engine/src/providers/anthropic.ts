/**
 * Anthropic model provider (RFC 0004).
 *
 * The only file in the system that knows Anthropic exists. Owns request shape,
 * structured-output handling, refusal handling, and the price table.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  ProviderError,
  ProviderRefusal,
  relaxForStructuredOutput,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
  type ProviderCapabilities,
} from "../provider.ts";

interface Price {
  /** USD per million tokens. */
  input: number;
  output: number;
  /** Optional promotional rate, applied while `introUntil` is in the future. */
  intro?: { input: number; output: number; until: string };
}

/**
 * Prices are declared here because RFC 0004 puts cost accounting at the adapter
 * boundary — this is the single place rates are written down.
 */
const PRICES: Record<string, Price> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": {
    input: 3,
    output: 15,
    intro: { input: 2, output: 10, until: "2026-08-31T23:59:59Z" },
  },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const SONNET_MODEL = "claude-sonnet-5";
const LOW_EFFORT_MODEL = "claude-haiku-4-5";

export function effectiveAnthropicModel(
  configuredModel: string,
  effort: CompletionRequest["effort"],
): string {
  // The service keeps provider routing capability-based. For token savings,
  // low-risk agents mark their requests as low effort; those calls use Haiku
  // even when the configured capability provider is Sonnet. Medium/high core
  // creative calls remain on the configured model.
  if (configuredModel === SONNET_MODEL && effort === "low") return LOW_EFFORT_MODEL;
  return configuredModel;
}

function isHaikuModel(model: string): boolean {
  return model.toLowerCase().includes("haiku");
}

export function supportsAdaptiveThinking(model: string): boolean {
  // Anthropic returns 400 for adaptive thinking on Haiku. Keep thinking on the
  // Sonnet/Opus family where it is supported, but omit the field entirely for
  // Haiku so cheap low-effort calls remain valid.
  return !isHaikuModel(model);
}

export function supportsOutputConfigEffort(model: string): boolean {
  // Haiku also rejects output_config.effort. Keep the effort knob for models
  // that support it, but do not send unsupported model-specific parameters to
  // Haiku.
  return !isHaikuModel(model);
}

export interface AnthropicProviderOptions {
  model: string;
  apiKey?: string;
  /** Defaults to 8192. Requests stream, so this can safely go well into five figures without hitting the SDK's non-streaming ~10-minute limit. */
  maxOutputTokens?: number;
  effort?: CompletionRequest["effort"];
  client?: Anthropic;
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultEffort: CompletionRequest["effort"];

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model;
    this.id = `anthropic/${opts.model}`;
    this.defaultMaxTokens = opts.maxOutputTokens ?? 8192;
    this.defaultEffort = opts.effort ?? "high";
    this.client =
      opts.client ??
      new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  capabilities(): ProviderCapabilities {
    return { structuredOutput: "native", maxOutputTokens: 64_000 };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Structured outputs cannot express length/range constraints, so the model
    // receives a relaxed projection and the registry stays the strict validator
    // on write (RFC 0007). Stripped constraints survive as descriptions.
    const schema = relaxForStructuredOutput(req.outputSchema);
    const effort = req.effort ?? this.defaultEffort;
    const model = effectiveAnthropicModel(this.model, effort);
    const providerRef = `anthropic/${model}`;
    const outputConfig = {
      ...(supportsOutputConfigEffort(model) ? { effort } : {}),
      format: { type: "json_schema", schema },
    };

    let response;
    try {
      // The SDK refuses a non-streaming request outright once its own estimate
      // of completion time crosses ~10 minutes (a real risk once max_tokens
      // gets into five figures, which several agents' output budgets now do) —
      // streaming is the documented way around that limit, not a workaround.
      // finalMessage() returns the same accumulated Message shape create()
      // does, so nothing below this needs to know the request was streamed.
      const stream = this.client.messages.stream({
        model,
        max_tokens: req.maxOutputTokens ?? this.defaultMaxTokens,
        ...(supportsAdaptiveThinking(model) ? { thinking: { type: "adaptive" } } : {}),
        output_config: outputConfig,
        messages: [{ role: "user", content: req.prompt }],
      } as Parameters<Anthropic["messages"]["stream"]>[0]);
      response = await stream.finalMessage();
    } catch (err) {
      throw new ProviderError(`${providerRef} request failed: ${String(err)}`);
    }

    const msg = response as Anthropic.Message & {
      stop_details?: { category?: string | null } | null;
    };

    // Check stop_reason before touching content: on a refusal, content is empty
    // or partial, and indexing into it blindly is the classic crash here.
    if (msg.stop_reason === "refusal") {
      throw new ProviderRefusal(
        `${providerRef} declined the request`,
        msg.stop_details?.category ?? null,
      );
    }
    if (msg.stop_reason === "max_tokens") {
      throw new ProviderError(
        `${providerRef} hit max_tokens (${req.maxOutputTokens ?? this.defaultMaxTokens}); ` +
          `output is truncated`,
      );
    }

    const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    if (!text) {
      throw new ProviderError(`${providerRef} returned no text block`);
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // With native structured output this should be unreachable; if it fires,
      // the schema was rejected or the model fell back to prose.
      throw new ProviderError(
        `${providerRef} returned non-JSON despite structured output: ${text.slice(0, 300)}`,
      );
    }

    return {
      value,
      usage: {
        input_tokens: msg.usage.input_tokens,
        output_tokens: msg.usage.output_tokens,
        cost_usd: estimateCost(model, msg.usage.input_tokens, msg.usage.output_tokens),
        provider: "anthropic",
        model,
      },
      providerRef,
    };
  }
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  now: Date = new Date(),
): number {
  const price = PRICES[model];
  if (!price) return 0; // unknown model: report zero rather than invent a rate
  const rate =
    price.intro && now < new Date(price.intro.until)
      ? { input: price.intro.input, output: price.intro.output }
      : { input: price.input, output: price.output };
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
