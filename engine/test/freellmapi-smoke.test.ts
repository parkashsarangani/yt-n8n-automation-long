import test from "node:test";
import assert from "node:assert/strict";

import { parseCooldownMs, runSmoke, SmokeError } from "../scripts/freellmapi-smoke.ts";

const OK_BODY = { choices: [{ message: { role: "assistant", content: "OK" } }], model: "gemini-3.5-flash" };

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

/** Route responses by request URL so primary vs fail-open can be distinguished. */
function router(handlers: { primary: () => Response; failOpen?: () => Response }): { impl: typeof fetch; primaryCalls: () => number; failOpenCalls: () => number } {
  let p = 0;
  let f = 0;
  const impl = (async (url: string) => {
    if (url.includes("freellmapi") || url.includes(":3001")) {
      p++;
      return handlers.primary();
    }
    f++;
    if (!handlers.failOpen) throw new Error("unexpected fail-open call");
    return handlers.failOpen();
  }) as unknown as typeof fetch;
  return { impl, primaryCalls: () => p, failOpenCalls: () => f };
}

const noSleep = async () => {};
const silent = { log: () => {}, warn: () => {} };

const primary = { baseUrl: "http://freellmapi:3001/v1", apiKey: "k", model: "gemini-3.5-flash" };
const failOpen = { baseUrl: "https://api.openai.com/v1", apiKey: "o", model: "gpt-5.6-luna" };
const base = { primary, sleepImpl: noSleep, logger: silent };

test("parseCooldownMs reads minute, second and millisecond hints", () => {
  assert.equal(parseCooldownMs("Soonest cooldown reset ~10m."), 600_000);
  assert.equal(parseCooldownMs("cooldown reset ~90s"), 90_000);
  assert.equal(parseCooldownMs("All models exhausted ... Soonest reset ~48s."), 48_000);
  assert.equal(parseCooldownMs("cooldown reset ~2 minutes"), 120_000);
  assert.equal(parseCooldownMs("cooldown reset ~500ms"), 500);
  assert.equal(parseCooldownMs("no hint here"), undefined);
});

test("a healthy pinned Gemini route passes on the first attempt", async () => {
  const r = router({ primary: () => response(200, OK_BODY, { "x-routed-via": "google/gemini-3.5-flash" }) });
  const result = await runSmoke({ ...base, fetchImpl: r.impl });
  assert.deepEqual(result, { routedVia: "google/gemini-3.5-flash", attempts: 1, degraded: false });
  assert.equal(r.primaryCalls(), 1);
});

test("a transient 429 is retried and then succeeds without switching model", async () => {
  const seen: string[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)).model);
    return seen.length === 1
      ? response(429, { error: { message: "rate-limited. Soonest cooldown reset ~2m." } })
      : response(200, OK_BODY, { "x-routed-via": "google/gemini-3.5-flash" });
  }) as unknown as typeof fetch;
  const waits: number[] = [];
  const result = await runSmoke({ ...base, fetchImpl: impl, sleepImpl: async (ms) => { waits.push(ms); } });
  assert.equal(result.attempts, 2);
  assert.equal(result.degraded, false);
  assert.deepEqual(seen, ["gemini-3.5-flash", "gemini-3.5-flash"]);
  assert.deepEqual(waits, [120_000]);
});

test("the probe never sends reasoning_effort (some Gemini flash models reject it)", async () => {
  let body: Record<string, unknown> = {};
  const impl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return response(200, OK_BODY, { "x-routed-via": "google/gemini-3.5-flash" });
  }) as unknown as typeof fetch;
  await runSmoke({ ...base, fetchImpl: impl });
  assert.equal("reasoning_effort" in body, false);
  assert.equal(body["max_completion_tokens"], 800);
});

test("sustained 429 with no fail-open route fails closed after the attempt budget", async () => {
  const r = router({ primary: () => response(429, { error: { message: "rate-limited. cooldown reset ~1m" } }) });
  await assert.rejects(
    runSmoke({ ...base, fetchImpl: r.impl, maxAttempts: 3 }),
    (err: unknown) => err instanceof SmokeError && /no fail-open route is configured/.test((err as Error).message),
  );
  assert.equal(r.primaryCalls(), 3);
});

test("sustained 429 with a healthy fail-open route starts the benchmark DEGRADED", async () => {
  const r = router({
    primary: () => response(429, { error: { message: "All models exhausted. Soonest reset ~48s." } }),
    failOpen: () => response(200, { choices: [{ message: { content: "OK" } }], model: "gpt-5.6-luna" }, { "x-routed-via": "openai/gpt-5.6-luna" }),
  });
  const result = await runSmoke({ ...base, failOpen, fetchImpl: r.impl, maxAttempts: 3 });
  assert.equal(result.degraded, true);
  assert.equal(result.routedVia, "openai/gpt-5.6-luna");
  assert.equal(r.primaryCalls(), 3);
  assert.equal(r.failOpenCalls(), 1);
});

test("sustained 429 AND a dead fail-open route fails closed", async () => {
  const r = router({
    primary: () => response(429, { error: { message: "rate-limited. cooldown reset ~30s" } }),
    failOpen: () => response(500, { error: { message: "upstream down" } }),
  });
  await assert.rejects(
    runSmoke({ ...base, failOpen, fetchImpl: r.impl, maxAttempts: 2 }),
    (err: unknown) => err instanceof SmokeError && /fail-open route also failed/.test((err as Error).message),
  );
});

test("the total wait budget is never exceeded", async () => {
  const r = router({ primary: () => response(429, { error: { message: "cooldown reset ~10m" } }) });
  const waits: number[] = [];
  await assert.rejects(
    runSmoke({ ...base, fetchImpl: r.impl, maxAttempts: 6, perWaitCapMs: 240_000, totalWaitCapMs: 300_000, sleepImpl: async (ms) => { waits.push(ms); } }),
  );
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 300_000, `summed waits ${waits} exceeded budget`);
});

test("a 401 is a genuine auth failure and is never retried or failed-open", async () => {
  const r = router({
    primary: () => response(401, { error: { message: "Invalid API key" } }),
    failOpen: () => response(200, OK_BODY),
  });
  await assert.rejects(
    runSmoke({ ...base, failOpen, fetchImpl: r.impl }),
    (err: unknown) => err instanceof SmokeError && /401/.test((err as Error).message),
  );
  assert.equal(r.primaryCalls(), 1);
  assert.equal(r.failOpenCalls(), 0);
});

test("a 404 model_not_found is fatal, not a rate-limit wait", async () => {
  const r = router({ primary: () => response(404, { error: { message: "model not found or removed upstream" } }) });
  await assert.rejects(
    runSmoke({ ...base, failOpen, fetchImpl: r.impl }),
    (err: unknown) => err instanceof SmokeError && /404/.test((err as Error).message),
  );
  assert.equal(r.primaryCalls(), 1);
});

test("a 200 answered by a non-Gemini route on the primary is rejected", async () => {
  const r = router({ primary: () => response(200, { ...OK_BODY, model: "gpt-5.6-luna" }, { "x-routed-via": "openai/gpt-5.6-luna" }) });
  await assert.rejects(
    runSmoke({ ...base, fetchImpl: r.impl }),
    (err: unknown) => err instanceof SmokeError && /unexpected route/.test((err as Error).message),
  );
});

test("5xx provider errors are retried like a rate-limit", async () => {
  let n = 0;
  const impl = (async (url: string) => {
    if (!url.includes("3001")) throw new Error("no fail-open expected");
    n++;
    return n < 3 ? response(502, { error: { message: "empty completion" } }) : response(200, OK_BODY, { "x-routed-via": "google/gemini-3.5-flash" });
  }) as unknown as typeof fetch;
  const result = await runSmoke({ ...base, fetchImpl: impl });
  assert.equal(result.attempts, 3);
  assert.equal(result.degraded, false);
});
