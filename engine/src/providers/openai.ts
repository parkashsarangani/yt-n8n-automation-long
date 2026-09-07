/**
 * OpenAI-compatible reasoning provider (RFC 0004).
 *
 * Production is free-only: when LLM_ROUTER_MODE is not `direct`, requests walk
 * an explicit ordered chain of concrete free FreeLLMAPI models. A model that is
 * rate-limited / 5xx / times out / returns malformed content hands off to the
 * next id in the list. When every configured model is unavailable the request
 * FAILS — there is no automatic paid-OpenAI fallback. `direct` mode stays as a
 * manual operator rollback that calls paid OpenAI, but nothing selects it
 * automatically.
 *
 * FreeLLMAPI's OpenAI-compatible response is deliberately non-streaming because
 * its router aggregates hosted provider responses. response_format stays at
 * `json_object`; the registry remains the strict authoritative schema
 * validator after generation.
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
import { llmRoutingConfig, type LlmRoutingConfig } from "../llm-routing.ts";

export const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

interface OpenAIJsonResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  model?: string;
}

export interface OpenAIProviderOptions {
  /** Direct paid fallback model. Defaults to OPENAI_MODEL, then gpt-5.6-luna. */
  model?: string;
  /** Direct paid fallback key. Free-first operation does not require it. */
  apiKey?: string;
  /** Direct paid fallback base URL. */
  baseUrl?: string;
  /** Defaults to 8192. Agent max_output_tokens overrides this per call. */
  maxOutputTokens?: number;
  effort?: CompletionRequest["effort"];
  fetchImpl?: typeof fetch;
  /** Total FreeLLM attempts before paid fail-open. Default 2. */
  freeAttempts?: number;
  freeRetryDelayMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
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
  return `${prompt}\n\nSTRUCTURED OUTPUT CONTRACT:\nReturn exactly one JSON object matching the JSON Schema below. Do not use markdown or commentary. Copy property names exactly; do not invent or rename keys; do not add properties where additionalProperties is false; include every required field; every array element must have the schema-declared type. The confidence envelope is required and confidence.overall must be a numeric value from 0 to 1. Before responding, silently verify the JSON structure against the schema.\n${JSON.stringify(schema)}`;
}

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

function structuredBody(
  model: string,
  req: CompletionRequest,
  defaultMaxTokens: number,
  defaultEffort: CompletionRequest["effort"],
  stream: boolean,
): Record<string, unknown> {
  const schema = relaxForStructuredOutput(req.outputSchema);
  const effort = req.effort ?? defaultEffort;
  const maxTokens = req.maxOutputTokens ?? defaultMaxTokens;
  return {
    model,
    messages: [{ role: "user", content: outputPrompt(req.prompt, schema) }],
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    response_format: { type: "json_object" },
    max_completion_tokens: maxTokens,
    reasoning_effort: req.thinking === false ? "none" : effort,
  };
}

function parsedJson(providerRef: string, content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new ProviderError(`${providerRef} returned non-JSON despite structured output: ${content.slice(0, 300)}`);
  }
}

function retryableFreeReasoningError(err: unknown): boolean {
  if (err instanceof ProviderRefusal) return false;
  const message = err instanceof Error ? err.message : String(err);
  // Caller/policy errors will be identical on an immediate retry. Everything
  // else gets one bounded free retry: network/timeout, 429/5xx, truncated/no
  // content, or a model returning non-JSON despite json_object mode.
  if (/request failed \((?:400|401|403|404|413)\)/.test(message)) return false;
  return true;
}

export class OpenAIProvider implements ModelProvider {
  readonly id: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultEffort: CompletionRequest["effort"];
  private readonly fetchImpl: typeof fetch;
  private readonly freeAttempts: number;
  private readonly freeRetryDelayMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.model = opts.model ?? defaultOpenAIModel();
    this.apiKey = opts.apiKey ?? cleanEnv(process.env["OPENAI_API_KEY"]);
    this.baseUrl = (opts.baseUrl ?? defaultOpenAIBaseUrl()).replace(/\/$/, "");
    this.defaultMaxTokens = opts.maxOutputTokens ?? 8192;
    this.defaultEffort = opts.effort ?? "medium";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.freeAttempts = Math.max(1, Math.min(3, opts.freeAttempts ?? 2));
    this.freeRetryDelayMs = Math.max(0, opts.freeRetryDelayMs ?? 350);
    this.sleepImpl = opts.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const routing = llmRoutingConfig();
    this.id = routing.mode === "direct"
      ? `openai/${this.model}`
      : `freellmapi:[${routing.textModels.join(",")}]`;
  }

  capabilities(): ProviderCapabilities {
    return { structuredOutput: "native", maxOutputTokens: 128_000 };
  }

  /**
   * Text completion.
   *
   * `direct` mode is an explicit manual operator rollback and calls paid
   * OpenAI. The default `freellmapi` mode walks the ordered free-model chain
   * and, when every model is unavailable, fails loudly. There is deliberately
   * NO automatic paid fallback: exhausting the free list is a real outage the
   * caller must see, not a reason to start spending.
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const routing = llmRoutingConfig();
    if (routing.mode === "direct") return this.completeDirect(req);
    if (!routing.apiKey) {
      throw new ProviderError("FreeLLMAPI reasoning requires FREELLMAPI_API_KEY (there is no paid text fallback)");
    }

    const attempted: string[] = [];
    let lastError: unknown;
    for (const model of routing.textModels) {
      try {
        return await this.completeFree(req, routing, model);
      } catch (err) {
        // A refusal or a caller/schema error is identical on every model.
        if (err instanceof ProviderRefusal) throw err;
        if (!retryableFreeReasoningError(err)) throw err;
        attempted.push(model);
        lastError = err;
        // Cost/observability signal only; never log prompt or response bodies.
        console.warn(`[llm-routing] free text model ${model} unavailable; trying next pinned model`);
        if (this.freeRetryDelayMs > 0 && attempted.length < routing.textModels.length) {
          await this.sleepImpl(this.freeRetryDelayMs);
        }
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new ProviderError(
      `all ${attempted.length} configured free text model(s) unavailable [${attempted.join(", ")}]: ${detail}`,
    );
  }

  private async completeFree(req: CompletionRequest, routing: LlmRoutingConfig, model: string): Promise<CompletionResult> {
    const providerRef = `freellmapi/${model}`;
    if (!routing.apiKey) throw new ProviderError(`${providerRef} request failed: FREELLMAPI_API_KEY is not set`);

    const maxTokens = req.maxOutputTokens ?? this.defaultMaxTokens;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), routing.timeoutMs);
    let data: OpenAIJsonResponse;
    try {
      const res = await this.fetchImpl(`${routing.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${routing.apiKey}`,
        },
        body: JSON.stringify(structuredBody(model, req, this.defaultMaxTokens, this.defaultEffort, false)),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 400 && /content_?policy|safety/i.test(text)) {
          throw new ProviderRefusal(`${providerRef} declined the request`, "policy");
        }
        throw new ProviderError(`${providerRef} request failed (${res.status})`);
      }
      data = await res.json() as OpenAIJsonResponse;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`${providerRef} request failed: ${err instanceof Error ? err.name : "network error"}`);
    } finally {
      clearTimeout(timer);
    }

    const choice = data.choices?.[0];
    const finishReason = choice?.finish_reason ?? null;
    if (finishReason === "length") {
      throw new ProviderError(`${providerRef} hit max_tokens (${maxTokens}); output is truncated`);
    }
    if (finishReason === "content_filter") {
      throw new ProviderRefusal(`${providerRef} declined the request`, "content_filter");
    }
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content) throw new ProviderError(`${providerRef} returned no content`);

    const actualModel = typeof data.model === "string" && data.model.trim() ? data.model.trim() : model;
    return {
      value: parsedJson(providerRef, content),
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
        cost_usd: 0,
        provider: "freellmapi",
        model: actualModel,
      },
      providerRef: `freellmapi/${actualModel}`,
    };
  }

  private async completeDirect(req: CompletionRequest): Promise<CompletionResult> {
    const providerRef = `openai/${this.model}`;
    const apiKey = this.apiKey;
    if (!apiKey) throw new ProviderError(`${providerRef} request failed: OPENAI_API_KEY is not set`);
    const maxTokens = req.maxOutputTokens ?? this.defaultMaxTokens;

    let result: { content: string; finishReason: string | null; usage: OpenAIStreamChunk["usage"] };
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(structuredBody(this.model, req, this.defaultMaxTokens, this.defaultEffort, true)),
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

    return {
      value: parsedJson(providerRef, result.content),
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

const PRICES: Record<string, Price> = {
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-sol": { input: 5, output: 30 },
};

export function estimateOpenAICost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model];
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
