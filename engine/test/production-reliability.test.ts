import test from "node:test";
import assert from "node:assert/strict";

import { FalImageProvider } from "../src/providers/fal.ts";
import { ComposeRenderer, type DiagnosticThumbnailResult } from "../src/providers/compose.ts";
import { makeThumbnailWorker } from "../src/workers/thumbnail.ts";
import { makeCartoonSceneCompilerWorker } from "../src/workers/cartoon-scenes.ts";

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

test("production thumbnail refuses fake image bytes before calling the real compositor", async () => {
  const worker = makeThumbnailWorker();
  let generated = false;
  let rendered = false;

  await assert.rejects(
    () => worker.execute(
      {
        brief: {
          payload: {
            mode: "cartoon",
            text: "CAN WE TALK?",
            art_prompt: "recurring cartoon host looking at a phone",
            accent: "#18A6A6",
            rationale: "recognizable situation",
          },
        } as never,
      },
      {
        media: {
          images: {
            id: "fake/image",
            async generate() {
              generated = true;
              return {
                images: [{ bytes: new Uint8Array(128), media_type: "image/png" }],
                usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, provider: "fake", model: "fake" },
              };
            },
          },
          renderer: {
            id: "long-compose",
            async renderThumbnail() {
              rendered = true;
              throw new Error("must not be called");
            },
            async render() { throw new Error("unused"); },
          },
        },
        progress: async () => {},
        logger: { log() {}, warn() {}, error() {} },
      } as never,
    ),
    /current image provider is fake\/image\. Set FAL_KEY before retrying/,
  );

  assert.equal(generated, false, "fake artwork generation must be stopped before it emits test bytes");
  assert.equal(rendered, false, "long-compose must never receive fake image bytes");
});

test("cartoon thumbnail worker rejects non-PNG provider output before it reaches ffmpeg", async () => {
  const worker = makeThumbnailWorker();
  let rendererCalled = false;
  await assert.rejects(
    () => worker.execute(
      {
        brief: {
          payload: {
            mode: "cartoon",
            text: "CAN WE TALK?",
            art_prompt: "recurring cartoon host looking at a phone",
            accent: "#18A6A6",
            rationale: "recognizable situation",
          },
        } as never,
      },
      {
        media: {
          images: {
            id: "fake-images",
            async generate() {
              return {
                images: [{ bytes: new Uint8Array([0xff, 0xd8, 0xff]), media_type: "image/jpeg" }],
                usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, provider: "fake", model: "fake" },
              };
            },
          },
          renderer: {
            id: "fake-renderer",
            async renderThumbnail() {
              rendererCalled = true;
              throw new Error("must not be called");
            },
            async render() { throw new Error("unused"); },
          },
        },
        progress: async () => {},
        logger: { log() {}, warn() {}, error() {} },
      } as never,
    ),
    /image provider returned image\/jpeg; cartoon thumbnail compositor requires image\/png/,
  );
  assert.equal(rendererCalled, false);
});

test("cartoon compiler preserves shallow shot direction across legacy speaker labels and bad variants", async () => {
  const worker = makeCartoonSceneCompilerWorker();
  const warnings: string[] = [];
  const out = await worker.execute(
    {
      plan: {
        payload: {
          scenes: [{
            scene_index: 0,
            template_category: "cartoon",
            background_location: "office",
            background_variant: "night",
            background_tone: "dramatic",
            framing: "speaker-closeup",
            camera_motion: "push-in",
            listener_actor_id: "buddy",
            speaker_emotion: "concerned",
            speaker_gesture: "idle",
            speaker_gaze_target: "auto",
            listener_emotion: "skeptical",
            listener_gesture: "idle",
            listener_gaze_target: "auto",
          }],
        },
      } as never,
      script: {
        payload: {
          scenes: [{
            scene_index: 0,
            narration: "My boss just sent can we talk.",
            speaker: "Host",
            emotion: "concerned",
          }],
        },
      } as never,
      cast: {
        payload: {
          characters: [
            { character_id: "host", name: "Host", rig: "pilot" },
            { character_id: "buddy", name: "Buddy", rig: "pilot-2" },
          ],
        },
      } as never,
    },
    {
      logger: { log() {}, warn(message: string) { warnings.push(message); }, error() {} },
    } as never,
  );

  const manifest = out.payload as { scenes: Array<{ template_data: string }> };
  const compiled = JSON.parse(manifest.scenes[0]!.template_data) as {
    background: { location: string; variant: string; tone: string };
    camera: { type: string; from?: number; to?: number };
    characters: Array<{ actorId: string; isSpeaking: boolean; scale: number }>;
  };

  assert.deepEqual(compiled.background, { location: "office", variant: "day", tone: "dramatic" });
  assert.deepEqual(compiled.camera, { type: "zoom", from: 1, to: 1.1 });
  assert.equal(compiled.characters.length, 1);
  assert.equal(compiled.characters[0]?.actorId, "host");
  assert.equal(compiled.characters[0]?.isSpeaking, true);
  assert.equal(compiled.characters[0]?.scale, 1.55);
  assert.ok(warnings.some((line) => line.includes("office/night") && line.includes("office/day")));
  assert.ok(warnings.some((line) => line.includes('resolved legacy speaker label "Host" to cast id "host"')));
  assert.equal(warnings.some((line) => line.includes("synthesizing deterministic staging")), false);
});
