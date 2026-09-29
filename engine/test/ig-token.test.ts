import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { IgTokenStore, IG_TOKEN_REFRESH_AFTER_MS } from "../src/ig-token.ts";

const DAY = 24 * 3600_000;

async function setup(envToken: string) {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "igtok-")), "meta", "ig-token.json");
  let now = Date.parse("2026-09-29T18:00:00Z");
  const calls: string[] = [];
  const fetchImpl = (async (_url: URL, init: RequestInit) => {
    calls.push(String((init.headers as Record<string, string>)["Authorization"]));
    return new Response(JSON.stringify({ access_token: `renewed-${calls.length}`, expires_in: 60 * 86400 }), { status: 200 });
  }) as unknown as typeof fetch;
  const make = (token = envToken) => new IgTokenStore(token, file, { fetchImpl, now: () => now });
  return { file, calls, make, advance: (ms: number) => { now += ms; } };
}

test("a new token is saved at once, so a restart does not reset its age", async () => {
  const s = await setup("tok-A");
  assert.equal(await s.make().get(), "tok-A");
  const saved = JSON.parse(await readFile(s.file, "utf8"));
  assert.equal(saved.token, "tok-A");
  s.advance(IG_TOKEN_REFRESH_AFTER_MS + DAY);
  // A fresh process (restart) sees the ORIGINAL issue time and renews.
  assert.equal(await s.make().refreshIfDue(), "refreshed");
});

test("renews only after a week, then uses and keeps the renewed token", async () => {
  const s = await setup("tok-A");
  const store = s.make();
  assert.equal(await store.refreshIfDue(), "not_due");
  assert.equal(s.calls.length, 0);
  s.advance(IG_TOKEN_REFRESH_AFTER_MS + 1);
  assert.equal(await store.refreshIfDue(), "refreshed");
  assert.equal(s.calls[0], "Bearer tok-A");
  assert.equal(await store.get(), "renewed-1");
  assert.equal(await s.make().get(), "renewed-1", "survives a restart");
});

test("a new secret pasted into GitHub replaces the stored token", async () => {
  const s = await setup("tok-A");
  const a = s.make();
  s.advance(IG_TOKEN_REFRESH_AFTER_MS + 1);
  await a.refreshIfDue();
  assert.equal(await s.make("tok-B").get(), "tok-B");
});

test("a failed renewal says so without leaking the token", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "igtok-")), "t.json");
  let now = 0;
  const store = new IgTokenStore("secret-tok", file, {
    now: () => now,
    fetchImpl: (async () => new Response(JSON.stringify({ error: { message: "bad token secret-tok" } }), { status: 400 })) as unknown as typeof fetch,
  });
  await store.get();
  now += IG_TOKEN_REFRESH_AFTER_MS + 1;
  await assert.rejects(store.refreshIfDue(), (e: Error) => /renewal failed/.test(e.message) && !e.message.includes("secret-tok"));
});
