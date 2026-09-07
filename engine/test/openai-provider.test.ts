import test from "node:test";
import assert from "node:assert/strict";

// This file exercises the explicit paid `direct` path (streaming SSE, bearer
// auth, cost, refusals). Production text is free-only with no automatic paid
// fallback, so reaching `completeDirect` now requires the operator rollback
// switch. Pin it for the whole file; other suites cover the free chain.
process.env["LLM_ROUTER_MODE"] = "direct";
delete process.env["FREELLMAPI_API_KEY"];

import { OpenAIProvider, defaultOpenAIBaseUrl, defaultOpenAIModel, estimateOpenAICost } from "../src/providers/openai.ts";
import { ProviderError, ProviderRefusal } from "../src/provider.ts";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

// Real Chat Completions streaming sends "data: {...}\n\n" per chunk, content
// arriving in delta fragments across many chunks, ending with a literal
// "data: [DONE]\n\n". With stream_options.include_usage, one extra chunk
// carries the final usage totals with an empty choices array.
function sseStream(chunks: Record<string, unknown>[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function okFetch(calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>): typeof fetch {
  return async (url, init) => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return sseStream([
      { choices: [{ delta: { content: '{"ok"' } }] },
      { choices: [{ delta: { content: ":true}" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
    ]);
  };
}

test("OpenAIProvider calls Chat Completions with streaming and a bearer token", async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-luna",
    fetchImpl: okFetch(calls),
  });

  const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA, maxOutputTokens: 99, effort: "medium" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[0]!.headers["authorization"], "Bearer sk-test");
  assert.equal(calls[0]!.body["model"], "gpt-5.6-luna");
  assert.equal(calls[0]!.body["stream"], true);
  assert.deepEqual(calls[0]!.body["stream_options"], { include_usage: true });
  assert.equal(calls[0]!.body["max_completion_tokens"], 99);
  assert.equal(calls[0]!.body["reasoning_effort"], "medium");
  assert.deepEqual(calls[0]!.body["response_format"], { type: "json_object" });
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.usage.provider, "openai");
  assert.equal(result.usage.model, "gpt-5.6-luna");
  assert.equal(result.usage.input_tokens, 11);
  assert.equal(result.usage.output_tokens, 7);
  assert.equal(result.providerRef, "openai/gpt-5.6-luna");
});

test("thinking: false maps to reasoning_effort: none", async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: okFetch(calls) });

  await provider.complete({ prompt: "hi", outputSchema: SCHEMA, thinking: false });

  assert.equal(calls[0]!.body["reasoning_effort"], "none");
});

test("no API key is a clear provider error, not a crash at construction", async () => {
  const provider = new OpenAIProvider({ apiKey: undefined, fetchImpl: async () => sseStream([]) });
  await assert.rejects(
    () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
    /OPENAI_API_KEY is not set/,
  );
});

test("finish_reason length is a hard provider error naming the budget used", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetchImpl: async () => sseStream([
      { choices: [{ delta: { content: "{}" }, finish_reason: "length" }] },
    ]),
  });
  await assert.rejects(
    () => provider.complete({ prompt: "hi", outputSchema: SCHEMA, maxOutputTokens: 12 }),
    /hit max_tokens \(12\)/,
  );
});

test("finish_reason content_filter surfaces as a ProviderRefusal", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetchImpl: async () => sseStream([
      { choices: [{ delta: { content: "" }, finish_reason: "content_filter" }] },
    ]),
  });
  await assert.rejects(
    () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
    (err: unknown) => err instanceof ProviderRefusal && err.category === "content_filter",
  );
});

test("non-JSON content despite json_object mode is a provider error, not a silent bad parse", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetchImpl: async () => sseStream([
      { choices: [{ delta: { content: "not json" }, finish_reason: "stop" }] },
    ]),
  });
  await assert.rejects(
    () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
    (err: unknown) => err instanceof ProviderError && /returned non-JSON/.test(err.message),
  );
});

test("streaming assembles content spread across many delta chunks", async () => {
  const fragments = ['{"o', 'k":', "tr", "ue", "}"];
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetchImpl: async () => sseStream([
      ...fragments.map((content) => ({ choices: [{ delta: { content } }] })),
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } },
    ]),
  });

  const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });

  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.usage.input_tokens, 3);
  assert.equal(result.usage.output_tokens, 5);
});

test("defaults resolve from environment", () => {
  assert.equal(defaultOpenAIModel({}), "gpt-5.6-luna");
  assert.equal(defaultOpenAIModel({ OPENAI_MODEL: "gpt-5.6-terra" }), "gpt-5.6-terra");
  assert.equal(defaultOpenAIBaseUrl({}), "https://api.openai.com/v1");
});

test("cost estimate matches the published per-tier pricing", () => {
  // Luna: $0.20 input / $1.20 output per 1M tokens.
  assert.equal(estimateOpenAICost("gpt-5.6-luna", 1_000_000, 1_000_000), 0.2 + 1.2);
  assert.equal(estimateOpenAICost("unknown-model", 1_000_000, 1_000_000), 0);
});
