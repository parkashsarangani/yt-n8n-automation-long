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

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);

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

test("FreeLLM image provider uses registry-portable auto and records the actual image model", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    let requestBody: any;
    const provider = new FreeLLMImageProvider({
      fetchImpl: (async (input, init) => {
        assert.equal(String(input), "http://freellmapi:3001/v1/images/generations");
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer free-key");
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from(JPEG_BYTES).toString("base64") }],
          model: "pollinations-image-model",
          provider: "pollinations",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    const out = await provider.generate({ prompt: "a quiet street", aspect: "16:9", count: 1 });
    assert.equal(requestBody.model, "auto");
    assert.equal(requestBody.size, "1792x1024");
    assert.equal(requestBody.response_format, "b64_json");
    assert.deepEqual(out.images[0]!.bytes, JPEG_BYTES);
    assert.equal(out.images[0]!.media_type, "image/jpeg");
    assert.equal(out.usage.provider, "freellmapi");
    assert.equal(out.usage.model, "pollinations/pollinations-image-model");
    assert.equal(out.usage.cost_usd, 0);
  });
});

test("FreeLLM speech accepts live Google WAV even when MP3 was requested", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
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

test("config-selected FreeLLM image packs use auto and generate every requested shot", async () => {
  await withEnv({
    IMAGE_PROVIDER_MODE: "freellmapi",
    FREELLMAPI_API_KEY: "free-key",
  }, async () => {
    const bodies: any[] = [];
    const provider = new StockImageProvider({
      fetchImpl: (async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }],
          model: "anonymous-image",
          provider: "pollinations",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    assert.match(provider.id, /freellmapi-image\/auto/);
    const out = await provider.generatePack({
      prompts: ["shot one", "shot two"],
      aspect: "16:9",
      seed: 123,
      reference: { bytes: Uint8Array.from([9]), media_type: "image/png" },
    });
    assert.equal(out.images.length, 2);
    assert.deepEqual(bodies.map((b) => b.model), ["auto", "auto"]);
    assert.deepEqual(bodies.map((b) => b.prompt), ["shot one", "shot two"]);
    assert.equal(out.images.every((image) => image.media_type === "image/png"), true);
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
