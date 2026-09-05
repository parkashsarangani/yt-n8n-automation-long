import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FreeLLMImageProvider,
  FreeLLMSpeechProvider,
  __resetFreeLLMHeroBudgetForTests,
  __resetFreeLLMSpeechCircuitForTests,
  compactImagePrompt,
} from "../src/providers/freellmapi-media.ts";
import { StockImageProvider } from "../src/providers/stock.ts";
import { ElevenLabsProvider } from "../src/providers/elevenlabs.ts";
import { FreeMediaTerminalError } from "../src/free-media-policy.ts";

const ENV_KEYS = [
  "FREELLMAPI_API_KEY",
  "FREELLMAPI_BASE_URL",
  "FREELLMAPI_IMAGE_MODEL",
  "FREELLMAPI_HERO_IMAGE_MODEL",
  "FREELLMAPI_HERO_IMAGE_MAX_CALLS",
  "FREELLMAPI_HERO_IMAGE_PROMPT_MAX_CHARS",
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

test("FreeLLM image provider uses lower-cost 1024-class output and records the actual image model", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    let requestBody: any;
    const provider = new FreeLLMImageProvider({
      maxAttempts: 1,
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
    assert.equal(requestBody.size, "1024x576");
    assert.equal(requestBody.response_format, "b64_json");
    assert.deepEqual(out.images[0]!.bytes, JPEG_BYTES);
    assert.equal(out.images[0]!.media_type, "image/jpeg");
    assert.equal(out.usage.provider, "freellmapi");
    assert.equal(out.usage.model, "pollinations/pollinations-image-model");
    assert.equal(out.usage.cost_usd, 0);
  });
});

test("FreeLLM image provider pre-emptively makes clock/calendar prompts text-safe", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    let prompt = "";
    const provider = new FreeLLMImageProvider({
      maxAttempts: 1,
      fetchImpl: (async (_input, init) => {
        prompt = JSON.parse(String(init?.body)).prompt;
        return new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }],
          model: "image-model",
          provider: "cloudflare",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await provider.generate({ prompt: "a woman points at a wall clock beside a calendar", aspect: "16:9" });
    assert.match(prompt, /show its back, edge, closed cover, silhouette, or crop\/occlude the face completely/i);
    assert.match(prompt, /Calendars and papers must be blank/i);
    assert.match(prompt, /No words, letters, numbers, logos/i);
  });
});

test("FreeLLM image provider retries one transient gateway failure before succeeding", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    let calls = 0;
    const provider = new FreeLLMImageProvider({
      maxAttempts: 2,
      retryDelayMs: 0,
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        calls++;
        if (calls === 1) return new Response("temporary", { status: 503 });
        return new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }],
          model: "image-model",
          provider: "pollinations",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const out = await provider.generate({ prompt: "a quiet park", aspect: "16:9" });
    assert.equal(calls, 2);
    assert.equal(out.images.length, 1);
  });
});

test("hero escalation refuses auto or the hero row itself as the standard image route", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    assert.throws(
      () => new FreeLLMImageProvider({ heroModel: "black-forest-labs/flux.2-klein-4b" }),
      /FREELLMAPI_IMAGE_MODEL to be pinned to a different standard image model/i,
    );
    assert.throws(
      () => new FreeLLMImageProvider({
        model: "black-forest-labs/flux.2-klein-4b",
        heroModel: "black-forest-labs/flux.2-klein-4b",
      }),
      /FREELLMAPI_IMAGE_MODEL to be pinned to a different standard image model/i,
    );
  });
});

test("hero prompt compaction preserves scene intent and tail safety/style constraints", () => {
  const original = `SCENE-START ${"subject detail ".repeat(120)} VISUAL IDENTITY: rough black ink and cream paper. ${"style detail ".repeat(80)} EXCLUDE: glossy 3D, stick figures, faceless people. STYLE-END`;
  const compact = compactImagePrompt(original, 700);
  assert.ok(compact.length <= 700);
  assert.match(compact, /^SCENE-START/);
  assert.match(compact, /STYLE-END$/);
  assert.match(compact, /EXCLUDE: glossy 3D, stick figures, faceless people/i);
});

test("hero tier compacts the bridge-bound prompt but leaves the pinned standard route independent", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    __resetFreeLLMHeroBudgetForTests();
    const bodies: any[] = [];
    const provider = new FreeLLMImageProvider({
      model: "standard-sana-row",
      maxAttempts: 1,
      heroModel: "black-forest-labs/flux.2-klein-4b",
      heroMaxCalls: 5,
      heroPromptMaxChars: 700,
      fetchImpl: (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }],
          model: body.model,
          provider: body.model === "standard-sana-row" ? "standard-provider" : "nvidia",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    const longPrompt = `SCENE-START ${"subject detail ".repeat(150)} VISUAL IDENTITY: rough black ink and cream paper. ${"style detail ".repeat(100)} EXCLUDE: glossy 3D, stick figures, faceless people. STYLE-END`;
    await provider.generate({ prompt: longPrompt, aspect: "16:9", tier: "hero" });
    await provider.generate({ prompt: "ordinary background", aspect: "16:9" });

    assert.equal(bodies[0].model, "black-forest-labs/flux.2-klein-4b");
    assert.ok(bodies[0].prompt.length <= 700);
    assert.match(bodies[0].prompt, /^SCENE-START/);
    assert.match(bodies[0].prompt, /STYLE-END$/);
    assert.equal(bodies[1].model, "standard-sana-row");
    assert.equal(bodies[1].prompt, "ordinary background");
  });
});

test("hero tier routes to the reserved hero model and reports its real usage, without touching it when not requested", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    __resetFreeLLMHeroBudgetForTests();
    const modelsRequested: string[] = [];
    const provider = new FreeLLMImageProvider({
      model: "standard-image",
      maxAttempts: 1,
      heroModel: "black-forest-labs/flux.2-klein-4b",
      heroMaxCalls: 5,
      fetchImpl: (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        modelsRequested.push(body.model);
        return new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }],
          model: body.model,
          provider: "nvidia",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    const standard = await provider.generate({ prompt: "a busy street background", aspect: "16:9" });
    assert.equal(standard.usage.model, "nvidia/standard-image", "no tier requested must use the pinned standard model");

    const hero = await provider.generate({ prompt: "the hero payoff shot", aspect: "16:9", tier: "hero" });
    assert.equal(hero.usage.model, "nvidia/black-forest-labs/flux.2-klein-4b");
    assert.deepEqual(modelsRequested, ["standard-image", "black-forest-labs/flux.2-klein-4b"]);
  });
});

test("hero model failure falls back to the pinned standard model within the same call", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    __resetFreeLLMHeroBudgetForTests();
    const modelsRequested: string[] = [];
    const provider = new FreeLLMImageProvider({
      model: "standard-image",
      maxAttempts: 1,
      heroModel: "black-forest-labs/flux.2-klein-4b",
      heroMaxCalls: 5,
      fetchImpl: (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        modelsRequested.push(body.model);
        if (body.model === "black-forest-labs/flux.2-klein-4b") return new Response("trial exhausted", { status: 402 });
        return new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }],
          model: body.model,
          provider: "pollinations",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    const out = await provider.generate({ prompt: "the hero payoff shot", aspect: "16:9", tier: "hero" });
    assert.deepEqual(modelsRequested, ["black-forest-labs/flux.2-klein-4b", "standard-image"]);
    assert.equal(out.usage.model, "pollinations/standard-image");
  });
});

test("hero call ceiling stops attempting the hero model and uses the pinned standard model instead", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "free-key" }, async () => {
    __resetFreeLLMHeroBudgetForTests();
    const modelsRequested: string[] = [];
    const provider = new FreeLLMImageProvider({
      model: "standard-image",
      maxAttempts: 1,
      heroModel: "black-forest-labs/flux.2-klein-4b",
      heroMaxCalls: 1,
      fetchImpl: (async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        modelsRequested.push(body.model);
        return new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }],
          model: body.model,
          provider: "nvidia",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    await provider.generate({ prompt: "hero shot one", aspect: "16:9", tier: "hero" });
    await provider.generate({ prompt: "hero shot two", aspect: "16:9", tier: "hero" });
    // The ceiling is 1: the first hero request spends it, the second must not
    // attempt the hero model at all -- not even as a failed call -- because a
    // hosted trial with no visible remaining-quota signal must never be
    // approached optimistically once the configured budget is spent.
    assert.deepEqual(modelsRequested, ["black-forest-labs/flux.2-klein-4b", "standard-image"]);
  });
});

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

test("config-selected FreeLLM image packs use auto and generate every requested shot when no hero row is configured", async () => {
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
    assert.equal(out.usage?.model, "pollinations/anonymous-image");
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

// Keep this last: the provider intentionally holds a process-local circuit
// until the next UTC reset so unattended retries cannot hit the same dead daily
// allocation again.
test("daily Cloudflare image allocation exhaustion is terminal and opens a no-call circuit", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "quota-key" }, async () => {
    let calls = 0;
    const now = Date.UTC(2026, 8, 4, 22, 0, 0);
    const provider = new FreeLLMImageProvider({
      maxAttempts: 2,
      retryDelayMs: 0,
      now: () => now,
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ error: { message: "cloudflare 429: you have used up your daily free allocation of 10,000 neurons" } }), { status: 429 });
      }) as typeof fetch,
    });

    await assert.rejects(
      () => provider.generate({ prompt: "one image", aspect: "16:9" }),
      (err: unknown) => err instanceof FreeMediaTerminalError && /daily free image allocation/i.test(err.message),
    );
    assert.equal(calls, 1, "hard daily quota must never receive the generic transient retry");

    await assert.rejects(
      () => provider.generate({ prompt: "another image", aspect: "16:9" }),
      /circuit-broken until 2026-09-05T00:00:05.000Z/,
    );
    assert.equal(calls, 1, "subsequent scheduler/worker retries must make zero upstream calls before reset");
  });
});
