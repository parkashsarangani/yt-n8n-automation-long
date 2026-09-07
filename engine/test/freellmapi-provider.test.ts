import test from "node:test";
import assert from "node:assert/strict";

import { OpenAIProvider } from "../src/providers/openai.ts";
import { ProviderError, ProviderRefusal } from "../src/provider.ts";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const ENV_KEYS = [
  "LLM_ROUTER_MODE",
  "LLM_ROUTER_FAIL_OPEN_TO_DIRECT",
  "LLM_ROUTER_TIMEOUT_MS",
  "FREELLMAPI_BASE_URL",
  "FREELLMAPI_API_KEY",
  "FREELLMAPI_TEXT_MODEL",
  "FREELLMAPI_TEXT_MODELS",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
] as const;

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function freeJson(content = '{"ok":true}', model = "free-actual-model"): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 13, completion_tokens: 5 },
    model,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function sseDirect(content = '{"ok":true}'): Response {
  const chunks = [
    { choices: [{ delta: { content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
  ];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const noWait = { freeRetryDelayMs: 0, sleepImpl: async () => {} } as const;
const THREE = "model-a,model-b,model-c";

test("free text uses the first pinned model and records the actual served route", async () => {
  await withEnv({
    FREELLMAPI_API_KEY: "freellmapi-test",
    FREELLMAPI_BASE_URL: "http://freellmapi:3001/v1",
    FREELLMAPI_TEXT_MODELS: THREE,
  }, async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const provider = new OpenAIProvider({
      ...noWait,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return freeJson();
      },
    });

    const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA, maxOutputTokens: 99 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "http://freellmapi:3001/v1/chat/completions");
    assert.equal(calls[0]!.headers.get("authorization"), "Bearer freellmapi-test");
    assert.equal(calls[0]!.body["model"], "model-a");
    assert.equal(calls[0]!.body["stream"], false);
    assert.deepEqual(calls[0]!.body["response_format"], { type: "json_object" });
    assert.equal(calls[0]!.body["max_completion_tokens"], 99);
    assert.deepEqual(result.value, { ok: true });
    assert.equal(result.usage.provider, "freellmapi");
    assert.equal(result.usage.cost_usd, 0);
    assert.equal(result.providerRef, "freellmapi/free-actual-model");
    assert.match(provider.id, /^freellmapi:\[model-a,model-b,model-c\]$/);
  });
});

test("auto routing anywhere in the pinned list is rejected before any provider call", async () => {
  for (const list of ["auto:smart", "model-a,auto,model-c", "model-a,auto:balanced"]) {
    await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_TEXT_MODELS: list }, async () => {
      let calls = 0;
      assert.throws(
        () => new OpenAIProvider({ ...noWait, fetchImpl: async () => { calls++; return freeJson(); } }),
        /may not contain auto routing/,
      );
      assert.equal(calls, 0);
    });
  }
});

test("a legacy single FREELLMAPI_TEXT_MODEL is still accepted as a one-item chain", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_TEXT_MODEL: "legacy-model" }, async () => {
    const calls: string[] = [];
    const provider = new OpenAIProvider({ ...noWait, fetchImpl: async (_u, init) => { calls.push((JSON.parse(String(init?.body)) as { model: string }).model); return freeJson(); } });
    await provider.complete({ prompt: "hi", outputSchema: SCHEMA });
    assert.deepEqual(calls, ["legacy-model"]);
  });
});

test("a 429 on the primary model moves to the secondary pinned model, never to paid", async () => {
  await withEnv({
    FREELLMAPI_API_KEY: "freellmapi-test",
    FREELLMAPI_TEXT_MODELS: THREE,
    OPENAI_API_KEY: "sk-paid",
  }, async () => {
    const seen: Array<{ url: string; model: string }> = [];
    const provider = new OpenAIProvider({
      apiKey: "sk-paid",
      ...noWait,
      fetchImpl: async (url, init) => {
        const model = (JSON.parse(String(init?.body)) as { model: string }).model;
        seen.push({ url: String(url), model });
        if (model === "model-a") return new Response("quota", { status: 429 });
        return freeJson('{"ok":true}', "model-b-served");
      },
    });

    const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });

    assert.deepEqual(seen.map((s) => s.model), ["model-a", "model-b"]);
    assert.ok(seen.every((s) => s.url.startsWith("http://freellmapi:3001")), "no request may leave the free host");
    assert.equal(result.usage.provider, "freellmapi");
    assert.equal(result.usage.model, "model-b-served");
    assert.equal(result.usage.cost_usd, 0);
  });
});

test("primary and secondary failing falls to the tertiary pinned model", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_TEXT_MODELS: THREE, OPENAI_API_KEY: "sk-paid" }, async () => {
    const models: string[] = [];
    const provider = new OpenAIProvider({
      apiKey: "sk-paid",
      ...noWait,
      fetchImpl: async (_u, init) => {
        const model = (JSON.parse(String(init?.body)) as { model: string }).model;
        models.push(model);
        if (model === "model-a") return new Response("down", { status: 503 });
        if (model === "model-b") return new Response("busy", { status: 429 });
        return freeJson('{"ok":true}', "model-c-served");
      },
    });
    const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });
    assert.deepEqual(models, ["model-a", "model-b", "model-c"]);
    assert.equal(result.usage.model, "model-c-served");
  });
});

test("malformed structured output on one model advances to the next", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_TEXT_MODELS: THREE }, async () => {
    const models: string[] = [];
    const provider = new OpenAIProvider({
      ...noWait,
      fetchImpl: async (_u, init) => {
        const model = (JSON.parse(String(init?.body)) as { model: string }).model;
        models.push(model);
        return model === "model-a" ? freeJson("not-json") : freeJson('{"ok":true}', "model-b-served");
      },
    });
    const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });
    assert.deepEqual(models, ["model-a", "model-b"]);
    assert.equal(result.usage.model, "model-b-served");
  });
});

test("every pinned model unavailable fails explicitly, listing what was tried, with no paid call", async () => {
  await withEnv({
    FREELLMAPI_API_KEY: "k",
    FREELLMAPI_TEXT_MODELS: THREE,
    OPENAI_API_KEY: "sk-paid",
  }, async () => {
    const urls: string[] = [];
    const provider = new OpenAIProvider({
      apiKey: "sk-paid",
      ...noWait,
      fetchImpl: async (url) => { urls.push(String(url)); return new Response("down", { status: 503 }); },
    });

    await assert.rejects(
      () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
      (err: unknown) => err instanceof ProviderError
        && /all 3 configured free text model\(s\) unavailable/.test(err.message)
        && /model-a, model-b, model-c/.test(err.message),
    );
    assert.equal(urls.length, 3, "exactly one attempt per pinned model");
    assert.ok(urls.every((u) => u.startsWith("http://freellmapi:3001")), "no paid OpenAI request may be made");
  });
});

test("a non-retryable caller error is thrown immediately, without trying other models or paid", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_TEXT_MODELS: THREE, OPENAI_API_KEY: "sk-paid" }, async () => {
    const urls: string[] = [];
    const provider = new OpenAIProvider({
      apiKey: "sk-paid",
      ...noWait,
      fetchImpl: async (url) => { urls.push(String(url)); return new Response("bad request", { status: 400 }); },
    });
    await assert.rejects(
      () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
      (err: unknown) => err instanceof ProviderError && /request failed \(400\)/.test(err.message),
    );
    assert.equal(urls.length, 1);
    assert.ok(urls[0]!.startsWith("http://freellmapi:3001"));
  });
});

test("a content-policy refusal is not retried across models", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_TEXT_MODELS: THREE }, async () => {
    let calls = 0;
    const provider = new OpenAIProvider({
      ...noWait,
      fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: "content_policy" }), { status: 400 }); },
    });
    await assert.rejects(
      () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
      (err: unknown) => err instanceof ProviderRefusal,
    );
    assert.equal(calls, 1);
  });
});

test("freellmapi mode with no FreeLLMAPI key fails clearly and never calls paid OpenAI", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-paid" }, async () => {
    const urls: string[] = [];
    const provider = new OpenAIProvider({
      apiKey: "sk-paid",
      ...noWait,
      fetchImpl: async (url) => { urls.push(String(url)); return sseDirect(); },
    });
    await assert.rejects(
      () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
      (err: unknown) => err instanceof ProviderError && /FREELLMAPI_API_KEY/.test(err.message) && /no paid text fallback/.test(err.message),
    );
    assert.deepEqual(urls, [], "no network request of any kind");
  });
});

test("explicit direct rollback mode bypasses the free chain and calls paid OpenAI", async () => {
  await withEnv({
    LLM_ROUTER_MODE: "direct",
    FREELLMAPI_API_KEY: "freellmapi-test",
    FREELLMAPI_TEXT_MODELS: THREE,
    OPENAI_API_KEY: "sk-paid",
  }, async () => {
    const urls: string[] = [];
    const provider = new OpenAIProvider({ apiKey: "sk-paid", ...noWait, fetchImpl: async (url) => { urls.push(String(url)); return sseDirect(); } });
    const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });
    assert.deepEqual(urls, ["https://api.openai.com/v1/chat/completions"]);
    assert.equal(result.usage.provider, "openai");
  });
});
