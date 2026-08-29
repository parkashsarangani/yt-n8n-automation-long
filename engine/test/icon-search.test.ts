import test from "node:test";
import assert from "node:assert/strict";

import { searchEntityIcon, resolveEntityIcons, type FetchLike } from "../src/icon-search.ts";

function fakeFetch(responses: Record<string, unknown>, opts: { fail?: string[] } = {}): FetchLike {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    if (opts.fail?.some((substr) => url.includes(substr))) return { ok: false, json: async () => ({}) };
    for (const [substr, body] of Object.entries(responses)) {
      if (url.includes(substr)) return { ok: true, json: async () => body };
    }
    return { ok: true, json: async () => ({}) };
  }) as FetchLike;
  (impl as unknown as { calls: string[] }).calls = calls;
  return impl;
}

const SEARCH_OK = { icons: ["mdi:water", "mdi:water-outline"] };
const DATA_OK = { width: 24, height: 24, icons: { water: { body: '<path fill="currentColor" d="M12 2 L4 14 L20 14 Z"/>' } } };

test("resolves a real icon on a successful search + data fetch", async () => {
  const fetchImpl = fakeFetch({ "search?query=water": SEARCH_OK, "mdi.json?icons=water": DATA_OK });
  const icon = await searchEntityIcon("water", fetchImpl);
  assert.ok(icon, "expected a resolved icon");
  assert.equal(icon!.iconId, "mdi:water");
  assert.equal(icon!.viewBox, "0 0 24 24");
  assert.match(icon!.body, /<path/);
});

test("returns null when search has no results", async () => {
  const fetchImpl = fakeFetch({ "search?query=": { icons: [] } });
  const icon = await searchEntityIcon("an entirely made up nonsense phrase", fetchImpl);
  assert.equal(icon, null);
});

test("returns null when the data fetch fails", async () => {
  const fetchImpl = fakeFetch({ "search?query=water": SEARCH_OK }, { fail: ["mdi.json"] });
  const icon = await searchEntityIcon("water", fetchImpl);
  assert.equal(icon, null);
});

test("returns null when the icon body is too large to read at entity-mark size", async () => {
  const huge = { width: 24, height: 24, icons: { water: { body: `<path d="${"M1 1 ".repeat(1000)}"/>` } } };
  const fetchImpl = fakeFetch({ "search?query=water": SEARCH_OK, "mdi.json?icons=water": huge });
  const icon = await searchEntityIcon("water", fetchImpl);
  assert.equal(icon, null);
});

test("rejects a body carrying executable content instead of trusting the source implicitly", async () => {
  const malicious = { width: 24, height: 24, icons: { water: { body: '<path d="M0 0"/><script>alert(1)</script>' } } };
  const fetchImpl = fakeFetch({ "search?query=water": SEARCH_OK, "mdi.json?icons=water": malicious });
  const icon = await searchEntityIcon("water", fetchImpl);
  assert.equal(icon, null, "a body containing <script> must never reach the renderer");
});

test("a network error resolves to null, not a thrown exception", async () => {
  const fetchImpl: FetchLike = async () => { throw new Error("ECONNRESET"); };
  const icon = await searchEntityIcon("water", fetchImpl);
  assert.equal(icon, null);
});

test("blank label resolves to null without making a network call", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const icon = await searchEntityIcon("   ", fetchImpl);
  assert.equal(icon, null);
  assert.equal(called, false);
});

test("resolveEntityIcons dedupes lookups by label and maps the icon back to every id sharing it", async () => {
  const fetchImpl = fakeFetch({ "search?query=water": SEARCH_OK, "mdi.json?icons=water": DATA_OK });
  const calls = (fetchImpl as unknown as { calls: string[] }).calls;
  const icons = await resolveEntityIcons(
    [{ id: "entity-water-a1", label: "water" }, { id: "entity-water-b2", label: "Water" }],
    fetchImpl,
  );
  assert.equal(icons.size, 2, "both ids must resolve even though they shared one lookup");
  assert.equal(icons.get("entity-water-a1")?.iconId, "mdi:water");
  assert.equal(icons.get("entity-water-b2")?.iconId, "mdi:water");
  const searchCalls = calls.filter((url) => url.includes("api.iconify.design/search"));
  assert.equal(searchCalls.length, 1, "case-insensitive duplicate labels must only be looked up once");
});

test("one entity's failed lookup does not block the others in the same batch", async () => {
  const fetchImpl = fakeFetch(
    { "search?query=water": SEARCH_OK, "mdi.json?icons=water": DATA_OK, "search?query=onion": { icons: [] } },
  );
  const icons = await resolveEntityIcons(
    [{ id: "entity-water", label: "water" }, { id: "entity-onion", label: "onion" }],
    fetchImpl,
  );
  assert.equal(icons.get("entity-water")?.iconId, "mdi:water");
  assert.equal(icons.has("entity-onion"), false, "an unmatched entity is simply absent, not an error");
});
