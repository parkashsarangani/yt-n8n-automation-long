import test from "node:test";
import assert from "node:assert/strict";

import { ComposeRenderer } from "../src/providers/compose.ts";

// Rewritten for RFC 0009 decision 11. This used to assert that the renderer
// ALWAYS sent "What should we explain next? Subscribe." -- a generic platform
// ask hardcoded as the default, which is precisely what decision 11 says to
// stop spending runtime on. There is no default any more: a continuation line
// is sent when one has been resolved, and nothing is sent when one has not.
test("no outro line is requested unless a continuation line was actually resolved", async () => {
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
  assert.equal("outro_line" in body, false, "no generic engagement CTA may be sent by default");
});

test("a resolved continuation line is passed through to the compositor", async () => {
  const seen: Record<string, unknown>[] = [];
  const fetchImpl2: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/compose") && init?.method === "POST") {
      seen.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ job_id: "job-1" }), { status: 200 });
    }
    if (url.endsWith("/compose-status/job-1")) {
      return new Response(JSON.stringify({ status: "done", success: true, output_path: "/app/outputs/out.mp4" }), { status: 200 });
    }
    if (url.endsWith("/outputs/out.mp4")) return new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 });
    return new Response("not found", { status: 404 });
  };

  const renderer2 = new ComposeRenderer({
    baseUrl: "http://compose.test",
    pollIntervalSec: 0,
    sleepImpl: async () => {},
    fetchImpl: fetchImpl2,
    outroLine: "But this was not the strangest time everyone underestimated the wrong person.",
  });

  await renderer2.render({ scenes: [{ scene_index: 0, audio: new Uint8Array([1]), audio_media_type: "audio/mpeg" }] });

  assert.match(String(seen[0]!.outro_line), /underestimated the wrong person/);
  assert.doesNotMatch(String(seen[0]!.outro_line), /subscribe|like and share/i);
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
  // Even with no real template content, is_outro must still reach
  // template_data -- compose.js's own duplicate-outro detection
  // (isOutroScene) looks for it there, not as a sibling field. Missing this
  // means compose.js never recognizes this as the real outro and appends a
  // second, generic fallback card after it.
  assert.equal((scene.template_data as Record<string, unknown>)?.is_outro, true);
});

test("a plain illustrated-story scene's template_data (camera_move) reaches the renderer", async () => {
  // Real regression, confirmed live (run_139b87a1): template_data used to be
  // nested inside the template_category conditional entirely, so a plain
  // illustrated scene (no template_category at all -- illustrated_scene_assets
  // never sets one) had its template_data silently dropped before the request
  // left engine. episode_director's camera_move never reached compose.js's
  // buildImageScene, which fell back to its scene-index-parity default for
  // every scene regardless of the director's actual per-scene choice.
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
        image: new Uint8Array([1, 2, 3]),
        image_media_type: "image/png",
        template_data: { camera_move: "pan-left" },
      } as never,
    ],
  });

  const scene = (submitted[0]!.data as Array<Record<string, unknown>>)[0]!;
  assert.equal(scene.visual_source, undefined, "a plain illustrated scene must not be mistaken for a template scene");
  assert.equal(scene.template_name, undefined);
  assert.deepEqual(scene.template_data, { camera_move: "pan-left" });
  assert.ok(Array.isArray(scene.images_base64), "the image itself must still reach the renderer");
});
