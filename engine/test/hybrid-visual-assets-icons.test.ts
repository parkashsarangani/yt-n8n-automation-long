import test from "node:test";
import assert from "node:assert/strict";

import { makeHybridVisualAssetsWorker } from "../src/workers/index.ts";

const ctx = { logger: { log() {}, warn() {}, error() {} }, media: {} };

function plan(scene_index: number, overrides: Record<string, unknown> = {}) {
  return {
    scene_index,
    scene_role: scene_index === 0 ? "character-hook" : "recap",
    visual_operation: scene_index === 0 ? "timeline" : "payoff",
    visual_primitive: "cause-chain",
    composition_mode: "bookend",
    model_elements: ["water molecule"],
    ...overrides,
  };
}

function scriptScene(scene_index: number) {
  return { scene_index, narration: "a short spoken beat", speaker: "host" };
}

function compiledScene(scene_index: number) {
  return {
    scene_index,
    source: "template" as const,
    template_category: "explanation",
    template_data: JSON.stringify({ role: "character-hook", visualOperation: "timeline", visualPrimitive: "cause-chain", compositionMode: "bookend" }),
  };
}

const cast = { payload: { characters: [{ character_id: "host", name: "Host" }] } };
const voice = { payload: { clips: [{ scene_index: 0, duration_sec: 3 }, { scene_index: 1, duration_sec: 3 }] } };

// Iconify's real shape: /search -> {icons: ["prefix:name", ...]}; then
// /<prefix>.json?icons=<name> -> {width, height, icons: {<name>: {body}}}.
function fakeIconifyFetch(): typeof fetch {
  return (async (url: string) => {
    if (url.includes("api.iconify.design/search")) {
      return { ok: true, json: async () => ({ icons: ["mdi:water"] }) } as Response;
    }
    if (url.includes("api.iconify.design/mdi.json")) {
      return { ok: true, json: async () => ({ width: 24, height: 24, icons: { water: { body: '<path fill="currentColor" d="M12 2 L4 14 L20 14 Z"/>' } } }) } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as typeof fetch;
}

test("a motion_graphic scene carries a resolved entity_icons entry when its entity matches a real icon", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeIconifyFetch();
  try {
    const worker = makeHybridVisualAssetsWorker();
    const out = await worker.execute(
      {
        compiled: { payload: { scenes: [compiledScene(0), compiledScene(1)], degraded_count: 0 } },
        plan: { payload: { scenes: [plan(0), plan(1)] } },
        script: { payload: { scenes: [scriptScene(0), scriptScene(1)] } },
        cast,
        voice,
      } as never,
      ctx as never,
    );
    const payload = out.payload as { scenes: Array<{ scene_index: number; entity_icons?: Array<{ entity_id: string; icon_id: string; view_box: string; body: string }>; template_data?: string }> };
    const opening = payload.scenes.find((scene) => scene.scene_index === 0)!;
    assert.ok(opening.entity_icons?.length, "expected the water-molecule entity to resolve an icon");
    assert.equal(opening.entity_icons![0]!.icon_id, "mdi:water");
    assert.equal(opening.entity_icons![0]!.view_box, "0 0 24 24");
    assert.match(opening.entity_icons![0]!.body, /<path/);
    // entity_visual_tokens (the hash-picked color/shape used for AI-image
    // prompt consistency) must still be present and unaffected -- entity_icons
    // is additive, not a replacement.
    assert.ok((opening as unknown as { entity_visual_tokens?: unknown[] }).entity_visual_tokens?.length);
    // The Remotion renderer only ever reads template_data (compose.js's
    // explanation.buildProps), never this top-level field directly -- the
    // real fix has to land inside template_data too, keyed the same way as
    // entityIdentityKeys, or the icon never reaches the rendered frame.
    const templateData = JSON.parse(opening.template_data!) as { entityIdentityKeys?: string[]; entityIcons?: Record<string, { viewBox: string; body: string }> };
    const entityId = templateData.entityIdentityKeys?.[0]!;
    assert.ok(entityId, "expected the water-molecule entity's identity key in template_data");
    assert.equal(templateData.entityIcons?.[entityId]?.viewBox, "0 0 24 24");
    assert.match(templateData.entityIcons?.[entityId]?.body ?? "", /<path/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a scene's entities are simply absent from entity_icons when icon search finds nothing, with no other change", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ icons: [] }) })) as unknown as typeof fetch;
  try {
    const worker = makeHybridVisualAssetsWorker();
    const out = await worker.execute(
      {
        compiled: { payload: { scenes: [compiledScene(0), compiledScene(1)], degraded_count: 0 } },
        plan: { payload: { scenes: [plan(0), plan(1)] } },
        script: { payload: { scenes: [scriptScene(0), scriptScene(1)] } },
        cast,
        voice,
      } as never,
      ctx as never,
    );
    const payload = out.payload as { scenes: Array<{ scene_index: number; entity_icons?: unknown[]; entity_visual_tokens?: unknown[] }> };
    const opening = payload.scenes.find((scene) => scene.scene_index === 0)!;
    assert.equal(opening.entity_icons, undefined, "no confident match must mean no entity_icons field at all, not an empty/broken one");
    assert.ok(opening.entity_visual_tokens?.length, "the existing shape/color assignment must still work exactly as before");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a network outage during icon search does not fail episode generation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("ENETUNREACH"); }) as unknown as typeof fetch;
  try {
    const worker = makeHybridVisualAssetsWorker();
    const out = await worker.execute(
      {
        compiled: { payload: { scenes: [compiledScene(0), compiledScene(1)], degraded_count: 0 } },
        plan: { payload: { scenes: [plan(0), plan(1)] } },
        script: { payload: { scenes: [scriptScene(0), scriptScene(1)] } },
        cast,
        voice,
      } as never,
      ctx as never,
    );
    const payload = out.payload as { scenes: Array<{ scene_index: number; entity_icons?: unknown[] }> };
    assert.equal(payload.scenes.length, 2, "the run must still complete a full asset manifest despite the icon service being unreachable");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
