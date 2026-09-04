import { test } from "node:test";
import assert from "node:assert/strict";

import { FreeLLMImageProvider, FreeLLMSpeechProvider } from "../src/providers/freellmapi-media.ts";
import { StockImageProvider } from "../src/providers/stock.ts";
import { ElevenLabsProvider } from "../src/providers/elevenlabs.ts";

const ENV_KEYS = [
  "FREELLMAPI_API_KEY",
  "FREELLMAPI_BASE_URL",
  "FREELLMAPI_IMAGE_MODEL",
  "FREELLMAPI_SPEECH_MODEL",
  "FREELLMAPI_SPEECH_VOICE",
  "FREELLMAPI_SPEECH_FORMAT",
  "IMAGE_PROVIDER_MODE",
  "SPEECH_PROVIDER_MODE",
  "FAL_KEY",
  "ELEVENLABS_API_KEY",
] as const;

async function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<void>) {
  const before = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) process.env[k] = v;
    await fn();
  } finally {
    for (const k of ENV_KEYS) {
      const value = before[k];
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  }
}

test("FreeLLM image provider uses the shared OpenAI-compatible image endpoint with zero paid cost", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    let requestBody: any;
    const provider = new FreeLLMImageProvider({
      fetchImpl: (async (input, init) => {
        assert.equal(String(input), "http://freellmapi:3001/v1/images/generations");
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer free-key");
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from("PNG").toString("base64") }],
          model: "flux",
          provider: "pollinations",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    const out = await provider.generate({ prompt: "a quiet street", aspect: "16:9", count: 1 });
    assert.equal(requestBody.model, "flux");
    assert.equal(requestBody.size, "1792x1024");
    assert.equal(requestBody.response_format, "b64_json");
    assert.equal(Buffer.from(out.images[0]!.bytes).toString(), "PNG");
    assert.equal(out.usage.provider, "freellmapi");
    assert.equal(out.usage.model, "pollinations/flux");
    assert.equal(out.usage.cost_usd, 0);
  });
});

test("FreeLLM speech provider pins one narrator and ignores the old ElevenLabs voice id", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    let requestBody: any;
    const provider = new FreeLLMSpeechProvider({
      fetchImpl: (async (input, init) => {
        assert.equal(String(input), "http://freellmapi:3001/v1/audio/speech");
        requestBody = JSON.parse(String(init?.body));
        return new Response(Uint8Array.from([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "audio/mpeg", "x-provider": "pollinations" },
        });
      }) as typeof fetch,
    });

    const out = await provider.synthesize({ text: "hello world", voice: "legacy-elevenlabs-id" });
    assert.equal(requestBody.model, "openai-audio");
    assert.equal(requestBody.voice, "onyx");
    assert.equal(requestBody.response_format, "mp3");
    assert.equal(out.media_type, "audio/mpeg");
    assert.equal(out.usage.model, "pollinations/openai-audio");
    assert.equal(out.usage.cost_usd, 0);
  });
});

test("config-selected FreeLLM image packs generate every requested shot without pretending to consume references", async () => {
  await withEnv({
    IMAGE_PROVIDER_MODE: "freellmapi",
    FREELLMAPI_API_KEY: "free-key",
  }, async () => {
    const bodies: any[] = [];
    const provider = new StockImageProvider({
      fetchImpl: (async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from(`IMG${bodies.length}`).toString("base64") }],
          model: "flux",
          provider: "pollinations",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    assert.match(provider.id, /freellmapi-image\/flux/);
    const out = await provider.generatePack({
      prompts: ["shot one", "shot two"],
      aspect: "16:9",
      seed: 123,
      reference: { bytes: Uint8Array.from([9]), media_type: "image/png" },
    });
    assert.equal(out.images.length, 2);
    assert.deepEqual(bodies.map((b) => b.prompt), ["shot one", "shot two"]);
    assert.equal(out.usage?.cost_usd, 0);
  });
});

test("provider modes roll back to Fal and ElevenLabs without code changes", async () => {
  await withEnv({
    IMAGE_PROVIDER_MODE: "fal",
    SPEECH_PROVIDER_MODE: "elevenlabs",
    FAL_KEY: "fal-key",
    ELEVENLABS_API_KEY: "el-key",
  }, async () => {
    const image = new StockImageProvider({ falKey: "fal-key", fetchImpl: (async () => {
      throw new Error("not called");
    }) as typeof fetch });
    assert.match(image.id, /fal\/fal-ai\/flux-2/);

    let body: any;
    const speech = new ElevenLabsProvider({
      apiKey: "el-key",
      fetchImpl: (async (input, init) => {
        assert.match(String(input), /api\.elevenlabs\.io\/v1\/text-to-speech\/voice-1\/with-timestamps/);
        assert.equal((init?.headers as Record<string, string>)["xi-api-key"], "el-key");
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          audio_base64: Buffer.from("MP3").toString("base64"),
          alignment: { character_end_times_seconds: [0.1, 0.2] },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    assert.match(speech.id, /^elevenlabs\//);
    const out = await speech.synthesize({
      text: "hello",
      voice: "voice-1",
      context: { prev: "before", next: "after" },
    });
    assert.equal(body.previous_text, "before");
    assert.equal(body.next_text, "after");
    assert.equal(out.duration_sec, 0.2);
    assert.equal(out.usage.provider, "elevenlabs");
  });
});
