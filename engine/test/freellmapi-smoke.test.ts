import test from "node:test";
import assert from "node:assert/strict";

import { parseCooldownMs, runSmoke, SmokeError } from "../scripts/freellmapi-smoke.ts";

const OK_BODY = { choices: [{ message: { role: "assistant", content: "OK" } }], model: "gemini-3.5-flash" };

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

function stubFetch(queue: Response[]): { impl: typeof fetch; calls: () => number } {
  let i = 0;
  const impl = (async () => {
    const next = queue[i++];
    if (!next) throw new Error("stubFetch: no more queued responses");
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls: () => i };
}

const noSleep = async () => {};
const silent = { log: () => {}, warn: () => {} };

const base = {
  baseUrl: "http://freellmapi:3001/v1",
  apiKey: "k",
  model: "gemini-3.5-flash",
  sleepImpl: noSleep,
  logger: silent,
};

test("parseCooldownMs reads minute, second and millisecond hints", () => {
  assert.equal(parseCooldownMs("Soonest cooldown reset ~10m."), 600_000);
  assert.equal(parseCooldownMs("cooldown reset ~90s"), 90_000);
  assert.equal(parseCooldownMs("cooldown reset ~2 minutes"), 120_000);
  assert.equal(parseCooldownMs("cooldown reset ~500ms"), 500);
  assert.equal(parseCooldownMs("no hint here"), undefined);
});

test("a healthy pinned Gemini route passes on the first attempt", async () => {
  const { impl, calls } = stubFetch([response(200, OK_BODY, { "x-routed-via": "google/gemini-3.5-flash" })]);
  const result = await runSmoke({ ...base, fetchImpl: impl });
  assert.equal(result.attempts, 1);
  assert.equal(result.routedVia, "google/gemini-3.5-flash");
  assert.equal(calls(), 1);
});

test("a transient 429 is retried and then succeeds without switching model", async () => {
  const seen: string[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)).model);
    return seen.length === 1
      ? response(429, { error: { message: "All models rate-limited. Soonest cooldown reset ~2m." } })
      : response(200, OK_BODY, { "x-routed-via": "google/gemini-3.5-flash" });
  }) as unknown as typeof fetch;

  const waits: number[] = [];
  const result = await runSmoke({ ...base, fetchImpl: impl, sleepImpl: async (ms) => { waits.push(ms); } });
  assert.equal(result.attempts, 2);
  assert.deepEqual(seen, ["gemini-3.5-flash", "gemini-3.5-flash"]);
  // honoured the ~2m hint, capped by perWaitCap (default 4m) -> 120s
  assert.deepEqual(waits, [120_000]);
});

test("sustained 429s fail closed after the bounded attempt budget", async () => {
  const { impl } = stubFetch(
    Array.from({ length: 5 }, () => response(429, { error: { message: "rate-limited. cooldown reset ~1m" } })),
  );
  await assert.rejects(
    runSmoke({ ...base, fetchImpl: impl, maxAttempts: 3 }),
    (err: unknown) => err instanceof SmokeError && /still rate-limited\/unavailable after 3/.test((err as Error).message),
  );
});

test("the total wait budget is never exceeded", async () => {
  const { impl } = stubFetch(
    Array.from({ length: 6 }, () => response(429, { error: { message: "cooldown reset ~10m" } })),
  );
  const waits: number[] = [];
  await assert.rejects(
    runSmoke({ ...base, fetchImpl: impl, maxAttempts: 6, perWaitCapMs: 240_000, totalWaitCapMs: 300_000, sleepImpl: async (ms) => { waits.push(ms); } }),
  );
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 300_000, `summed waits ${waits} exceeded budget`);
});

test("a 401 is a genuine auth failure and is never retried", async () => {
  const { impl, calls } = stubFetch([
    response(401, { error: { message: "Invalid API key" } }),
    response(200, OK_BODY),
  ]);
  await assert.rejects(
    runSmoke({ ...base, fetchImpl: impl }),
    (err: unknown) => err instanceof SmokeError && /401/.test((err as Error).message),
  );
  assert.equal(calls(), 1);
});

test("a 404 model_not_found is fatal, not a rate-limit wait", async () => {
  const { impl, calls } = stubFetch([
    response(404, { error: { message: "model not found or removed upstream" } }),
  ]);
  await assert.rejects(
    runSmoke({ ...base, fetchImpl: impl }),
    (err: unknown) => err instanceof SmokeError && /404/.test((err as Error).message),
  );
  assert.equal(calls(), 1);
});

test("a 200 answered by a non-Gemini fallback route is rejected", async () => {
  const { impl } = stubFetch([response(200, { ...OK_BODY, model: "gpt-5.6-luna" }, { "x-routed-via": "openai/gpt-5.6-luna" })]);
  await assert.rejects(
    runSmoke({ ...base, fetchImpl: impl }),
    (err: unknown) => err instanceof SmokeError && /unexpected route/.test((err as Error).message),
  );
});

test("5xx provider errors are retried like a rate-limit", async () => {
  let n = 0;
  const impl = (async () => {
    n++;
    return n < 3 ? response(502, { error: { message: "empty completion" } }) : response(200, OK_BODY, { "x-routed-via": "google/gemini-3.5-flash" });
  }) as unknown as typeof fetch;
  const result = await runSmoke({ ...base, fetchImpl: impl });
  assert.equal(result.attempts, 3);
});
