import test from "node:test";
import assert from "node:assert/strict";

import { parseCooldownMs, resolveSmokeModels, runSmoke, SmokeError, type Endpoint } from "../scripts/freellmapi-smoke.ts";

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

const OK = (model: string) => ({ choices: [{ message: { role: "assistant", content: "OK" } }], model });

const noSleep = async () => {};
const silent = { log: () => {}, warn: () => {} };

const chain: Endpoint[] = [
  { baseUrl: "http://freellmapi:3001/v1", apiKey: "k", model: "model-a" },
  { baseUrl: "http://freellmapi:3001/v1", apiKey: "k", model: "model-b" },
  { baseUrl: "http://freellmapi:3001/v1", apiKey: "k", model: "model-c" },
];
const base = { models: chain, sleepImpl: noSleep, logger: silent };

/** fetch double that dispatches on the requested model id. */
function byModel(handlers: Record<string, () => Response>): { impl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    const model = JSON.parse(String(init.body)).model as string;
    seen.push(model);
    const h = handlers[model];
    if (!h) throw new Error(`no handler for model ${model}`);
    return h();
  }) as unknown as typeof fetch;
  return { impl, seen };
}

test("parseCooldownMs reads minute, second and millisecond hints", () => {
  assert.equal(parseCooldownMs("Soonest cooldown reset ~10m."), 600_000);
  assert.equal(parseCooldownMs("cooldown reset ~90s"), 90_000);
  assert.equal(parseCooldownMs("All models exhausted ... Soonest reset ~48s."), 48_000);
  assert.equal(parseCooldownMs("cooldown reset ~500ms"), 500);
  assert.equal(parseCooldownMs("no hint here"), undefined);
});

test("the first healthy model in the chain passes on the first attempt", async () => {
  const { impl, seen } = byModel({ "model-a": () => response(200, OK("gpt-oss-120b"), { "x-routed-via": "openai/gpt-oss-120b" }) });
  const result = await runSmoke({ ...base, fetchImpl: impl });
  assert.equal(result.model, "model-a");
  assert.equal(result.routedVia, "openai/gpt-oss-120b");
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(seen, ["model-a"]);
});

test("a transient 429 is retried on the same model before moving on", async () => {
  let n = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    const model = JSON.parse(String(init.body)).model as string;
    assert.equal(model, "model-a");
    n++;
    return n === 1 ? response(429, { error: { message: "rate-limited. cooldown reset ~2m" } }) : response(200, OK("served"), {});
  }) as unknown as typeof fetch;
  const waits: number[] = [];
  const result = await runSmoke({ ...base, fetchImpl: impl, sleepImpl: async (ms) => { waits.push(ms); } });
  assert.equal(result.model, "model-a");
  assert.equal(result.attempts, 2);
  assert.deepEqual(waits, [30_000]); // per-model wait is capped so the chain keeps moving
});

test("a rate-limited primary model is skipped for the next configured model, never paid OpenAI", async () => {
  const { impl, seen } = byModel({
    "model-a": () => response(429, { error: { message: "All models exhausted. Soonest reset ~48s." } }),
    "model-b": () => response(200, OK("served-b"), { "x-routed-via": "cf/llama" }),
  });
  const result = await runSmoke({ ...base, fetchImpl: impl, maxAttemptsPerModel: 2 });
  assert.equal(result.model, "model-b");
  assert.equal(result.routedVia, "cf/llama");
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]!, /^model-a/);
  assert.deepEqual(seen, ["model-a", "model-a", "model-b"]);
});

test("a 404 model_not_found moves straight to the next model without waiting", async () => {
  const waits: number[] = [];
  const { impl, seen } = byModel({
    "model-a": () => response(404, { error: { message: "model not found or removed upstream" } }),
    "model-b": () => response(200, OK("served-b")),
  });
  const result = await runSmoke({ ...base, fetchImpl: impl, sleepImpl: async (ms) => { waits.push(ms); } });
  assert.equal(result.model, "model-b");
  assert.deepEqual(seen, ["model-a", "model-b"]);
  assert.deepEqual(waits, []);
});

test("primary + secondary failing falls to the tertiary model", async () => {
  const { impl } = byModel({
    "model-a": () => response(503, { error: { message: "upstream down" } }),
    "model-b": () => response(429, { error: { message: "rate limit" } }),
    "model-c": () => response(200, OK("served-c")),
  });
  const result = await runSmoke({ ...base, fetchImpl: impl, maxAttemptsPerModel: 1 });
  assert.equal(result.model, "model-c");
  assert.equal(result.skipped.length, 2);
});

test("every model unavailable fails closed, listing each one and its reason", async () => {
  const { impl, seen } = byModel({
    "model-a": () => response(429, { error: { message: "rate" } }),
    "model-b": () => response(502, { error: { message: "down" } }),
    "model-c": () => response(503, { error: { message: "down" } }),
  });
  await assert.rejects(
    runSmoke({ ...base, fetchImpl: impl, maxAttemptsPerModel: 1 }),
    (err: unknown) => err instanceof SmokeError
      && /every configured free text model is unavailable/.test((err as Error).message)
      && /model-a/.test((err as Error).message) && /model-c/.test((err as Error).message),
  );
  assert.deepEqual(seen, ["model-a", "model-b", "model-c"]);
});

test("a 401 is an auth failure and ends the probe immediately", async () => {
  const { impl, seen } = byModel({ "model-a": () => response(401, { error: { message: "Invalid API key" } }) });
  await assert.rejects(
    runSmoke({ ...base, fetchImpl: impl }),
    (err: unknown) => err instanceof SmokeError && /auth failed/.test((err as Error).message) && /401/.test((err as Error).message),
  );
  assert.deepEqual(seen, ["model-a"]);
});

test("the total wait budget across the whole chain is never exceeded", async () => {
  const { impl } = byModel({
    "model-a": () => response(429, { error: { message: "cooldown reset ~10m" } }),
    "model-b": () => response(429, { error: { message: "cooldown reset ~10m" } }),
    "model-c": () => response(429, { error: { message: "cooldown reset ~10m" } }),
  });
  const waits: number[] = [];
  await assert.rejects(runSmoke({
    ...base,
    fetchImpl: impl,
    maxAttemptsPerModel: 4,
    perWaitCapMs: 240_000,
    totalWaitCapMs: 90_000,
    sleepImpl: async (ms) => { waits.push(ms); },
  }));
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 90_000, `summed waits ${waits} exceeded budget`);
});

test("resolveSmokeModels builds one endpoint per concrete id and rejects auto", () => {
  const env = { FREELLMAPI_API_KEY: "k", FREELLMAPI_BASE_URL: "http://x/v1", FREELLMAPI_TEXT_MODELS: "a, b ,c" };
  const models = resolveSmokeModels(env);
  assert.deepEqual(models.map((m) => m.model), ["a", "b", "c"]);
  assert.ok(models.every((m) => m.baseUrl === "http://x/v1" && m.apiKey === "k"));

  assert.throws(() => resolveSmokeModels({ FREELLMAPI_API_KEY: "k", FREELLMAPI_TEXT_MODELS: "a,auto:smart" }), /auto routing/);
  assert.throws(() => resolveSmokeModels({ FREELLMAPI_TEXT_MODELS: "a" }), /FREELLMAPI_API_KEY/);
});

test("resolveSmokeModels accepts a single legacy FREELLMAPI_TEXT_MODEL", () => {
  const models = resolveSmokeModels({ FREELLMAPI_API_KEY: "k", FREELLMAPI_TEXT_MODEL: "legacy-model" });
  assert.deepEqual(models.map((m) => m.model), ["legacy-model"]);
});
