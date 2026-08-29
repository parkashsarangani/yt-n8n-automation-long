import test from "node:test";
import assert from "node:assert/strict";

import { checkGeneratedImageForText, checkGeneratedImageMatchesNarration, type FetchLike } from "../src/image-qa.ts";

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

// --- semantic (narration-match) checks -------------------------------------
//
// Motivating production defect (run_ad5bd430): over narration about keeping
// an irritant AWAY from the eyes, the image model rendered a glowing beam
// running BETWEEN the characters' eyes. Stylistically on-model, no text, so
// the text-only gate passed it -- exactly what a human storyboard review
// catches and schema validation cannot.

test("flags an image the vision model reports as contradicting its narration", async () => {
  await withApiKey(async () => {
    const fetchImpl = fakeResponse(JSON.stringify({ contradicts_narration: true, reason: "beam runs into the eyes, the line says it is kept away" }));
    const result = await checkGeneratedImageMatchesNarration(IMAGE, "ventilation reduces what reaches your eyes", fetchImpl);
    assert.equal(result?.contradictsNarration, true);
    assert.match(result!.reason, /eyes/);
  });
});

test("passes an image that merely associates loosely with the narration", async () => {
  await withApiKey(async () => {
    const fetchImpl = fakeResponse(JSON.stringify({ contradicts_narration: false, reason: "atmospheric but not contradictory" }));
    const result = await checkGeneratedImageMatchesNarration(IMAGE, "the enzyme meets sulfur compounds", fetchImpl);
    assert.equal(result?.contradictsNarration, false);
  });
});

test("the semantic prompt tells the model not to flag loose/abstract b-roll and to default to false", async () => {
  // The bar is "contradicts", never "illustrates well" -- a high
  // false-positive rate here would push good scenes down the fallback path
  // and make episodes MORE generic, the opposite of the goal. Assert the
  // prompt actually carries that instruction rather than trusting the
  // docstring.
  await withApiKey(async () => {
    let sentBody = "";
    const fetchImpl: FetchLike = (async (_url, init) => {
      sentBody = init.body;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ contradicts_narration: false, reason: "" }) } }] }), text: async () => "" };
    }) as FetchLike;
    await checkGeneratedImageMatchesNarration(IMAGE, "a spoken line", fetchImpl);
    assert.match(sentBody, /Do NOT flag an image merely for being atmospheric/);
    assert.match(sentBody, /If you are unsure, answer false/);
    assert.match(sentBody, /a spoken line/, "the narration must actually reach the model");
  });
});

test("returns null without a network call when the narration is empty", async () => {
  await withApiKey(async () => {
    let called = false;
    const fetchImpl: FetchLike = (async () => { called = true; return { ok: true, status: 200, json: async () => ({}), text: async () => "" }; }) as FetchLike;
    const result = await checkGeneratedImageMatchesNarration(IMAGE, "   ", fetchImpl);
    assert.equal(result, null);
    assert.equal(called, false);
  });
});

test("semantic check returns null (never throws) on network error, bad JSON, or missing field", async () => {
  await withApiKey(async () => {
    const thrower: FetchLike = (async () => { throw new Error("ECONNRESET"); }) as FetchLike;
    assert.equal(await checkGeneratedImageMatchesNarration(IMAGE, "line", thrower), null);
    assert.equal(await checkGeneratedImageMatchesNarration(IMAGE, "line", fakeResponse("not json")), null);
    assert.equal(await checkGeneratedImageMatchesNarration(IMAGE, "line", fakeResponse(JSON.stringify({ reason: "no boolean here" }))), null);
  });
});

test("semantic check returns null when no API key is configured", async () => {
  const prev = process.env["OPENAI_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
  try {
    let called = false;
    const fetchImpl: FetchLike = (async () => { called = true; return { ok: true, status: 200, json: async () => ({}), text: async () => "" }; }) as FetchLike;
    assert.equal(await checkGeneratedImageMatchesNarration(IMAGE, "line", fetchImpl), null);
    assert.equal(called, false);
  } finally {
    if (prev !== undefined) process.env["OPENAI_API_KEY"] = prev;
  }
});
