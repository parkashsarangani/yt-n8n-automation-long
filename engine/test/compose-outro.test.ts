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

test("a real spoken outro scene's own template content is not discarded for a blank kinetic-text card", async () => {
  // Real regression, confirmed live (run_41601d4a): scene.is_outro used to
  // unconditionally force template_name to "kinetic_text" and explicitly
  // exclude template_category whenever is_outro was true. Once
  // dialogue_script_writer started authoring a REAL is_outro scene with its
  // own template_category ("cartoon", via the character-room compiler
  // bypass) and real template_data (background/camera/characters), that
  // logic silently discarded it -- the scene rendered as an empty
  // "KineticText props keys: mood" card with no line, and compose.js's own
  // duplicate-outro detection (which looks for is_outro:true INSIDE
  // template_data) never recognized it as the real outro either, so it
  // injected a SECOND, generic fallback card after it.
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
    scenes: [
      {
        scene_index: 0,
        audio: new Uint8Array([1]),
        audio_media_type: "audio/mpeg",
        is_outro: true,
        template_category: "cartoon",
        template_data: { background: { location: "studio" }, characters: [{ characterId: "pilot", isSpeaking: true }] },
      } as never,
    ],
  });

  const scene = (submitted[0]!.data as Array<Record<string, unknown>>)[0]!;
  assert.equal(scene.template_name, "cartoon", "the real cartoon template must win, not kinetic_text");
  const templateData = scene.template_data as Record<string, unknown>;
  assert.equal(templateData.is_outro, true, "is_outro must be merged into template_data for compose.js's own duplicate-outro detection");
  assert.ok(templateData.background, "the real CartoonScene payload must survive, not be replaced with {}");
});

test("an outro scene with no real template content still falls back to kinetic_text", async () => {
  // The legacy path this function still needs: an is_outro scene from
  // before the real-scene feature existed (or a resumed pre-feature
  // artifact) has no template_category at all, and must still get the old
  // silent-card fallback rather than rendering nothing.
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
    scenes: [{ scene_index: 0, audio: new Uint8Array([1]), audio_media_type: "audio/mpeg", is_outro: true } as never],
  });

  const scene = (submitted[0]!.data as Array<Record<string, unknown>>)[0]!;
  assert.equal(scene.template_name, "kinetic_text");
});
