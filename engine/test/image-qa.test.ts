import test from "node:test";
import assert from "node:assert/strict";

import { checkGeneratedImageForText, type FetchLike } from "../src/image-qa.ts";

const IMAGE = { bytes: new Uint8Array([1, 2, 3, 4]), media_type: "image/png" };

function withApiKey<T>(run: () => Promise<T>): Promise<T> {
  const prev = process.env["OPENAI_API_KEY"];
  process.env["OPENAI_API_KEY"] = "test-key";
  return run().finally(() => {
    if (prev === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = prev;
  });
}

function fakeResponse(content: string): FetchLike {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => content,
  })) as FetchLike;
}

test("flags an image the vision model reports as carrying visible text", async () => {
  await withApiKey(async () => {
    const fetchImpl = fakeResponse(JSON.stringify({ has_visible_text: true, reason: "engraved lettering on the knife blade" }));
    const result = await checkGeneratedImageForText(IMAGE, fetchImpl);
    assert.equal(result?.hasVisibleText, true);
    assert.match(result!.reason, /lettering/);
  });
});

test("passes a clean image through unchanged", async () => {
  await withApiKey(async () => {
    const fetchImpl = fakeResponse(JSON.stringify({ has_visible_text: false, reason: "no text visible" }));
    const result = await checkGeneratedImageForText(IMAGE, fetchImpl);
    assert.equal(result?.hasVisibleText, false);
  });
});

test("returns null (not a thrown error) when no API key is configured", async () => {
  const prev = process.env["OPENAI_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
  try {
    let called = false;
    const fetchImpl: FetchLike = (async () => { called = true; return { ok: true, status: 200, json: async () => ({}), text: async () => "" }; }) as FetchLike;
    const result = await checkGeneratedImageForText(IMAGE, fetchImpl);
    assert.equal(result, null);
    assert.equal(called, false, "must not make a network call with no key configured");
  } finally {
    if (prev !== undefined) process.env["OPENAI_API_KEY"] = prev;
  }
});

test("returns null on an API error response, never throwing", async () => {
  await withApiKey(async () => {
    const fetchImpl: FetchLike = (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "server error" })) as FetchLike;
    const result = await checkGeneratedImageForText(IMAGE, fetchImpl);
    assert.equal(result, null);
  });
});

test("returns null on a network error, never throwing", async () => {
  await withApiKey(async () => {
    const fetchImpl: FetchLike = (async () => { throw new Error("ECONNRESET"); }) as FetchLike;
    const result = await checkGeneratedImageForText(IMAGE, fetchImpl);
    assert.equal(result, null);
  });
});

test("returns null on a malformed/non-JSON model response", async () => {
  await withApiKey(async () => {
    const fetchImpl = fakeResponse("not json at all");
    const result = await checkGeneratedImageForText(IMAGE, fetchImpl);
    assert.equal(result, null);
  });
});

test("returns null when the response is missing the required boolean field", async () => {
  await withApiKey(async () => {
    const fetchImpl = fakeResponse(JSON.stringify({ reason: "looks fine" }));
    const result = await checkGeneratedImageForText(IMAGE, fetchImpl);
    assert.equal(result, null);
  });
});
