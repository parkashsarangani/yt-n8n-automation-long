import test from "node:test";
import assert from "node:assert/strict";

import { ComposeRenderer } from "../src/providers/compose.ts";

test("long-compose requests a YouTube-native engagement outro instead of legacy follow copy", async () => {
  const submitted: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/compose") && init?.method === "POST") {
      submitted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ job_id: "job-1" }), { status: 200 });
    }
    if (url.endsWith("/compose-status/job-1")) {
      return new Response(JSON.stringify({ status: "done", success: true, output_path: "/app/outputs/out.mp4" }), { status: 200 });
    }
    if (url.endsWith("/outputs/out.mp4")) {
      return new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const renderer = new ComposeRenderer({
    baseUrl: "http://compose.test",
    pollIntervalSec: 0,
    sleepImpl: async () => {},
    fetchImpl,
  });

  await renderer.render({
    scenes: [{ scene_index: 0, audio: new Uint8Array([1]), audio_media_type: "audio/mpeg" }],
  });

  const body = submitted[0];
  assert.ok(body);
  assert.equal(body.outro_line, "What should we explain next? Subscribe.");
  assert.doesNotMatch(String(body.outro_line), /follow/i);
});
