/**
 * OpenAI-compatible reasoning provider (RFC 0004).
 *
 * Production text is free-first: when LLM_ROUTER_MODE is not `direct`,
 * requests walk an explicit ordered chain of concrete FreeLLMAPI models that
 * are eligible for the requested structured-output size. Removed models, 413
 * incompatibility, transient failures, malformed JSON and schema-invalid JSON
 * advance to the next free candidate. After all eligible free candidates are
 * exhausted, paid OpenAI is used only when PAID_TEXT_FALLBACK is enabled.
 *
 * Free-gateway authentication failures (401/403), caller errors and policy
 * refusals are terminal and never trigger paid escalation.
 */

import RawAjv2020 from "ajv/dist/2020.js";
import rawAddFormats from "ajv-formats";
import {
  ProviderError,
  ProviderRefusal,
  relaxForStructuredOutput,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
  type ProviderCapabilities,
} from "../provider.ts";
import {
  eligibleFreeTextModels,
  llmRoutingConfig,
  type LlmRoutingConfig,
} from "../llm-routing.ts";
import { fallbackPolicy } from "../fallback-policy.ts";

const Ajv2020 = ((RawAjv2020 as unknown as { default?: unknown }).default ??
  RawAjv2020) as typeof RawAjv2020;
const addFormats = ((rawAddFormats as unknown as { default?: unknown }).default ??
  rawAddFormats) as typeof rawAddFormats;
const responseAjv = new Ajv2020({ allErrors: true, strict: false });
addFormats(responseAjv);

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
  /** Retained for constructor compatibility; the model chain itself is bounded. */
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

/**
 * Paid model backing the `reasoning_script` capability. The audio-first channel
 * lives or dies on the narration script, so it is authored on OpenAI's strongest
 * model (GPT-6 Astra) rather than the deployment's ordinary paid tier. Override
 * with SCRIPT_MODEL to dial it back without touching agent data.
 */
export const DEFAULT_SCRIPT_MODEL = "gpt-6-astra";
export function scriptAuthoringModel(env: NodeJS.ProcessEnv = process.env): string {
  return cleanEnv(env["SCRIPT_MODEL"]) ?? DEFAULT_SCRIPT_MODEL;
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

function assertExactStructuredOutput(
  providerRef: string,
  schema: Record<string, unknown>,
  value: unknown,
): void {
  let validate: ReturnType<typeof responseAjv.compile>;
  try {
    validate = responseAjv.compile(schema);
  } catch (err) {
    throw new ProviderError(`${providerRef} could not compile requested output schema: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (validate(value)) return;
  const detail = (validate.errors ?? [])
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");
  throw new ProviderError(`${providerRef} returned schema-invalid structured output: ${detail || "unknown schema mismatch"}`);
}

function retryableFreeReasoningError(err: unknown): boolean {
  if (err instanceof ProviderRefusal) return false;
  const message = err instanceof Error ? err.message : String(err);
  // 400 is a caller/schema contract error. 401/403 are credential/permission
  // failures and must never be converted into paid spend. A 404 means a stale
  // model pin and a 413 means this model cannot serve this payload: both are
  // candidate incompatibilities, so advance through the free chain.
  if (/request failed \((?:400|401|403)\)/.test(message)) return false;
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
  private readonly freeRetryDelayMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.model = opts.model ?? defaultOpenAIModel();
    this.apiKey = opts.apiKey ?? cleanEnv(process.env["OPENAI_API_KEY"]);
    this.baseUrl = (opts.baseUrl ?? defaultOpenAIBaseUrl()).replace(/\/$/, "");
    this.defaultMaxTokens = opts.maxOutputTokens ?? 8192;
    this.defaultEffort = opts.effort ?? "medium";
    this.fetchImpl = opts.fetchImpl ?? fetch;
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

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const routing = llmRoutingConfig();
    if (routing.mode === "direct") return this.completeDirect(req);
    const paidTextFallbackAllowed = fallbackPolicy().paidTextFallback && Boolean(this.apiKey);

    // A spend-authorizing judge/reviser (e.g. watchability_critic and its
    // paired script reviser) is calibrated against the strong paid model. When
    // paid text is available, grade/write on it directly rather than on a free
    // model whose scores cluster differently. If paid is not available this
    // falls through to the ordinary free chain — never a hard failure.
    if (req.preferPaidReasoning && paidTextFallbackAllowed) {
      console.warn("[llm-routing] preferPaidReasoning: spend-authorizing evaluation graded on the paid model; free chain skipped");
      return this.completeDirect(req);
    }

    if (!routing.apiKey) {
      if (paidTextFallbackAllowed) {
        console.warn("[llm-routing] FREELLMAPI_API_KEY not set; using paid OpenAI text fallback (PAID_TEXT_FALLBACK=true)");
        return this.completeDirect(req);
      }
      throw new ProviderError(
        "FreeLLMAPI reasoning requires FREELLMAPI_API_KEY and no paid text fallback is available (PAID_TEXT_FALLBACK disabled or OPENAI_API_KEY unset)",
      );
    }

    const maxTokens = req.maxOutputTokens ?? this.defaultMaxTokens;
    const eligibleModels = eligibleFreeTextModels(routing.textModels, maxTokens);
    const skippedModels = routing.textModels.filter((model) => !eligibleModels.includes(model));
    if (skippedModels.length > 0) {
      console.warn(
        `[llm-routing] skipping free text model(s) not admitted for ${maxTokens}-token structured output: ${skippedModels.join(", ")}`,
      );
    }
    if (eligibleModels.length === 0) {
      if (paidTextFallbackAllowed) {
        console.warn(
          `[llm-routing] no configured free model is eligible for ${maxTokens}-token structured output; using paid OpenAI text fallback`,
        );
        return this.completeDirect(req);
      }
      throw new ProviderError(
        `no configured free text model is eligible for ${maxTokens}-token structured output and paid text fallback is disabled`,
      );
    }

    const attempted: string[] = [];
    let lastError: unknown;
    for (const model of eligibleModels) {
      try {
        return await this.completeFree(req, routing, model);
      } catch (err) {
        if (err instanceof ProviderRefusal) throw err;
        if (!retryableFreeReasoningError(err)) throw err;
        attempted.push(model);
        lastError = err;
        console.warn(`[llm-routing] free text model ${model} unsuitable/unavailable; trying next eligible model`);
        if (this.freeRetryDelayMs > 0 && attempted.length < eligibleModels.length) {
          await this.sleepImpl(this.freeRetryDelayMs);
        }
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    if (paidTextFallbackAllowed) {
      console.warn(
        `[llm-routing] all ${attempted.length} eligible free text model(s) exhausted [${attempted.join(", ")}]; using paid OpenAI text fallback (PAID_TEXT_FALLBACK=true)`,
      );
      return this.completeDirect(req);
    }
    throw new ProviderError(
      `all ${attempted.length} eligible free text model(s) unavailable [${attempted.join(", ")}] and paid text fallback is disabled: ${detail}`,
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

    const value = parsedJson(providerRef, content);
    assertExactStructuredOutput(providerRef, req.outputSchema, value);
    const actualModel = typeof data.model === "string" && data.model.trim() ? data.model.trim() : model;
    return {
      value,
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
  // Standard tier. Prompts over 272K input tokens bill higher upstream; the
  // script author's payloads sit far below that, so the base rate is the
  // faithful estimate here.
  "gpt-6-astra": { input: 10, output: 50 },
};

export function estimateOpenAICost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model];
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
