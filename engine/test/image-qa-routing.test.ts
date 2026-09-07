// Exercises the opt-in real (paid) vision path. Normal runs use the free
// text-only metadata proxy and make no OpenAI vision call at all.
process.env["VISUAL_QA_MODE"] = "real";

import test from "node:test";
import assert from "node:assert/strict";

import { checkGeneratedImageMatchesNarration, type FetchLike } from "../src/image-qa.ts";

const IMAGE = { bytes: new Uint8Array([1, 2, 3, 4]), media_type: "image/png" };
const LINE = "a spoken narration line";
const ENV_KEYS = [
  "LLM_ROUTER_MODE",
  "LLM_ROUTER_FAIL_OPEN_TO_DIRECT",
  "FREELLMAPI_API_KEY",
  "FREELLMAPI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_IMAGE_QA_MODEL",
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

function okVision(content: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    text: async () => JSON.stringify(content),
  };
}

test("vision QA ignores FreeLLMAPI text routing and calls direct OpenAI", async () => {
  await withEnv({
    LLM_ROUTER_MODE: "freellmapi",
    FREELLMAPI_API_KEY: "free-key",
    FREELLMAPI_BASE_URL: "http://freellmapi:3001/v1",
    OPENAI_API_KEY: "sk-paid",
    OPENAI_IMAGE_QA_MODEL: "gpt-5.6-luna",
  }, async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      return okVision({ contradicts_narration: false, reason: "clean" });
    };

    const result = await checkGeneratedImageMatchesNarration(IMAGE, LINE, fetchImpl);

    assert.equal(result?.contradictsNarration, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0]!.headers.Authorization, "Bearer sk-paid");
    assert.equal(calls[0]!.body["model"], "gpt-5.6-luna");
    const messages = calls[0]!.body["messages"] as Array<{ content: Array<Record<string, unknown>> }>;
    assert.equal(messages[0]!.content.some((part) => part["type"] === "image_url"), true);
  });
});

test("vision QA returns null when direct OpenAI credentials are absent", async () => {
  await withEnv({
    LLM_ROUTER_MODE: "freellmapi",
    FREELLMAPI_API_KEY: "free-key",
  }, async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      return okVision({ contradicts_narration: false, reason: "clean" });
    };

    const result = await checkGeneratedImageMatchesNarration(IMAGE, LINE, fetchImpl);
    assert.equal(result, null);
    assert.deepEqual(urls, []);
  });
});

test("direct vision honors its explicit base URL and model independently of text routing", async () => {
  await withEnv({
    LLM_ROUTER_MODE: "freellmapi",
    FREELLMAPI_API_KEY: "free-key",
    OPENAI_API_KEY: "sk-paid",
    OPENAI_BASE_URL: "https://vision.example/v1/",
    OPENAI_IMAGE_QA_MODEL: "vision-model",
  }, async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return okVision({ contradicts_narration: false, reason: "clean" });
    };

    await checkGeneratedImageMatchesNarration(IMAGE, LINE, fetchImpl);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://vision.example/v1/chat/completions");
    assert.equal(calls[0]!.body["model"], "vision-model");
  });
});
