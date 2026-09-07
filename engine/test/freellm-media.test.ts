import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertConcreteMediaModels,
  resolveFreeImageModels,
  resolveFreeVideoModels,
} from "../src/freellm-media-models.ts";
import { FreeLlmImageProvider } from "../src/providers/freellm-image.ts";
import { FreeLlmVideoProvider } from "../src/providers/freellm-video.ts";
import { FreeMediaTerminalError } from "../src/free-media-policy.ts";
import { ProviderError } from "../src/provider.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// A real (tiny) PNG so the magic-byte + length checks pass.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAADgNQ4AAAHy2p4nAAAAAElFTkSuQmCC";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");

function mp4Bytes(): Uint8Array {
  const b = new Uint8Array(2048);
  // 'ftyp' box tag at offset 4 for the sniffer's secondary path.
  b.set([0x66, 0x74, 0x79, 0x70], 4);
  return b;
}

const IMG_ENV = ["FREELLMAPI_API_KEY", "FREELLMAPI_BASE_URL", "FREELLMAPI_IMAGE_MODELS", "FREELLMAPI_VIDEO_MODELS", "FREELLMAPI_VIDEO_DURATION_SEC"] as const;
async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(IMG_ENV.map((k) => [k, process.env[k]]));
  try {
    for (const k of IMG_ENV) delete process.env[k];
    for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
    return await run();
  } finally {
    for (const k of IMG_ENV) {
      const v = prev[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function imgResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// --- config (§33 tests 1-5) ----------------------------------------------

test("config 1: image model list preserves explicit order and dedupes", () => {
  assert.deepEqual(
    assertConcreteMediaModels(" flux , nvidia/x , flux , pollinations/y ", "FREELLMAPI_IMAGE_MODELS"),
    ["flux", "nvidia/x", "pollinations/y"],
  );
});

test("config 2: video model list preserves explicit order", () => {
  assert.deepEqual(assertConcreteMediaModels("a,b,c", "FREELLMAPI_VIDEO_MODELS"), ["a", "b", "c"]);
});

test("config 3: auto is rejected from the image chain", () => {
  assert.throws(() => assertConcreteMediaModels("flux,auto", "FREELLMAPI_IMAGE_MODELS"), /may not contain auto routing/);
});

test("config 4: auto:* is rejected from the video chain", () => {
  assert.throws(() => assertConcreteMediaModels("auto:smart", "FREELLMAPI_VIDEO_MODELS"), /may not contain auto routing/);
});

test("config 5: an empty / unset list is valid (no built-in default)", () => {
  assert.deepEqual(assertConcreteMediaModels(undefined, "X"), []);
  assert.deepEqual(assertConcreteMediaModels("", "X"), []);
  assert.deepEqual(resolveFreeImageModels({} as NodeJS.ProcessEnv), []);
  assert.deepEqual(resolveFreeVideoModels({} as NodeJS.ProcessEnv), []);
});

// --- images (§33 tests 6-13) -------------------------------------------

test("image 6: first free image model succeeds -> no other model, no paid provider", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_IMAGE_MODELS: "img-a,img-b" }, async () => {
    const models: string[] = [];
    const p = new FreeLlmImageProvider({ fetchImpl: async (_u, init) => {
      models.push((JSON.parse(String(init?.body)) as { model: string }).model);
      return imgResponse({ data: [{ b64_json: PNG_B64 }], model: "flux.1-schnell", provider: "cloudflare" });
    } });
    const out = await p.generate({ prompt: "a red cube", aspect: "16:9" });
    assert.deepEqual(models, ["img-a"]);
    assert.equal(out.usage.cost_usd, 0);
    assert.equal(out.usage.provider, "freellmapi");
    assert.equal(out.usage.model, "cloudflare/flux.1-schnell");
    assert.deepEqual([...out.images[0]!.bytes.slice(0, 4)], [...PNG_BYTES.slice(0, 4)]);
  });
});

test("image 7: a 429 on the first model advances to the second free model", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_IMAGE_MODELS: "img-a,img-b" }, async () => {
    const models: string[] = [];
    const p = new FreeLlmImageProvider({ fetchImpl: async (_u, init) => {
      const m = (JSON.parse(String(init?.body)) as { model: string }).model;
      models.push(m);
      return m === "img-a" ? imgResponse({ error: "rate limit" }, 429) : imgResponse({ data: [{ b64_json: PNG_B64 }], model: m, provider: "pollinations" });
    } });
    await p.generate({ prompt: "x", aspect: "16:9" });
    assert.deepEqual(models, ["img-a", "img-b"]);
  });
});

test("image 8+9: all free images fail -> ProviderError listing what was tried (caller decides on paid)", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_IMAGE_MODELS: "img-a,img-b" }, async () => {
    const p = new FreeLlmImageProvider({ fetchImpl: async () => imgResponse({ error: "down" }, 503) });
    await assert.rejects(
      () => p.generate({ prompt: "x", aspect: "16:9" }),
      (e: unknown) => e instanceof ProviderError && /all 2 configured free image model\(s\) unavailable \[img-a, img-b\]/.test(e.message),
    );
  });
});

test("image 10: a base64 response is decoded to real image bytes", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_IMAGE_MODELS: "img-a" }, async () => {
    const p = new FreeLlmImageProvider({ fetchImpl: async () => imgResponse({ data: [{ b64_json: PNG_B64 }], model: "m", provider: "nvidia" }) });
    const out = await p.generate({ prompt: "x", aspect: "1:1" });
    assert.equal(out.images[0]!.media_type, "image/png");
  });
});

test("image 11: a url response is only accepted from https and validated by magic bytes", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_IMAGE_MODELS: "img-a" }, async () => {
    const p = new FreeLlmImageProvider({ fetchImpl: async (u) => {
      if (String(u).includes("/images/generations")) return imgResponse({ data: [{ url: "https://cdn.example/img.png" }], model: "m", provider: "cloudflare" });
      return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
    } });
    const out = await p.generate({ prompt: "x", aspect: "16:9" });
    assert.equal(out.images[0]!.media_type, "image/png");
  });
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_IMAGE_MODELS: "img-a" }, async () => {
    const p = new FreeLlmImageProvider({ fetchImpl: async () => imgResponse({ data: [{ url: "http://127.0.0.1/x.png" }], model: "m", provider: "x" }) });
    await assert.rejects(() => p.generate({ prompt: "x", aspect: "16:9" }), /all 1 configured free image/);
  });
});

test("image 12: a malformed / empty image response advances the chain, then fails", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_IMAGE_MODELS: "img-a" }, async () => {
    const p = new FreeLlmImageProvider({ fetchImpl: async () => imgResponse({ data: [] }, 200) });
    await assert.rejects(() => p.generate({ prompt: "x", aspect: "16:9" }), /returned no usable image|all 1 configured/);
  });
});

test("image 13: generated-image capability exists with free image models even without FAL_KEY", async () => {
  const src = await readFile(path.join(ROOT, "src/workers/visual-beat-resolver.ts"), "utf8");
  assert.match(src, /generated_image: freeImage \|\| \(policy\.paidImageFallback && Boolean\(process\.env\["FAL_KEY"\]/);
});

test("image: a gateway auth failure stops the chain instead of retrying every model (§33 test 23)", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "bad", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_IMAGE_MODELS: "img-a,img-b,img-c" }, async () => {
    let calls = 0;
    const p = new FreeLlmImageProvider({ fetchImpl: async () => { calls++; return imgResponse({ error: "Invalid API key" }, 401); } });
    await assert.rejects(() => p.generate({ prompt: "x", aspect: "16:9" }), (e: unknown) => e instanceof FreeMediaTerminalError);
    assert.equal(calls, 1, "did not retry other models with the same broken credential");
  });
});

// --- videos (§33 tests 14-23) -----------------------------------------

function vidOk(): Response {
  return new Response(mp4Bytes(), { status: 200, headers: { "content-type": "video/mp4", "x-provider": "pollinations", "x-model": "veo-free" } });
}

test("video 14: first free video model succeeds -> no other provider called", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_VIDEO_MODELS: "vid-a,vid-b" }, async () => {
    const models: string[] = [];
    const p = new FreeLlmVideoProvider({ fetchImpl: async (_u, init) => { models.push((JSON.parse(String(init?.body)) as { model: string }).model); return vidOk(); } });
    const out = await p.generate("a commuter walks and taps send");
    assert.ok(out);
    assert.deepEqual(models, ["vid-a"]);
    assert.equal(out!.media_type, "video/mp4");
  });
});

test("video 15: first free video fails -> second free video attempted", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_VIDEO_MODELS: "vid-a,vid-b" }, async () => {
    const models: string[] = [];
    const p = new FreeLlmVideoProvider({ fetchImpl: async (_u, init) => {
      const m = (JSON.parse(String(init?.body)) as { model: string }).model;
      models.push(m);
      return m === "vid-a" ? new Response("err", { status: 503 }) : vidOk();
    } });
    const out = await p.generate("x");
    assert.ok(out);
    assert.deepEqual(models, ["vid-a", "vid-b"]);
  });
});

test("video 16: raw MP4 body + X-Provider/X-Model are captured (§33 tests 24-25)", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_VIDEO_MODELS: "vid-a" }, async () => {
    const p = new FreeLlmVideoProvider({ fetchImpl: async () => vidOk() });
    const out = await p.generate("x");
    assert.equal(out!.upstream_provider, "pollinations");
    assert.equal(out!.routed_model, "veo-free");
    assert.equal(out!.requested_model, "vid-a");
  });
});

test("video 17: all free video models fail -> generate() returns null (no paid call)", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_VIDEO_MODELS: "vid-a,vid-b" }, async () => {
    const p = new FreeLlmVideoProvider({ fetchImpl: async () => new Response("down", { status: 502 }) });
    assert.equal(await p.generate("x"), null);
    assert.equal(p.lastAttempts.length, 2);
    assert.ok(p.lastAttempts.every((a) => a.status === "failed"));
  });
});

test("video 18+19: the free video chain works with PAID_VIDEO_FALLBACK=false and a configured FAL_KEY", async () => {
  const prev = { pvf: process.env["PAID_VIDEO_FALLBACK"], fal: process.env["FAL_KEY"] };
  process.env["PAID_VIDEO_FALLBACK"] = "false";
  process.env["FAL_KEY"] = "fal-configured";
  try {
    await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_VIDEO_MODELS: "vid-a" }, async () => {
      const p = new FreeLlmVideoProvider({ fetchImpl: async () => vidOk() });
      const out = await p.generate("x");
      assert.ok(out, "free video succeeds regardless of the paid-video guard");
    });
  } finally {
    for (const [k, v] of [["PAID_VIDEO_FALLBACK", prev.pvf], ["FAL_KEY", prev.fal]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("video 22: a payment-required response is recorded as not-free and skipped, never escalated", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_VIDEO_MODELS: "vid-a,vid-b" }, async () => {
    const p = new FreeLlmVideoProvider({ fetchImpl: async (_u, init) => {
      const m = (JSON.parse(String(init?.body)) as { model: string }).model;
      return m === "vid-a"
        ? new Response(JSON.stringify({ error: { message: "please top up your balance" } }), { status: 402, headers: { "content-type": "application/json" } })
        : new Response("still down", { status: 503 });
    } });
    assert.equal(await p.generate("x"), null);
    assert.equal(p.lastAttempts[0]!.not_free, true);
    assert.equal(p.lastAttempts[1]!.not_free, undefined);
  });
});

test("video 22b: an empty / implausible video body is rejected", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_VIDEO_MODELS: "vid-a" }, async () => {
    const p = new FreeLlmVideoProvider({ fetchImpl: async () => new Response(new Uint8Array(10), { status: 200, headers: { "content-type": "video/mp4" } }) });
    assert.equal(await p.generate("x"), null);
  });
});

test("video 23: a gateway auth failure is terminal, not retried across models", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "bad", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_VIDEO_MODELS: "vid-a,vid-b" }, async () => {
    let calls = 0;
    const p = new FreeLlmVideoProvider({ fetchImpl: async () => { calls++; return new Response("Invalid API key", { status: 403 }); } });
    await assert.rejects(() => p.generate("x"), (e: unknown) => e instanceof FreeMediaTerminalError);
    assert.equal(calls, 1);
  });
});

// --- resolver wiring (§10, §27) --------------------------------------

test("resolver: free image + free video chains run before the paid paths", async () => {
  const src = await readFile(path.join(ROOT, "src/workers/visual-beat-resolver.ts"), "utf8");
  const gi = src.slice(src.indexOf("async function generateImage("), src.indexOf("\ninterface WindowCandidate"));
  assert.ok(gi.indexOf("generateFreeLlmImage(") < gi.indexOf("provider.generate({"), "free image before fal generation");
  const gv = src.slice(src.indexOf("async function generateVideo("), src.indexOf("\nasync function resolveMode("));
  assert.ok(gv.indexOf("generateFreeLlmVideo(") < gv.indexOf("new FalVideoProvider()"), "free video before paid provider");
  assert.ok(gv.indexOf("generateFreeLlmVideo(") < gv.indexOf("paidVideoFallback"), "free video before the paid-video guard");
});

test("video 20+21: generated_video capability follows a configured free allowlist, not the paid guard", async () => {
  const src = await readFile(path.join(ROOT, "src/workers/visual-beat-resolver.ts"), "utf8");
  assert.match(src, /const freeVideo = resolveFreeVideoModels\(\)\.length > 0;/);
  assert.match(src, /generated_video: freeVideo \|\| \(policy\.paidVideoFallback/);
});
