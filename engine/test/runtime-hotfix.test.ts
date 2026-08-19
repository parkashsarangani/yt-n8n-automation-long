import test from "node:test";
import assert from "node:assert/strict";

import { relaxForStructuredOutput } from "../src/provider.ts";
import { ComposeRenderer } from "../src/providers/compose.ts";

test("structured-output projection removes unsupported conditional JSON Schema branches", () => {
  const original = {
    type: "object",
    required: ["kind"],
    properties: {
      kind: { type: "string" },
      value: { type: "string", minLength: 2 },
    },
    allOf: [
      {
        if: { properties: { kind: { const: "template" } }, required: ["kind"] },
        then: { required: ["value"] },
        else: { required: ["kind"] },
      },
    ],
  };

  const projected = relaxForStructuredOutput(original) as Record<string, unknown>;
  const encoded = JSON.stringify(projected);

  assert.doesNotMatch(encoded, /"if"|"then"|"else"/);
  assert.equal("allOf" in projected, false);
  assert.deepEqual(original.allOf[0]!.then, { required: ["value"] });
  assert.match(encoded, /at least 2 characters/);
});

test("thumbnail renderer retries without supplied artwork when compositor rejects it", async () => {
  const calls: Array<{ image_base64: string | null }> = [];
  const png = Buffer.from("fallback-thumb").toString("base64");
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { image_base64: string | null };
    calls.push(body);

    if (calls.length === 1) {
      return new Response(
        JSON.stringify({ success: false, error: "ffmpeg failed on supplied image" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        image_base64: png,
        media_type: "image/png",
        width: 1280,
        height: 720,
        background: "gradient",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const renderer = new ComposeRenderer({
    baseUrl: "http://compose.test",
    fetchImpl,
  });
  const result = await renderer.renderThumbnail({
    image: new Uint8Array([1, 2, 3]),
    text: "DON'T OPEN IT",
    emphasis: "OPEN IT",
    accent: "#FFD34D",
  });

  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]!.image_base64, null);
  assert.equal(calls[1]!.image_base64, null);
  assert.equal(result.background, "gradient");
  assert.equal(Buffer.from(result.bytes).toString(), "fallback-thumb");
});

test("thumbnail renderer does not retry when no artwork was supplied", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({ success: false, error: "drawtext unavailable" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const renderer = new ComposeRenderer({ baseUrl: "http://compose.test", fetchImpl });
  await assert.rejects(
    () => renderer.renderThumbnail({ text: "HOOK", accent: "#FFD34D" }),
    /drawtext unavailable/,
  );
  assert.equal(calls, 1);
});
