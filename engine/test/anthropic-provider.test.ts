import test from "node:test";
import assert from "node:assert/strict";

import { AnthropicProvider, effectiveAnthropicModel, supportsAdaptiveThinking, supportsOutputConfigEffort } from "../src/providers/anthropic.ts";
import { OllamaProvider, defaultOllamaBaseUrl, selectOllamaModel } from "../src/providers/ollama.ts";
import { ProviderError } from "../src/provider.ts";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

// Real Ollama streaming sends one JSON object per line: content arrives in
// fragments across several lines, then a final line carries done: true plus
// the full usage stats. Model these tests on that shape, not a single blob,
// since that is what OllamaProvider actually has to parse now.
function ndjsonStream(lines: Record<string, unknown>[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

function okFetch(calls: Array<{ url: string; body: Record<string, unknown> }>): typeof fetch {
  return async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return ndjsonStream([
      { model: "llama3.1:8b", message: { role: "assistant", content: '{"ok"' } },
      { model: "llama3.1:8b", message: { role: "assistant", content: ":true}" } },
      {
        model: "llama3.1:8b",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 11,
        eval_count: 7,
        total_duration: 123,
      },
    ]);
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
  assert.equal(calls[0]!.body["stream"], true);
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
    fetchImpl: async () => ndjsonStream([
      { model: "llama3.1:8b", message: { role: "assistant", content: "{}" }, done: true, done_reason: "length" },
    ]),
  });
  await assert.rejects(
    () => lengthProvider.complete({ prompt: "hi", outputSchema: SCHEMA, maxOutputTokens: 12 }),
    /hit max_tokens \(12\)/,
  );

  const proseProvider = new OllamaProvider({
    fetchImpl: async () => ndjsonStream([
      { model: "llama3.1:8b", message: { role: "assistant", content: "not json" }, done: true, done_reason: "stop" },
    ]),
  });
  await assert.rejects(
    () => proseProvider.complete({ prompt: "hi", outputSchema: SCHEMA }),
    (err: unknown) => err instanceof ProviderError && /returned non-JSON/.test(err.message),
  );
});

test("streaming assembles content spread across many chunks, not just headers/body timing", async () => {
  // The bug this whole file exists to catch: stream:false made Ollama
  // withhold the response until generation was fully done, which silently
  // dies past undici's default headers timeout on any output larger than
  // a few hundred tokens (routine for this pipeline). This asserts the
  // provider actually reassembles a real multi-chunk stream correctly,
  // not just that it flips a stream:true flag in the request body.
  const fragments = ['{"o', 'k":', "tr", "ue", "}"];
  const provider = new OllamaProvider({
    fetchImpl: async () => ndjsonStream([
      ...fragments.map((content) => ({ model: "llama3.1:8b", message: { role: "assistant", content } })),
      { model: "llama3.1:8b", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 5, prompt_eval_count: 3, total_duration: 42 },
    ]),
  });

  const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });

  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.usage.output_tokens, 5);
  assert.equal(result.usage.input_tokens, 3);
});

test("a stream that never sends a final done chunk is a clear provider error, not a silent hang", async () => {
  const provider = new OllamaProvider({
    fetchImpl: async () => ndjsonStream([
      { model: "llama3.1:8b", message: { role: "assistant", content: '{"ok":true}' } },
    ]),
  });

  await assert.rejects(
    () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
    /ended without a final done chunk/,
  );
});

test("an error chunk mid-stream surfaces immediately as a provider error", async () => {
  const provider = new OllamaProvider({
    fetchImpl: async () => ndjsonStream([
      { model: "llama3.1:8b", message: { role: "assistant", content: '{"ok"' } },
      { error: "model runner crashed" },
    ]),
  });

  await assert.rejects(
    () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
    /model runner crashed/,
  );
});
