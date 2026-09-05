import test from "node:test";
import assert from "node:assert/strict";

import { OpenAIProvider } from "../src/providers/openai.ts";
import { ProviderError } from "../src/provider.ts";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const ENV_KEYS = [
  "LLM_ROUTER_MODE",
  "LLM_ROUTER_FAIL_OPEN_TO_DIRECT",
  "LLM_ROUTER_TIMEOUT_MS",
  "FREELLMAPI_BASE_URL",
  "FREELLMAPI_API_KEY",
  "FREELLMAPI_TEXT_MODEL",
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

test("free-first reasoning uses pinned Gemini through shared FreeLLMAPI and records the actual route", async () => {
  await withEnv({
    FREELLMAPI_API_KEY: "freellmapi-test",
    FREELLMAPI_BASE_URL: "http://freellmapi:3001/v1",
    FREELLMAPI_TEXT_MODEL: "gemini-2.5-flash",
  }, async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const provider = new OpenAIProvider({
      ...noWait,
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return freeJson();
      },
    });

    const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA, maxOutputTokens: 99 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "http://freellmapi:3001/v1/chat/completions");
    assert.equal(calls[0]!.headers.get("authorization"), "Bearer freellmapi-test");
    assert.equal(calls[0]!.body["model"], "gemini-2.5-flash");
    assert.equal(calls[0]!.body["stream"], false);
    assert.deepEqual(calls[0]!.body["response_format"], { type: "json_object" });
    assert.equal(calls[0]!.body["max_completion_tokens"], 99);
    const message = ((calls[0]!.body["messages"] as Array<{ content: string }>)[0]!.content);
    assert.match(message, /Copy property names exactly/);
    assert.match(message, /confidence\.overall/);
    assert.deepEqual(result.value, { ok: true });
    assert.equal(result.usage.provider, "freellmapi");
    assert.equal(result.usage.model, "free-actual-model");
    assert.equal(result.usage.cost_usd, 0);
    assert.equal(result.providerRef, "freellmapi/free-actual-model");
  });
});

test("FreeLLM auto text routing is rejected before any provider call", async () => {
  await withEnv({
    FREELLMAPI_API_KEY: "freellmapi-test",
    FREELLMAPI_TEXT_MODEL: "auto:smart",
  }, async () => {
    let calls = 0;
    const provider = new OpenAIProvider({
      ...noWait,
      fetchImpl: async () => {
        calls++;
        return freeJson();
      },
    });
    await assert.rejects(
      () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
      /may not use auto routing/,
    );
    assert.equal(calls, 0);
  });
});

test("transient FreeLLMAPI failure gets a second free attempt before direct paid fallback", async () => {
  await withEnv({
    FREELLMAPI_API_KEY: "freellmapi-test",
    OPENAI_API_KEY: "sk-paid",
    OPENAI_MODEL: "gpt-5.6-luna",
  }, async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new OpenAIProvider({
      apiKey: "sk-paid",
      model: "gpt-5.6-luna",
      ...noWait,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        if (calls.length <= 2) return new Response("quota", { status: 429 });
        return sseDirect();
      },
    });

    const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });

    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.url, "http://freellmapi:3001/v1/chat/completions");
    assert.equal(calls[1]!.url, "http://freellmapi:3001/v1/chat/completions");
    assert.equal(calls[2]!.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[2]!.body["model"], "gpt-5.6-luna");
    assert.equal(calls[2]!.body["stream"], true, "paid fallback must retain the existing SSE path");
    assert.equal(result.usage.provider, "openai");
    assert.equal(result.providerRef, "openai/gpt-5.6-luna");
    assert.ok(result.usage.cost_usd > 0);
  });
});

test("malformed FreeLLM structured output is retried on FreeLLM before paid fallback", async () => {
  await withEnv({
    FREELLMAPI_API_KEY: "freellmapi-test",
    OPENAI_API_KEY: "sk-paid",
  }, async () => {
    const urls: string[] = [];
    const provider = new OpenAIProvider({
      apiKey: "sk-paid",
      ...noWait,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return urls.length === 1 ? freeJson("not-json") : freeJson('{"ok":true}', "free-recovered");
      },
    });

    const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });
    assert.deepEqual(urls, [
      "http://freellmapi:3001/v1/chat/completions",
      "http://freellmapi:3001/v1/chat/completions",
    ]);
    assert.equal(result.usage.provider, "freellmapi");
    assert.equal(result.usage.model, "free-recovered");
  });
});

test("non-retryable FreeLLM caller error goes directly to configured fail-open", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "freellmapi-test", OPENAI_API_KEY: "sk-paid" }, async () => {
    const urls: string[] = [];
    const provider = new OpenAIProvider({
      apiKey: "sk-paid",
      ...noWait,
      fetchImpl: async (url) => {
        urls.push(String(url));
        if (urls.length === 1) return new Response("bad request", { status: 400 });
        return sseDirect();
      },
    });
    const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });
    assert.deepEqual(urls, [
      "http://freellmapi:3001/v1/chat/completions",
      "https://api.openai.com/v1/chat/completions",
    ]);
    assert.equal(result.usage.provider, "openai");
  });
});

test("direct rollback mode bypasses FreeLLMAPI even when its key is configured", async () => {
  await withEnv({
    LLM_ROUTER_MODE: "direct",
    FREELLMAPI_API_KEY: "freellmapi-test",
    OPENAI_API_KEY: "sk-paid",
  }, async () => {
    const urls: string[] = [];
    const provider = new OpenAIProvider({
      apiKey: "sk-paid",
      ...noWait,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return sseDirect();
      },
    });

    await provider.complete({ prompt: "hi", outputSchema: SCHEMA });
    assert.deepEqual(urls, ["https://api.openai.com/v1/chat/completions"]);
  });
});

test("strict free mode retries free but never spends paid fallback", async () => {
  await withEnv({
    LLM_ROUTER_FAIL_OPEN_TO_DIRECT: "false",
    FREELLMAPI_API_KEY: "freellmapi-test",
    OPENAI_API_KEY: "sk-paid",
  }, async () => {
    const urls: string[] = [];
    const provider = new OpenAIProvider({
      apiKey: "sk-paid",
      ...noWait,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response("down", { status: 503 });
      },
    });

    await assert.rejects(
      () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
      (err: unknown) => err instanceof ProviderError && /freellmapi/.test(err.message),
    );
    assert.deepEqual(urls, [
      "http://freellmapi:3001/v1/chat/completions",
      "http://freellmapi:3001/v1/chat/completions",
    ]);
  });
});

test("missing FreeLLMAPI key fails open directly without a doomed network request", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-paid" }, async () => {
    const urls: string[] = [];
    const provider = new OpenAIProvider({
      apiKey: "sk-paid",
      ...noWait,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return sseDirect();
      },
    });

    const result = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });
    assert.deepEqual(urls, ["https://api.openai.com/v1/chat/completions"]);
    assert.equal(result.usage.provider, "openai");
  });
});
