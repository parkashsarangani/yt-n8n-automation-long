import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FreeLLMSpeechProvider,
  __resetFreeLLMSpeechCircuitForTests,
} from "../src/providers/freellmapi-media.ts";
import { StockImageProvider } from "../src/providers/stock.ts";
import { FreeMediaTerminalError } from "../src/free-media-policy.ts";

const ENV_KEYS = [
  "FREELLMAPI_API_KEY",
  "FREELLMAPI_BASE_URL",
  "FREELLMAPI_SPEECH_MODEL",
  "FREELLMAPI_SPEECH_VOICE",
  "FREELLMAPI_SPEECH_FORMAT",
  "SPEECH_PROVIDER_MODE",
  "FAL_KEY",
] as const;

function smallWav(sampleRate = 24_000, samples = 240): Uint8Array {
  const dataBytes = samples * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(b);
}

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

test("FreeLLM speech accepts live Google WAV even when MP3 was requested", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    __resetFreeLLMSpeechCircuitForTests();
    let requestBody: any;
    const wav = smallWav();
    const provider = new FreeLLMSpeechProvider({
      fetchImpl: (async (input, init) => {
        assert.equal(String(input), "http://freellmapi:3001/v1/audio/speech");
        requestBody = JSON.parse(String(init?.body));
        return new Response(wav, {
          status: 200,
          headers: { "content-type": "audio/wav; rate=24000", "x-provider": "google" },
        });
      }) as typeof fetch,
    });

    const out = await provider.synthesize({ text: "hello world", voice: "legacy-elevenlabs-id" });
    assert.equal(requestBody.model, "auto");
    assert.equal(requestBody.voice, "onyx");
    assert.equal(requestBody.response_format, "mp3");
    assert.equal(out.media_type, "audio/wav");
    assert.equal(out.duration_sec, 0.01);
    assert.equal(out.usage.model, "google/auto");
    assert.equal(out.usage.cost_usd, 0);
  });
});

test("FreeLLM speech still accepts MP3-capable providers", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    __resetFreeLLMSpeechCircuitForTests();
    const provider = new FreeLLMSpeechProvider({
      model: "catalog-audio-model",
      fetchImpl: (async () => new Response(Uint8Array.from([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "audio/mpeg", "x-provider": "pollinations" },
      })) as typeof fetch,
    });
    const out = await provider.synthesize({ text: "hello", voice: "onyx" });
    assert.equal(out.media_type, "audio/mpeg");
    assert.equal(out.usage.model, "pollinations/catalog-audio-model");
  });
});

test("FreeLLM speech rejects non-audio payload types", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    __resetFreeLLMSpeechCircuitForTests();
    const provider = new FreeLLMSpeechProvider({
      fetchImpl: (async () => new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      })) as typeof fetch,
    });
    await assert.rejects(
      () => provider.synthesize({ text: "hello", voice: "onyx" }),
      /unsupported content-type/,
    );
  });
});

test("FreeLLM speech quota exhaustion is terminal and opens a no-call process circuit", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "quota-key" }, async () => {
    __resetFreeLLMSpeechCircuitForTests();
    let calls = 0;
    const provider = new FreeLLMSpeechProvider({
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({
          error: { message: "You exceeded your current quota, please check your plan and billing details" },
        }), { status: 429, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    await assert.rejects(
      () => provider.synthesize({ text: "first clip", voice: "onyx" }),
      (err: unknown) => err instanceof FreeMediaTerminalError && /speech quota exhausted/i.test(err.message),
    );
    assert.equal(calls, 1);

    await assert.rejects(
      () => provider.synthesize({ text: "second clip", voice: "onyx" }),
      /speech quota is circuit-broken/i,
    );
    assert.equal(calls, 1, "subsequent voice retries must make zero upstream calls after confirmed quota exhaustion");
    __resetFreeLLMSpeechCircuitForTests();
  });
});

test("image compatibility adapter is permanently backed by fal.ai", async () => {
  await withEnv({ FAL_KEY: "fal-key" }, async () => {
    const provider = new StockImageProvider({
      falKey: "fal-key",
      fetchImpl: (async () => {
        throw new Error("not called");
      }) as typeof fetch,
    });
    assert.match(provider.id, /fal\/fal-ai\/flux-2/);
    assert.doesNotMatch(provider.id, /freellmapi/i);
  });
});
