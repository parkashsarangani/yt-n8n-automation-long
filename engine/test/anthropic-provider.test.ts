import test from "node:test";
import assert from "node:assert/strict";

import { AnthropicProvider, effectiveAnthropicModel, supportsAdaptiveThinking, supportsOutputConfigEffort } from "../src/providers/anthropic.ts";
import { OllamaProvider, defaultOllamaBaseUrl, selectOllamaModel } from "../src/providers/ollama.ts";
import { ProviderError } from "../src/provider.ts";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

function okFetch(calls: Array<{ url: string; body: Record<string, unknown> }>): typeof fetch {
  return async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({
      model: "llama3.1:8b",
      message: { role: "assistant", content: '{"ok":true}' },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 11,
      eval_count: 7,
      total_duration: 123,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("OllamaProvider calls the local /api/chat structured-output endpoint", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const provider = new OllamaProvider({
    baseUrl: "http://ollama:11434",
    model: "llama3.1:8b",
    fetchImpl: okFetch(calls),
    numCtx: 32768,
  });

  const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA, maxOutputTokens: 99 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://ollama:11434/api/chat");
  assert.equal(calls[0]!.body["model"], "llama3.1:8b");
  assert.equal(calls[0]!.body["stream"], false);
  assert.deepEqual(calls[0]!.body["format"], SCHEMA);
  assert.deepEqual((calls[0]!.body["options"] as Record<string, unknown>)["num_predict"], 99);
  assert.deepEqual((calls[0]!.body["options"] as Record<string, unknown>)["num_ctx"], 32768);
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.usage.provider, "ollama");
  assert.equal(result.usage.model, "llama3.1:8b");
  assert.equal(result.usage.cost_usd, 0);
  assert.equal(result.providerRef, "ollama/llama3.1:8b");
});

test("low effort can route to the configured fast local model", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const provider = new OllamaProvider({
    baseUrl: "http://ollama:11434",
    model: "llama3.1:8b",
    fastModel: "gemma3:4b",
    fetchImpl: okFetch(calls),
  });

  await provider.complete({ prompt: "cheap", outputSchema: SCHEMA, effort: "low" });

  assert.equal(calls[0]!.body["model"], "gemma3:4b");
});

test("AnthropicProvider compatibility shim still uses Ollama only", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalBase = process.env["OLLAMA_BASE_URL"];
  const originalModel = process.env["OLLAMA_MODEL"];
  process.env["OLLAMA_BASE_URL"] = "http://ollama:11434";
  process.env["OLLAMA_MODEL"] = "llama3.1:8b";

  try {
    const provider = new AnthropicProvider({ model: "claude-sonnet-5", fetchImpl: okFetch(calls) });
    const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });

    assert.equal(calls[0]!.url, "http://ollama:11434/api/chat");
    assert.equal(calls[0]!.body["model"], "llama3.1:8b");
    assert.equal(result.providerRef, "ollama/llama3.1:8b");
    assert.equal(result.usage.provider, "ollama");
  } finally {
    if (originalBase === undefined) delete process.env["OLLAMA_BASE_URL"];
    else process.env["OLLAMA_BASE_URL"] = originalBase;
    if (originalModel === undefined) delete process.env["OLLAMA_MODEL"];
    else process.env["OLLAMA_MODEL"] = originalModel;
  }
});

test("Anthropic routing helper names the selected Ollama model", () => {
  assert.equal(supportsAdaptiveThinking("claude-sonnet-5"), false);
  assert.equal(supportsOutputConfigEffort("claude-sonnet-5"), false);
  assert.equal(selectOllamaModel("medium", { OLLAMA_MODEL: "llama3.1:8b" }), "llama3.1:8b");
  assert.equal(selectOllamaModel("low", { OLLAMA_MODEL: "llama3.1:8b", OLLAMA_FAST_MODEL: "gemma3:4b" }), "gemma3:4b");
  assert.equal(effectiveAnthropicModel("claude-sonnet-5", "medium"), selectOllamaModel("medium"));
  assert.equal(defaultOllamaBaseUrl({}), "http://localhost:11434");
});

test("Ollama length and non-JSON failures are hard provider errors", async () => {
  const lengthProvider = new OllamaProvider({
    fetchImpl: async () => new Response(JSON.stringify({
      model: "llama3.1:8b",
      message: { role: "assistant", content: "{}" },
      done: true,
      done_reason: "length",
    })),
  });
  await assert.rejects(
    () => lengthProvider.complete({ prompt: "hi", outputSchema: SCHEMA, maxOutputTokens: 12 }),
    /hit max_tokens \(12\)/,
  );

  const proseProvider = new OllamaProvider({
    fetchImpl: async () => new Response(JSON.stringify({
      model: "llama3.1:8b",
      message: { role: "assistant", content: "not json" },
      done: true,
      done_reason: "stop",
    })),
  });
  await assert.rejects(
    () => proseProvider.complete({ prompt: "hi", outputSchema: SCHEMA }),
    (err: unknown) => err instanceof ProviderError && /returned non-JSON/.test(err.message),
  );
});
