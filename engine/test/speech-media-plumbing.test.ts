import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ComposeRenderer } from "../src/providers/compose.ts";

test("voice and render workers persist and consume the provider media type", async () => {
  const [voice, render] = await Promise.all([
    readFile(new URL("../src/workers/voice.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/workers/render.ts", import.meta.url), "utf8"),
  ]);
  assert.match(voice, /media_type:\s*result\.media_type/);
  assert.match(render, /audio_media_type:\s*clip\.media_type\?\.trim\(\)\s*\|\|\s*"audio\/mpeg"/);
});

test("ComposeRenderer forwards WAV media type to long-compose", async () => {
  let composeBody: any;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/compose")) {
      composeBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ job_id: "job-1" }), { status: 200 });
    }
    if (url.endsWith("/compose-status/job-1")) {
      return new Response(JSON.stringify({ status: "done", success: true, output_path: "/outputs/out.mp4" }), { status: 200 });
    }
    if (url.endsWith("/outputs/out.mp4")) {
      return new Response(Uint8Array.from([1, 2, 3]), { status: 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const renderer = new ComposeRenderer({
    baseUrl: "http://compose",
    pollIntervalSec: 0,
    timeoutSec: 1,
    fetchImpl,
    sleepImpl: async () => {},
  });
  await renderer.render({
    scenes: [{ scene_index: 0, audio: Uint8Array.from([82, 73, 70, 70]), audio_media_type: "audio/wav" }],
  });
  assert.equal(composeBody.data[0].audio.media_type, "audio/wav");
});
