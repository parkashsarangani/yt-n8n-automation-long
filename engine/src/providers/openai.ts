/**
 * OpenAI model provider (RFC 0004).
 *
 * Chat Completions with streaming: today's Ollama incident showed exactly
 * what a non-streaming call costs on any output that takes a while to
 * generate -- the client waits for a complete response before it sees any
 * bytes, and if that crosses a timeout the request dies with a generic
 * error indistinguishable from a real connectivity problem. Streaming
 * avoids that entirely, the same reason anthropic.ts already streams.
 *
 * response_format is left at "json_object" (guaranteed-valid JSON, not
 * schema-enforced "json_schema" strict mode) rather than OpenAI's stricter
 * structured-outputs mode, which requires every property to be listed in
 * `required` -- incompatible with this registry's schemas, which use
 * genuinely optional fields throughout. The schema is still sent as prompt
 * grounding; the registry's own validation on write remains the strict,
 * authoritative gate, matching the same division of responsibility already
 * used for Ollama.
 */

import {
  ProviderError,
  ProviderRefusal,
  relaxForStructuredOutput,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
  type ProviderCapabilities,
} from "../provider.ts";

export const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export interface OpenAIProviderOptions {
  /** Defaults to OPENAI_MODEL, then gpt-5.6-luna. */
  model?: string;
  /** Defaults to OPENAI_API_KEY. Required -- there is no fallback. */
  apiKey?: string;
  /** Defaults to OPENAI_BASE_URL, then the public API. */
  baseUrl?: string;
  /** Defaults to 8192. Agent max_output_tokens overrides this per call. */
  maxOutputTokens?: number;
  effort?: CompletionRequest["effort"];
  fetchImpl?: typeof fetch;
}

function cleanEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function defaultOpenAIModel(env: NodeJS.ProcessEnv = process.env): string {
  return cleanEnv(env["OPENAI_MODEL"]) ?? DEFAULT_OPENAI_MODEL;
}

export function defaultOpenAIBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return cleanEnv(env["OPENAI_BASE_URL"]) ?? DEFAULT_OPENAI_BASE_URL;
}

function outputPrompt(prompt: string, schema: unknown): string {
  // json_object mode guarantees syntactically valid JSON but does not
  // enforce a shape, so the schema still has to ground the model the same
  // way it does for Ollama. The registry validates strictly afterward.
  return `${prompt}\n\nReturn only one JSON object matching this JSON Schema. Do not wrap it in markdown.\n${JSON.stringify(schema)}`;
}

/**
 * Chat Completions streams one SSE "data: {...}" line per chunk, ending
 * with a literal "data: [DONE]" line. With stream_options.include_usage,
 * one extra chunk carries the final usage totals (its choices array is
 * empty). Concatenate delta.content across chunks and keep the last
 * finish_reason/usage seen.
 */
async function readOpenAIStream(res: Response): Promise<{ content: string; finishReason: string | null; usage: OpenAIStreamChunk["usage"] }> {
  const body = res.body;
  if (!body) throw new ProviderError("openai stream response had no body");

  let content = "";
  let finishReason: string | null = null;
  let usage: OpenAIStreamChunk["usage"] = null;
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;

        const chunk = JSON.parse(data) as OpenAIStreamChunk;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) content += choice.delta.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { content, finishReason, usage };
}

export class OpenAIProvider implements ModelProvider {
  readonly id: string;
  private readonly model: string;
  // Not required at construction time: rebuild() in service.ts constructs
  // every provider unconditionally on every credential change, including
  // before an API key has ever been entered, so the server can still boot
  // and show the credentials UI. Failing happens lazily, on the first real
  // call, the same way the original AnthropicProvider did.
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultEffort: CompletionRequest["effort"];
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.model = opts.model ?? defaultOpenAIModel();
    this.apiKey = opts.apiKey ?? cleanEnv(process.env["OPENAI_API_KEY"]);
    this.baseUrl = (opts.baseUrl ?? defaultOpenAIBaseUrl()).replace(/\/$/, "");
    this.defaultMaxTokens = opts.maxOutputTokens ?? 8192;
    this.defaultEffort = opts.effort ?? "medium";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.id = `openai/${this.model}`;
  }

  capabilities(): ProviderCapabilities {
    return { structuredOutput: "native", maxOutputTokens: 128_000 };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const providerRef = `openai/${this.model}`;
    const apiKey = this.apiKey;
    if (!apiKey) throw new ProviderError(`${providerRef} request failed: OPENAI_API_KEY is not set`);
    const schema = relaxForStructuredOutput(req.outputSchema);
    const effort = req.effort ?? this.defaultEffort;
    const maxTokens = req.maxOutputTokens ?? this.defaultMaxTokens;

    const body = {
      model: this.model,
      messages: [{ role: "user", content: outputPrompt(req.prompt, schema) }],
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: "json_object" },
      max_completion_tokens: maxTokens,
      reasoning_effort: req.thinking === false ? "none" : effort,
    };

    let result: { content: string; finishReason: string | null; usage: OpenAIStreamChunk["usage"] };
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 400 && /content_?policy|safety/i.test(text)) {
          throw new ProviderRefusal(`${providerRef} declined the request`, "policy");
        }
        throw new ProviderError(`${providerRef} request failed (${res.status}): ${text.slice(0, 500)}`);
      }
      result = await readOpenAIStream(res);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`${providerRef} request failed: ${String(err)}`);
    }

    if (result.finishReason === "length") {
      throw new ProviderError(`${providerRef} hit max_tokens (${maxTokens}); output is truncated`);
    }
    if (result.finishReason === "content_filter") {
      throw new ProviderRefusal(`${providerRef} declined the request`, "content_filter");
    }
    if (!result.content) throw new ProviderError(`${providerRef} returned no content`);

    let value: unknown;
    try {
      value = JSON.parse(result.content);
    } catch {
      throw new ProviderError(`${providerRef} returned non-JSON despite structured output: ${result.content.slice(0, 300)}`);
    }

    return {
      value,
      usage: {
        input_tokens: result.usage?.prompt_tokens ?? 0,
        output_tokens: result.usage?.completion_tokens ?? 0,
        cost_usd: estimateOpenAICost(this.model, result.usage?.prompt_tokens ?? 0, result.usage?.completion_tokens ?? 0),
        provider: "openai",
        model: this.model,
      },
      providerRef,
    };
  }
}

interface Price {
  /** USD per million tokens. */
  input: number;
  output: number;
}

/**
 * Prices as of 2026-08-24 (post the 2026-07-30 Luna/Terra cut; Sol
 * unchanged). Verified against openai.com/api/pricing, not assumed.
 */
const PRICES: Record<string, Price> = {
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-sol": { input: 5, output: 30 },
};

export function estimateOpenAICost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model];
  if (!price) return 0; // unknown model: report zero rather than invent a rate
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
