import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fallbackPolicy, policyFlag, resolveFreeVisionModels, paidVideoGenerationAllowed } from "../src/fallback-policy.ts";
import { OpenAIProvider } from "../src/providers/openai.ts";
import { ProviderError, ProviderRefusal } from "../src/provider.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const ENV_KEYS = [
  "LLM_ROUTER_MODE", "FREELLMAPI_API_KEY", "FREELLMAPI_BASE_URL", "FREELLMAPI_TEXT_MODELS",
  "OPENAI_API_KEY", "OPENAI_MODEL",
  "PAID_TEXT_FALLBACK", "PAID_VISION_FALLBACK", "PAID_IMAGE_FALLBACK", "PAID_VIDEO_FALLBACK", "FREE_VISION_MODELS",
  "FAL_KEY",
] as const;

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
    return await run();
  } finally {
    for (const k of ENV_KEYS) {
      const v = previous[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const noWait = { freeRetryDelayMs: 0, sleepImpl: async () => {} } as const;
const CHAIN = "model-a,model-b";

function freeJson(content = '{"ok":true}', model = "free-served"): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
    model,
  }), { status: 200, headers: { "content-type": "application/json" } });
}
function sseDirect(content = '{"ok":true}'): Response {
  const chunks = [
    { choices: [{ delta: { content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ];
  return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } });
}

// --- policy module -----------------------------------------------------------

test("policyFlag parses truthy/falsey and otherwise returns the fallback", () => {
  for (const v of ["1", "true", "TRUE", "yes", "on"]) assert.equal(policyFlag(v, false), true, v);
  for (const v of ["0", "false", "no", "off"]) assert.equal(policyFlag(v, true), false, v);
  assert.equal(policyFlag(undefined, true), true);
  assert.equal(policyFlag("", true), true);
  assert.equal(policyFlag("garbage", false), false);
});

test("fallback policy defaults: text/vision/image ON, video OFF", async () => {
  await withEnv({}, async () => {
    const p = fallbackPolicy();
    assert.equal(p.paidTextFallback, true);
    assert.equal(p.paidVisionFallback, true);
    assert.equal(p.paidImageFallback, true);
    assert.equal(p.paidVideoFallback, false);
    assert.deepEqual(p.freeVisionModels, []);
    assert.equal(paidVideoGenerationAllowed(), false);
  });
});

test("FREE_VISION_MODELS is an ordered concrete list; auto ids are dropped", () => {
  assert.deepEqual(resolveFreeVisionModels({ FREE_VISION_MODELS: " a , b ,auto:smart, c " } as NodeJS.ProcessEnv), ["a", "b", "c"]);
  assert.deepEqual(resolveFreeVisionModels({} as NodeJS.ProcessEnv), []);
});

// --- TEXT (§15 tests 1-5) ---------------------------------------------------

test("text 1: primary free model succeeds; paid OpenAI is never called", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_TEXT_MODELS: CHAIN, OPENAI_API_KEY: "sk-paid" }, async () => {
    const urls: string[] = [];
    const provider = new OpenAIProvider({ apiKey: "sk-paid", ...noWait, fetchImpl: async (u) => { urls.push(String(u)); return freeJson(); } });
    const r = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });
    assert.equal(r.usage.provider, "freellmapi");
    assert.deepEqual(urls, ["http://free/v1/chat/completions"]);
  });
});

test("text 2: secondary free model succeeds after a 429; paid OpenAI is never called", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_TEXT_MODELS: CHAIN, OPENAI_API_KEY: "sk-paid" }, async () => {
    const seen: string[] = [];
    const provider = new OpenAIProvider({ apiKey: "sk-paid", ...noWait, fetchImpl: async (u, init) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      seen.push(String(u));
      return model === "model-a" ? new Response("busy", { status: 429 }) : freeJson('{"ok":true}', "model-b");
    } });
    const r = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });
    assert.equal(r.usage.model, "model-b");
    assert.ok(seen.every((u) => u.startsWith("http://free")), "no paid host touched");
  });
});

test("text 3: all free models fail -> paid OpenAI IS called when PAID_TEXT_FALLBACK=true", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_TEXT_MODELS: CHAIN, OPENAI_API_KEY: "sk-paid", PAID_TEXT_FALLBACK: "true" }, async () => {
    const urls: string[] = [];
    const provider = new OpenAIProvider({ apiKey: "sk-paid", ...noWait, fetchImpl: async (u) => {
      urls.push(String(u));
      return String(u).includes("free") ? new Response("down", { status: 503 }) : sseDirect();
    } });
    const r = await provider.complete({ prompt: "hi", outputSchema: SCHEMA });
    assert.equal(r.usage.provider, "openai");
    assert.equal(urls.filter((u) => u.includes("free")).length, 2, "both free models attempted first");
    assert.ok(urls.some((u) => u === "https://api.openai.com/v1/chat/completions"), "paid OpenAI called last");
  });
});

test("text 4: all free models fail -> HARD failure, no paid call, when PAID_TEXT_FALLBACK=false", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_TEXT_MODELS: CHAIN, OPENAI_API_KEY: "sk-paid", PAID_TEXT_FALLBACK: "false" }, async () => {
    const urls: string[] = [];
    const provider = new OpenAIProvider({ apiKey: "sk-paid", ...noWait, fetchImpl: async (u) => { urls.push(String(u)); return new Response("down", { status: 503 }); } });
    await assert.rejects(
      () => provider.complete({ prompt: "hi", outputSchema: SCHEMA }),
      (err: unknown) => err instanceof ProviderError
        && /all 2 configured free text model\(s\) unavailable/.test(err.message)
        && /paid text fallback is disabled/.test(err.message),
    );
    assert.ok(urls.every((u) => u.startsWith("http://free")), "no paid OpenAI request");
  });
});

test("text 5: an auto id anywhere in the pinned chain is rejected before any call, fallback or not", async () => {
  for (const list of ["auto:smart", "model-a,auto"]) {
    await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_TEXT_MODELS: list, OPENAI_API_KEY: "sk-paid", PAID_TEXT_FALLBACK: "true" }, async () => {
      assert.throws(() => new OpenAIProvider({ ...noWait, fetchImpl: async () => freeJson() }), /may not contain auto routing/);
    });
  }
});

test("text: a policy refusal from a free model is thrown at once and never reaches paid", async () => {
  await withEnv({ FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://free/v1", FREELLMAPI_TEXT_MODELS: CHAIN, OPENAI_API_KEY: "sk-paid", PAID_TEXT_FALLBACK: "true" }, async () => {
    let calls = 0;
    const provider = new OpenAIProvider({ apiKey: "sk-paid", ...noWait, fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: "content_policy" }), { status: 400 }); } });
    await assert.rejects(() => provider.complete({ prompt: "hi", outputSchema: SCHEMA }), (e: unknown) => e instanceof ProviderRefusal);
    assert.equal(calls, 1);
  });
});

// --- VIDEO hard guard (§15 tests 14-18, source-level contract) --------------

async function resolverSource(): Promise<string> {
  return readFile(path.join(ROOT, "src/workers/visual-beat-resolver.ts"), "utf8");
}

test("video: PAID_VIDEO_FALLBACK=false is the code default and blocks the generated_video capability", async () => {
  await withEnv({ FAL_KEY: "fal-configured" }, async () => {
    // Even with a paid video provider key configured, the policy default keeps it off.
    assert.equal(fallbackPolicy().paidVideoFallback, false);
    assert.equal(paidVideoGenerationAllowed(), false);
  });
  const src = await resolverSource();
  assert.match(src, /generated_video: freeVideo \|\| \(policy\.paidVideoFallback && Boolean\(process\.env\["FAL_KEY"\]/);
});

test("video: generateVideo() refuses to construct or call the paid provider while PAID_VIDEO_FALLBACK=false", async () => {
  const src = await resolverSource();
  const start = src.indexOf("async function generateVideo(");
  const end = src.indexOf("\nasync function resolveMode(", start);
  const impl = src.slice(start, end);
  // The guard must sit BEFORE `new FalVideoProvider()`.
  const guardAt = impl.indexOf("paidVideoFallback");
  const providerAt = impl.indexOf("new FalVideoProvider()");
  assert.ok(guardAt >= 0 && providerAt >= 0 && guardAt < providerAt, "hard guard must precede provider construction");
  assert.match(impl, /PAID_VIDEO_FALLBACK=false/);
});

test("video: a free-video-unavailable beat resolves to a non-video representation, never paid generation", async () => {
  const src = await resolverSource();
  // The router only offers generated_video as a route when the capability is
  // true; with the guard it is false, so selectVisualMode / alternateMode fall
  // to the beat's declared non-video alternate or a semantic representation.
  assert.match(src, /generated_video: freeVideo \|\| \(policy\.paidVideoFallback/);
  assert.match(src, /resolve this beat with a non-video representation/);
});

// --- IMAGE (§15 tests 11-13, source-level contract) ------------------------

test("image 11: exact-cache / image-bank reuse is attempted before any fal spend", async () => {
  const src = await resolverSource();
  const start = src.indexOf("async function generateImage(");
  const end = src.indexOf("\ninterface WindowCandidate", start);
  const impl = src.slice(start, end);
  const reuseAt = impl.indexOf("bank.searchByContext");
  const genAt = impl.indexOf("provider.generate({");
  assert.ok(reuseAt >= 0 && genAt >= 0 && reuseAt < genAt, "bank reuse must precede fal generation");
  assert.match(impl, /no fal spend/);
});

test("image 12: PAID_IMAGE_FALLBACK=false hands back to the router before any fal generation call", async () => {
  const src = await resolverSource();
  const start = src.indexOf("async function generateImage(");
  const end = src.indexOf("\ninterface WindowCandidate", start);
  const impl = src.slice(start, end);
  const guardAt = impl.indexOf("if (!paidImageAvailable && candidates.length === 0)");
  const genAt = impl.indexOf("provider.generate({");
  assert.ok(guardAt >= 0 && guardAt < genAt, "the paid-image guard must precede fal generation");
  // Paid image is only available when the flag is on AND the provider is fal-backed.
  assert.match(impl, /const paidImageAvailable = fallbackPolicy\(\)\.paidImageFallback && provider\.id\.toLowerCase\(\)\.includes\("fal"\)/);
  assert.match(impl, /PAID_IMAGE_FALLBACK=/);
});

test("image 13: paid image generation is permitted (default) - only paid IMAGE, never paid video, is an image fallback", async () => {
  const src = await resolverSource();
  // generateImage never reaches for a video provider as a fallback.
  const start = src.indexOf("async function generateImage(");
  const end = src.indexOf("\ninterface WindowCandidate", start);
  assert.doesNotMatch(src.slice(start, end), /FalVideoProvider|generateVideo/);
});
