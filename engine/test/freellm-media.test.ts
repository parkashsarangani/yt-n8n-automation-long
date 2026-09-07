import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertConcreteMediaModels,
  resolveFreeImageModels,
  resolveFreeVideoModels,
  freeImageChainReady,
  freeVideoChainReady,
} from "../src/freellm-media-models.ts";
import { FreeLlmImageProvider } from "../src/providers/freellm-image.ts";
import { FreeLlmVideoProvider } from "../src/providers/freellm-video.ts";
import { FreeMediaAuthError } from "../src/free-media-policy.ts";
import { ProviderError } from "../src/provider.ts";
import { resolveBeatWithDeclaredAlternate } from "../src/workers/visual-beat-resolver.ts";
import type { VisualBeat, VisualCapabilities } from "../src/visual-routing.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// A real (tiny) PNG so the magic-byte + length checks pass.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAAAAAADgNQ4AAAHy2p4nAAAAAElFTkSuQmCC";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");

function mp4Bytes(): Uint8Array {
  const b = new Uint8Array(2048);
  // A minimal real MP4 ftyp box: size, 'ftyp', major brand 'isom'.
  b.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
  return b;
}

function webmBytes(): Uint8Array {
  const b = new Uint8Array(2048);
  b.set([0x1a, 0x45, 0xdf, 0xa3], 0); // EBML header
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

test("image 13 (env matrix): the images stage / capability report agree with the resolver on every combination", async () => {
  const { STAGES, credentialsSatisfied, capabilityReport } = await import("../src/capabilities.ts");
  const spec = STAGES.find((s) => s.id === "images")!;
  const provider = (env: NodeJS.ProcessEnv) =>
    capabilityReport({ allowPublish: false, env }).find((s) => s.id === "images")!.provider;

  // free chain (key + list), no fal -> satisfied, free-only.
  let env = { FREELLMAPI_API_KEY: "k", FREELLMAPI_IMAGE_MODELS: "flux" } as NodeJS.ProcessEnv;
  assert.equal(credentialsSatisfied(spec, env), true);
  assert.match(provider(env), /free only, no paid fallback/);

  // list set but NO key -> not satisfied anywhere.
  env = { FREELLMAPI_IMAGE_MODELS: "flux" } as NodeJS.ProcessEnv;
  assert.equal(credentialsSatisfied(spec, env), false);
  assert.match(provider(env), /unavailable/);

  // whitespace-only list -> parses to [], not satisfied.
  env = { FREELLMAPI_API_KEY: "k", FREELLMAPI_IMAGE_MODELS: " , " } as NodeJS.ProcessEnv;
  assert.equal(credentialsSatisfied(spec, env), false);

  // fal key + PAID_IMAGE_FALLBACK off + no free chain -> NOT a usable image path.
  env = { FAL_KEY: "fk", PAID_IMAGE_FALLBACK: "false" } as NodeJS.ProcessEnv;
  assert.equal(credentialsSatisfied(spec, env), false);
  assert.match(provider(env), /unavailable/);

  // fal key + paid on -> satisfied, fal is the provider.
  env = { FAL_KEY: "fk" } as NodeJS.ProcessEnv;
  assert.equal(credentialsSatisfied(spec, env), true);
  assert.match(provider(env), /^fal\//);

  // free chain + fal + paid on -> satisfied, free-first then fal.
  env = { FREELLMAPI_API_KEY: "k", FREELLMAPI_IMAGE_MODELS: "flux", FAL_KEY: "fk" } as NodeJS.ProcessEnv;
  assert.equal(credentialsSatisfied(spec, env), true);
  assert.match(provider(env), /free-first.*fal/);

  // resolver capability uses the same helper name.
  const resolver = await readFile(path.join(ROOT, "src/workers/visual-beat-resolver.ts"), "utf8");
  assert.match(resolver, /const freeImage = freeImageChainReady\(\);/);
  // service wires the free-only provider unless fal is usable as a paid route.
  const svc = await readFile(path.join(ROOT, "src/service.ts"), "utf8");
  assert.match(svc, /env\("FAL_KEY"\) && paidImageOn/);
  assert.match(svc, /:\s*new FreeMediaImageProvider\(\)/);
});

test("image: Cloudflare daily quota is per-model — the chain advances to the next free model, no paid escalation (§ review 1)", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_IMAGE_MODELS: "cf-flux,pollinations-turbo,nvidia-x" }, async () => {
    const models: string[] = [];
    const p = new FreeLlmImageProvider({ fetchImpl: async (_u, init) => {
      const m = (JSON.parse(String(init?.body)) as { model: string }).model;
      models.push(m);
      return m === "cf-flux"
        ? imgResponse({ error: { message: "You have used up your daily free allocation of 10,000 neurons" } }, 429)
        : imgResponse({ data: [{ b64_json: PNG_B64 }], model: m, provider: m === "pollinations-turbo" ? "pollinations" : "nvidia" });
    } });
    const out = await p.generate({ prompt: "x", aspect: "16:9" });
    assert.deepEqual(models, ["cf-flux", "pollinations-turbo"], "exhausted Cloudflare -> Pollinations attempted");
    assert.equal(out.usage.model, "pollinations/pollinations-turbo");
  });
});

test("image: a gateway auth failure stops the chain instead of retrying every model, and never permits paid (§33 test 23, § review 2)", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "bad", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_IMAGE_MODELS: "img-a,img-b,img-c" }, async () => {
    let calls = 0;
    const p = new FreeLlmImageProvider({ fetchImpl: async () => { calls++; return imgResponse({ error: "Invalid API key" }, 401); } });
    await assert.rejects(() => p.generate({ prompt: "x", aspect: "16:9" }), (e: unknown) => e instanceof FreeMediaAuthError);
    assert.equal(calls, 1, "did not retry other models with the same broken credential");
  });
  // The resolver rethrows the auth error out of the free path (no fal fallback).
  const src = await readFile(path.join(ROOT, "src/workers/visual-beat-resolver.ts"), "utf8");
  const gi = src.slice(src.indexOf("async function generateFreeLlmImage("), src.indexOf("\nasync function generateImage("));
  assert.match(gi, /if \(err instanceof FreeMediaAuthError\) throw err;/);
  const gv = src.slice(src.indexOf("async function generateFreeLlmVideo("), src.indexOf("\nasync function generateVideo("));
  assert.match(gv, /if \(err instanceof FreeMediaAuthError\) throw err;/);
});

test("image: routed free provider/model provenance survives to the resolved beat (§ review 6)", async () => {
  const src = await readFile(path.join(ROOT, "src/workers/visual-beat-resolver.ts"), "utf8");
  const gi = src.slice(src.indexOf("async function generateFreeLlmImage("), src.indexOf("\nasync function generateImage("));
  assert.match(gi, /source_provider: "freellmapi-image", source_id: best\.value\.routed/);
  assert.match(gi, /routed: out\.usage\.model/);
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
    await assert.rejects(() => p.generate("x"), (e: unknown) => e instanceof FreeMediaAuthError);
    assert.equal(calls, 1);
  });
});

test("video: the gateway contract is MP4-only — a WebM body is rejected, not stored as mp4 (§ review 2)", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_VIDEO_MODELS: "vid-a,vid-b" }, async () => {
    // vid-a: valid-looking WebM (video/webm + EBML header). vid-b: real MP4.
    const p = new FreeLlmVideoProvider({ fetchImpl: async (_u, init) => {
      const m = (JSON.parse(String(init?.body)) as { model: string }).model;
      return m === "vid-a"
        ? new Response(webmBytes(), { status: 200, headers: { "content-type": "video/webm" } })
        : new Response(mp4Bytes(), { status: 200, headers: { "content-type": "video/mp4", "x-provider": "pollinations", "x-model": "veo" } });
    } });
    const out = await p.generate("x");
    assert.ok(out);
    assert.equal(out!.requested_model, "vid-b", "WebM was rejected; the MP4 model was used");
    assert.equal(out!.media_type, "video/mp4");
    assert.equal(p.lastAttempts[0]!.status, "failed");
    assert.match(p.lastAttempts[0]!.failure_reason ?? "", /MP4-only/);
  });
});

test("video: a byte-valid MP4 with a non-MP4 content-type is still accepted (octet-stream)", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_VIDEO_MODELS: "vid-a" }, async () => {
    const p = new FreeLlmVideoProvider({ fetchImpl: async () => new Response(mp4Bytes(), { status: 200, headers: { "content-type": "application/octet-stream" } }) });
    const out = await p.generate("x");
    assert.ok(out);
    assert.equal(out!.media_type, "video/mp4");
  });
});

test("bake-off: the ffprobe gate also requires an MP4-family container", async () => {
  const gate = await readFile(path.join(ROOT, "scripts/free-media-ffprobe-gate.mjs"), "utf8");
  assert.match(gate, /non-MP4 container/);
  assert.match(gate, /mov\|mp4\|m4a\|3gp\|3g2\|mj2/);
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
  assert.match(src, /const freeVideo = freeVideoChainReady\(\);/);
  assert.match(src, /const freeImage = freeImageChainReady\(\);/);
  assert.match(src, /generated_video: freeVideo \|\| \(policy\.paidVideoFallback/);
});

// --- bake-off classification (§ review 4) ----------------------------

test("bake-off: auth error, daily quota, and paid-only are three DIFFERENT outcomes", async () => {
  const { isFreeMediaAuthFailure, isDailyFreeImageCapacityMessage, FreeMediaAuthError: AuthErr } =
    await import("../src/free-media-policy.ts");

  const auth = new AuthErr("gateway rejected the unified key (401)");
  assert.equal(isFreeMediaAuthFailure(auth), true);
  assert.equal(isDailyFreeImageCapacityMessage(auth), false, "a bad key is NOT a quota problem");

  const quota = new Error("freellmapi-image/cf daily free allocation exhausted: used up your daily free allocation of 10,000 neurons");
  assert.equal(isDailyFreeImageCapacityMessage(quota), true);
  assert.equal(isFreeMediaAuthFailure(quota), false, "an exhausted quota is NOT an auth problem");

  const paid = new Error("freellmapi-video/x is not a free route right now: please top up your balance");
  assert.equal(isFreeMediaAuthFailure(paid), false);
  assert.equal(isDailyFreeImageCapacityMessage(paid), false);
});

test("bake-off: the ffprobe gate script exists and fails hard on undecodable free video", async () => {
  const gate = await readFile(path.join(ROOT, "scripts/free-media-ffprobe-gate.mjs"), "utf8");
  assert.match(gate, /SUPPORTED_CODECS/);
  assert.match(gate, /attempt\.quality = r\.ok \? "PASS" : "FAIL"/);
  assert.match(gate, /hardFailures > 0/);
  assert.match(gate, /process\.exit\(1\)/);
  const smoke = await readFile(path.join(ROOT, "scripts/free-media-smoke.ts"), "utf8");
  // Video quality is never asserted PASS by the smoke itself — the gate decides.
  assert.match(smoke, /quality: "UNKNOWN", promotable: false, artifact: file/);
  assert.doesNotMatch(smoke, /classification:/);
});

// --- capability coherence: key + list, centralized (§ review 2) -------

test("free media chain readiness requires BOTH the unified key and a non-empty list", () => {
  const cases: Array<[Record<string, string | undefined>, boolean, boolean]> = [
    [{ FREELLMAPI_API_KEY: "k", FREELLMAPI_IMAGE_MODELS: "flux", FREELLMAPI_VIDEO_MODELS: "v" }, true, true],
    [{ FREELLMAPI_API_KEY: "", FREELLMAPI_IMAGE_MODELS: "flux", FREELLMAPI_VIDEO_MODELS: "v" }, false, false],
    [{ FREELLMAPI_API_KEY: "k", FREELLMAPI_IMAGE_MODELS: "", FREELLMAPI_VIDEO_MODELS: "" }, false, false],
    [{ FREELLMAPI_API_KEY: "k", FREELLMAPI_IMAGE_MODELS: "flux", FREELLMAPI_VIDEO_MODELS: "" }, true, false],
  ];
  for (const [env, image, video] of cases) {
    assert.equal(freeImageChainReady(env as NodeJS.ProcessEnv), image, JSON.stringify(env));
    assert.equal(freeVideoChainReady(env as NodeJS.ProcessEnv), video, JSON.stringify(env));
  }
});

test("resolver, capabilities and service all gate the free media chain on freeImageChainReady/freeVideoChainReady", async () => {
  const resolver = await readFile(path.join(ROOT, "src/workers/visual-beat-resolver.ts"), "utf8");
  assert.match(resolver, /const freeImage = freeImageChainReady\(\);/);
  assert.match(resolver, /const freeVideo = freeVideoChainReady\(\);/);
  assert.match(resolver, /if \(!freeImageChainReady\(\)\) return null;/);
  assert.match(resolver, /if \(!freeVideoChainReady\(\)\) return null;/);
  const caps = await readFile(path.join(ROOT, "src/capabilities.ts"), "utf8");
  assert.match(caps, /if \(freeImageChainReady\(env\)\)/);
});

// --- routing-level: a bad gateway key ends the run, never a paid alternate (§ review 1)

function authBeat(): VisualBeat {
  return {
    id: "beat_auth", scene_index: 0, beat_index: 0, start_sec: 0, end_sec: 4,
    narration: "A commuter runs for the closing train doors.",
    context: { previous: "", next: "" },
    intent: { purpose: "ESTABLISH", information: "x", emotion: "tension", importance: 0.9 },
    visual_contract: { required: ["commuter"], forbidden: [], required_action: "runs for the doors", viewer_takeaway: "he makes it" },
    // preferred free video, declared alternate paid-capable generated_image.
    routing: { preferred: "generated_video", fallback: "generated_image", image_style: "realistic" },
    continuity: { group: "", entities: [] },
    retention: { novelty_required: false, visual_change_strength: 0.6, composition: "medium_action", camera_treatment: "tracking", subject_placement: "center", explanatory_pattern: "action" },
    asset_brief: {
      query: "commuter running train", query_variants: ["a", "b", "c"],
      generation_prompt: "commuter running for train doors",
      generation_variants: ["a", "b", "c"], generated_video_prompt: "runs and boards", motion_graphic_brief: "",
    },
  };
}

test("routing: a FreeLLMAPI gateway auth failure aborts the run — no alternate mode, no fal call (§ review 1)", async () => {
  const ENV = ["FREELLMAPI_API_KEY", "FREELLMAPI_BASE_URL", "FREELLMAPI_VIDEO_MODELS", "FAL_KEY", "PAID_VIDEO_FALLBACK", "PAID_IMAGE_FALLBACK", "VISUAL_QA_MODE"] as const;
  const prev = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  let falImageCalls = 0;
  try {
    process.env["FREELLMAPI_API_KEY"] = "bad-key";
    process.env["FREELLMAPI_BASE_URL"] = "http://freellmapi.test/v1";
    process.env["FREELLMAPI_VIDEO_MODELS"] = "vid-a";
    process.env["FAL_KEY"] = "fal-configured";
    process.env["PAID_IMAGE_FALLBACK"] = "true";
    delete process.env["PAID_VIDEO_FALLBACK"];
    delete process.env["VISUAL_QA_MODE"];

    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/videos/generations")) return new Response("Invalid API key", { status: 403 });
      return realFetch(url as string);
    }) as typeof fetch;

    const falImage = {
      id: "cartoon-art/fal/fal-ai/flux-2",
      generate: async () => { falImageCalls += 1; return { images: [{ bytes: new Uint8Array([1]), media_type: "image/png" }], usage: { input_tokens: 0, output_tokens: 0, units: 1, cost_usd: 0.02, provider: "fal", model: "flux-2" } }; },
      generatePack: async () => { falImageCalls += 1; return { images: [], usage: { input_tokens: 0, output_tokens: 0, units: 0, cost_usd: 0, provider: "fal", model: "flux-2" } }; },
    };
    const ctx = {
      logger: { log() {}, warn() {}, error() {} },
      blobs: { put: async () => ({ uri: "blob://x" }) },
      media: { images: falImage },
      progress: async () => {}, attemptNumber: 1,
    } as never;
    const available: VisualCapabilities = { stock_video: false, generated_image: true, motion_graphic: true, generated_video: true };

    await assert.rejects(
      () => resolveBeatWithDeclaredAlternate(authBeat(), "generated_video", available, ctx, { unavailable: false }, undefined, undefined, undefined, ""),
      (e: unknown) => e instanceof FreeMediaAuthError,
    );
    assert.equal(falImageCalls, 0, "the paid fal image alternate must never be reached on a gateway auth failure");
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ENV) {
      const v = prev[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// --- prompt-length clamp (NVIDIA-class free image models 422 on long prompts) ---

test("clampFreeImagePrompt keeps the scene and bounds the length", async () => {
  const { clampFreeImagePrompt, DEFAULT_FREE_IMAGE_PROMPT_MAX } = await import("../src/free-media-policy.ts");

  // A short prompt gets the full text-safety wrapper.
  const short = clampFreeImagePrompt("a red cube on a table");
  assert.ok(short.length <= DEFAULT_FREE_IMAGE_PROMPT_MAX);
  assert.match(short, /^a red cube on a table/);

  // The resolver's long strengthened prompt (with the verbose safety block) is
  // clamped: subject kept, verbose block dropped, compact safety appended.
  const long = "A commuter walks through a modern European train station holding a smartphone showing a navigation route. " +
    "Photorealistic cinematic real-world visual language. ".repeat(20);
  const clamped = clampFreeImagePrompt(long, 500);
  assert.ok(clamped.length <= 500, `clamped length ${clamped.length}`);
  assert.match(clamped, /^A commuter walks through a modern European train station/);
  assert.match(clamped, /No readable text, letters, numbers, logos or watermarks\.$/);
});

test("FreeLlmImageProvider clamps the prompt it sends (default and per-instance)", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_IMAGE_MODELS: "img-a" }, async () => {
    let sentLen = 0;
    const p = new FreeLlmImageProvider({ promptMax: 300, fetchImpl: async (_u, init) => {
      sentLen = (JSON.parse(String(init?.body)) as { prompt: string }).prompt.length;
      return imgResponse({ data: [{ b64_json: PNG_B64 }], model: "m", provider: "nvidia" });
    } });
    await p.generate({ prompt: "photorealistic train station commuter ".repeat(40), aspect: "16:9" });
    assert.ok(sentLen <= 300, `sent ${sentLen} chars`);
  });
});

test("FREELLMAPI_IMAGE_PROMPT_MAX env overrides the default cap", async () => {
  const { freeImagePromptMax } = await import("../src/free-media-policy.ts");
  assert.equal(freeImagePromptMax({} as NodeJS.ProcessEnv), 700);
  assert.equal(freeImagePromptMax({ FREELLMAPI_IMAGE_PROMPT_MAX: "480" } as NodeJS.ProcessEnv), 480);
  assert.equal(freeImagePromptMax({ FREELLMAPI_IMAGE_PROMPT_MAX: "junk" } as NodeJS.ProcessEnv), 700);
  assert.equal(freeImagePromptMax({ FREELLMAPI_IMAGE_PROMPT_MAX: "10" } as NodeJS.ProcessEnv), 700);
});
