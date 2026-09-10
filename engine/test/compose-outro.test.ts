import test from "node:test";
import assert from "node:assert/strict";

import { ComposeRenderer } from "../src/providers/compose.ts";
import type { RenderRequest } from "../src/provider.ts";

type ContinuationRenderRequest = RenderRequest & { outro_line?: string };

function recordingFetch(submitted: Record<string, unknown>[]): typeof fetch {
  return async (input, init) => {
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
}

function rendererFor(submitted: Record<string, unknown>[]): ComposeRenderer {
  return new ComposeRenderer({
    baseUrl: "http://compose.test",
    pollIntervalSec: 0,
    sleepImpl: async () => {},
    fetchImpl: recordingFetch(submitted),
  });
}

const scene = { scene_index: 0, audio: new Uint8Array([1]), audio_media_type: "audio/mpeg" };

test("no outro line is requested unless a continuation line was resolved", async () => {
  const submitted: Record<string, unknown>[] = [];
  await rendererFor(submitted).render({ scenes: [scene] });
  assert.equal("outro_line" in submitted[0]!, false, "no generic engagement CTA may be sent by default");
});

test("a resolved continuation line is passed through per render request", async () => {
  const submitted: Record<string, unknown>[] = [];
  const request: ContinuationRenderRequest = {
    scenes: [scene],
    outro_line: "But this was not the strangest time everyone underestimated the wrong person.",
  };
  await rendererFor(submitted).render(request);

  assert.match(String(submitted[0]!.outro_line), /underestimated the wrong person/);
  assert.doesNotMatch(String(submitted[0]!.outro_line), /subscribe|like and share/i);
});

test("audio-first scene metadata forwards only the spoken outro marker", async () => {
  const submitted: Record<string, unknown>[] = [];
  await rendererFor(submitted).render({ scenes: [{ ...scene, is_outro: true }] });

  const renderedScene = (submitted[0]!.data as Array<Record<string, unknown>>)[0]!;
  assert.equal(renderedScene.is_outro, true);
  assert.equal("template_name" in renderedScene, false);
  assert.equal("template_data" in renderedScene, false);
  assert.equal("images_base64" in renderedScene, false);
});
