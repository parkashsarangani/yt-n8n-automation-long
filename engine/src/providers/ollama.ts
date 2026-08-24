/**
 * Ollama local model provider (RFC 0004).
 *
 * Owns the only reasoning LLM call path for local/offline production. Agents
 * still request capabilities; this adapter maps those requests to an Ollama
 * model exposed by the local Docker service.
 */

import {
  ProviderError,
  relaxForStructuredOutput,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
  type ProviderCapabilities,
} from "../provider.ts";

export const DEFAULT_OLLAMA_MODEL = "llama3.1:8b";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

interface OllamaMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface OllamaChatResponse {
  model?: string;
  created_at?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  error?: string;
}

export interface OllamaProviderOptions {
  /** Defaults to OLLAMA_MODEL, then llama3.1:8b. */
  model?: string;
  /** Defaults to OLLAMA_FAST_MODEL, then OLLAMA_MODEL, then model. */
  fastModel?: string;
  /** Defaults to OLLAMA_BASE_URL, OLLAMA_HOST, then localhost. */
  baseUrl?: string;
  /** Defaults to 8192. Agent max_output_tokens overrides this per call. */
  maxOutputTokens?: number;
  /** Optional context window passed as options.num_ctx. */
  numCtx?: number;
  effort?: CompletionRequest["effort"];
  fetchImpl?: typeof fetch;
}

function cleanEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function defaultOllamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return cleanEnv(env["OLLAMA_BASE_URL"]) ?? cleanEnv(env["OLLAMA_HOST"]) ?? DEFAULT_OLLAMA_BASE_URL;
}

export function defaultOllamaModel(env: NodeJS.ProcessEnv = process.env): string {
  return cleanEnv(env["OLLAMA_MODEL"]) ?? DEFAULT_OLLAMA_MODEL;
}

export function defaultOllamaFastModel(env: NodeJS.ProcessEnv = process.env): string {
  return cleanEnv(env["OLLAMA_FAST_MODEL"]) ?? defaultOllamaModel(env);
}

export function selectOllamaModel(
  effort: CompletionRequest["effort"] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return effort === "low" ? defaultOllamaFastModel(env) : defaultOllamaModel(env);
}

function maybeNumber(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function temperatureFor(effort: CompletionRequest["effort"] | undefined): number {
  if (effort === "low") return 0.15;
  if (effort === "medium") return 0.2;
  return 0.25;
}

/**
 * Ollama's streaming /api/chat sends one JSON object per line: a sequence of
 * partial-content chunks, then a final line carrying done: true plus the
 * full usage stats (total_duration, eval_count, ...). Concatenate the
 * content fragments and keep the final line's metadata for the result.
 */
async function readOllamaStream(res: Response): Promise<OllamaChatResponse> {
  const body = res.body;
  if (!body) throw new ProviderError("ollama stream response had no body");

  let content = "";
  let final: OllamaChatResponse | null = null;
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
        if (!line) continue;

        const chunk = JSON.parse(line) as OllamaChatResponse;
        if (chunk.error) throw new ProviderError(`ollama stream error: ${chunk.error}`);
        if (chunk.message?.content) content += chunk.message.content;
        if (chunk.done) final = chunk;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!final) throw new ProviderError("ollama stream ended without a final done chunk");
  return { ...final, message: { ...final.message, content } };
}

function outputPrompt(prompt: string, schema: unknown): string {
  // Ollama's structured output format constrains the response, but its docs
  // also recommend grounding the model by including the schema in the prompt.
  // Keep this short and explicit: the strict registry validation still happens
  // after the call.
  return `${prompt}\n\nReturn only one JSON object matching this JSON Schema. Do not wrap it in markdown.\n${JSON.stringify(schema)}`;
}

export class OllamaProvider implements ModelProvider {
  readonly id: string;
  private readonly model: string;
  private readonly fastModel: string;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultEffort: CompletionRequest["effort"];
  private readonly numCtx: number | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaProviderOptions = {}) {
    this.model = opts.model ?? defaultOllamaModel();
    this.fastModel = opts.fastModel ?? defaultOllamaFastModel();
    this.baseUrl = (opts.baseUrl ?? defaultOllamaBaseUrl()).replace(/\/$/, "");
    this.defaultMaxTokens = opts.maxOutputTokens ?? 8192;
    this.defaultEffort = opts.effort ?? "high";
    this.numCtx = opts.numCtx ?? maybeNumber(process.env["OLLAMA_NUM_CTX"]);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.id = `ollama/${this.model}`;
  }

  capabilities(): ProviderCapabilities {
    return { structuredOutput: "native", maxOutputTokens: 64_000 };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const schema = relaxForStructuredOutput(req.outputSchema);
    const effort = req.effort ?? this.defaultEffort;
    const model = effort === "low" ? this.fastModel : this.model;
    const providerRef = `ollama/${model}`;
    const maxTokens = req.maxOutputTokens ?? this.defaultMaxTokens;

    const body = {
      model,
      messages: [
        {
          role: "user",
          content: outputPrompt(req.prompt, schema),
        } satisfies OllamaMessage,
      ],
      // Non-streaming (stream: false) makes Ollama buffer the entire
      // generation server-side and send nothing -- not even response
      // headers -- until it is fully done. Any node whose output takes
      // longer than undici's ~300s default headersTimeout (routine for
      // this pipeline's larger agents: dialogue_script_writer alone needs
      // up to 18000 tokens) hits a generic "fetch failed" every time,
      // indistinguishable from a real connectivity problem. Streaming
      // sends headers and the first chunk almost immediately and keeps
      // the connection actively flowing, avoiding that ceiling entirely.
      stream: true,
      format: schema,
      options: {
        temperature: temperatureFor(effort),
        num_predict: maxTokens,
        ...(this.numCtx ? { num_ctx: this.numCtx } : {}),
      },
    };

    let response: OllamaChatResponse;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new ProviderError(`${providerRef} request failed (${res.status}): ${text.slice(0, 500)}`);
      }
      response = await readOllamaStream(res);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`${providerRef} request failed: ${String(err)}`);
    }

    if (response.error) throw new ProviderError(`${providerRef} request failed: ${response.error}`);
    if (response.done_reason === "length") {
      throw new ProviderError(`${providerRef} hit max_tokens (${maxTokens}); output is truncated`);
    }

    const text = response.message?.content;
    if (!text) throw new ProviderError(`${providerRef} returned no message content`);

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ProviderError(`${providerRef} returned non-JSON despite structured output: ${text.slice(0, 300)}`);
    }

    return {
      value,
      usage: {
        input_tokens: response.prompt_eval_count ?? 0,
        output_tokens: response.eval_count ?? 0,
        units: response.total_duration ?? null,
        cost_usd: 0,
        provider: "ollama",
        model,
      },
      providerRef,
    };
  }
}

export function estimateOllamaCost(_model: string, _inputTokens: number, _outputTokens: number): number {
  return 0;
}
