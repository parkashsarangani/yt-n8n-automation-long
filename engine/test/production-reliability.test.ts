import test from "node:test";
import assert from "node:assert/strict";

import { FalImageProvider } from "../src/providers/fal.ts";
import { ComposeRenderer, type DiagnosticThumbnailResult } from "../src/providers/compose.ts";

test("Fal image generation explicitly requests PNG for long-compose compatibility", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("fal.run")) {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ images: [{ url: "https://images.example/thumb.png", content_type: "image/png" }] }),
        { status: 200 },
      );
    }
    if (url === "https://images.example/thumb.png") {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const provider = new FalImageProvider({ apiKey: "test", fetchImpl });
  const result = await provider.generate({ prompt: "cartoon host", aspect: "16:9", count: 1 });

  assert.equal(requestBody?.["output_format"], "png");
  assert.equal(result.images[0]?.media_type, "image/png");
});

test("ComposeRenderer returns the real supplied-artwork failure when gradient recovery succeeds", async () => {
  const ffmpegTail = "[png] Invalid PNG signature 0x76396DA0C40186BE";
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { image_base64: string | null };
    if (body.image_base64) {
      const error = `Command failed: /usr/bin/ffmpeg ${"drawbox=x=0,".repeat(180)}\n${ffmpegTail}`;
      return new Response(JSON.stringify({ success: false, error }), { status: 500 });
    }
    return new Response(
      JSON.stringify({
        success: true,
        image_base64: "AAAA",
        media_type: "image/png",
        width: 1280,
        height: 720,
        background: "gradient",
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const renderer = new ComposeRenderer({ baseUrl: "https://compose.example", fetchImpl });
  const result = await renderer.renderThumbnail({ image: new Uint8Array([1, 2, 3]), text: "CAN WE TALK?" }) as DiagnosticThumbnailResult;

  assert.equal(result.background, "gradient");
  assert.match(result.degradation_reason ?? "", /Invalid PNG signature/);
});
