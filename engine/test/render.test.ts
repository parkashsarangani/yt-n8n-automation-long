import test from "node:test";
import assert from "node:assert/strict";
import { ComposeRenderer } from "../src/providers/compose.ts";

test("ComposeRenderer submits audio-only scenes and returns the completed MP4", async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.endsWith("/compose")) return new Response(JSON.stringify({ job_id: "job-1" }), { status: 200 });
    if (url.endsWith("/compose-status/job-1")) {
      return new Response(JSON.stringify({ status: "done", success: true, output_path: "/outputs/final.mp4", duration_sec: 12 }), { status: 200 });
    }
    if (url.endsWith("/outputs/final.mp4")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  const renderer = new ComposeRenderer({ baseUrl: "http://compose", fetchImpl, pollIntervalSec: 0, sleepImpl: async () => {} });
  let jobId = "";
  const result = await renderer.render({
    caption_style: "neutral",
    scenes: [{ scene_index: 0, audio: new Uint8Array([7]), audio_media_type: "audio/mpeg", alignment: { words: [] } }],
  }, { onJob: (id) => { jobId = id; } });

  assert.equal(jobId, "job-1");
  assert.equal(result.media_type, "video/mp4");
  assert.deepEqual([...result.video], [1, 2, 3]);
  const submitted = requests[0]!.body as { data: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(submitted.data[0]!).sort(), ["audio", "scene_index"]);
});

test("ComposeRenderer surfaces the compositor failure", async () => {
  const fetchImpl: typeof fetch = async (input) =>
    String(input).endsWith("/compose")
      ? new Response(JSON.stringify({ job_id: "job-2" }), { status: 200 })
      : new Response(JSON.stringify({ status: "failed", success: false, error: "encoder died" }), { status: 200 });
  const renderer = new ComposeRenderer({ baseUrl: "http://compose", fetchImpl, pollIntervalSec: 0, sleepImpl: async () => {} });
  await assert.rejects(
    renderer.render({ scenes: [{ scene_index: 0, audio: new Uint8Array([1]), audio_media_type: "audio/mpeg" }] }),
    /encoder died/,
  );
});

test("ComposeRenderer forwards typed visual beats and compositor degradation", async () => {
  let submitted: any;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/compose")) {
      submitted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ job_id: "job-visual" }), { status: 200 });
    }
    if (url.endsWith("/compose-status/job-visual")) {
      return new Response(JSON.stringify({ status: "done", success: true, output_path: "/outputs/visual.mp4", degraded_scenes: 1 }), { status: 200 });
    }
    if (url.endsWith("/outputs/visual.mp4")) return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  const renderer = new ComposeRenderer({ baseUrl: "http://compose", fetchImpl, pollIntervalSec: 0, sleepImpl: async () => {} });
  const result = await renderer.render({
    scenes: [{
      scene_index: 0,
      audio: new Uint8Array([7]),
      audio_media_type: "audio/mpeg",
      visual: {
        kind: "comparison",
        viewer_understands: "See the deliberate next move.",
        scene_reference: "A colleague interrupts.",
        overlay: { left_label: "MOMENT", left_text: "Interrupted", right_label: "NEXT", right_text: "Pause first" },
        image: new Uint8Array([8, 9]),
      },
    }],
  });

  assert.equal(result.degraded_scenes, 1);
  assert.equal(submitted.data[0].visual.kind, "comparison");
  assert.equal(submitted.data[0].visual.image_base64, Buffer.from([8, 9]).toString("base64"));
  assert.equal(submitted.data[0].visual.overlay.right_text, "Pause first");
});
