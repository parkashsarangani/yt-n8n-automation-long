import test from "node:test";
import assert from "node:assert/strict";

import { makeHybridVisualAssetsWorker } from "../src/workers/index.ts";

let blobSeq = 0;
const blobs = { async put(bytes: Uint8Array, opts: { role: string; media_type: string }) { blobSeq++; return { uri: `blob://sha256:${"0".repeat(63)}${blobSeq}`, role: opts.role, media_type: opts.media_type }; } };
const ctx = { logger: { log() {}, warn() {}, error() {} }, media: {}, blobs };

function plan(scene_index: number, overrides: Record<string, unknown> = {}) {
  return {
    scene_index,
    scene_role: scene_index === 0 ? "character-hook" : "recap",
    visual_operation: scene_index === 0 ? "timeline" : "payoff",
    visual_primitive: "cause-chain",
    composition_mode: "bookend",
    model_elements: ["knife"],
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

// validateGenerated() rejects anything under 12,000 bytes as "suspiciously
// small" (a real, pre-existing guard against a truncated/placeholder image)
// -- pad well past that so these tests exercise the QA path, not that guard.
function fakeImage(tag: string) {
  const bytes = new Uint8Array(12_500).fill(tag.charCodeAt(0));
  return { bytes, media_type: "image/png" };
}

// Iconify's search returns no results for anything not mocked, so these
// tests don't accidentally depend on the icon feature -- only the image-QA
// path is under test here.
function fakeIconifyFetch(): typeof fetch {
  return (async () => ({ ok: true, json: async () => ({ icons: [] }) })) as unknown as typeof fetch;
}

test("a clean generated image is used as-is, no retry", async () => {
  const originalFetch = globalThis.fetch;
  process.env["OPENAI_API_KEY"] = "test-key";
  let generateCalls = 0;
  globalThis.fetch = ((url: string) => {
    if (String(url).includes("api.iconify.design")) return fakeIconifyFetch()(url as never);
    // vision QA call: always clean
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ has_visible_text: false, reason: "clean" }) } }] }) } as never);
  }) as typeof fetch;
  try {
    const provider = {
      id: "test-provider",
      async generate() { throw new Error("generate() should not be called when generatePack exists"); },
      async generatePack() { generateCalls++; return { images: [fakeImage("A")] }; },
    };
    const worker = makeHybridVisualAssetsWorker();
    const out = await worker.execute(
      {
        compiled: { payload: { scenes: [compiledScene(0), compiledScene(1)], degraded_count: 0 } },
        plan: { payload: { scenes: [plan(0), plan(1)] } },
        script: { payload: { scenes: [scriptScene(0), scriptScene(1)] } },
        cast,
        voice,
      } as never,
      { ...ctx, media: { images: provider } } as never,
    );
    const payload = out.payload as { scenes: Array<{ scene_index: number; visual_mode?: string }> };
    assert.equal(payload.scenes.find((s) => s.scene_index === 0)!.visual_mode, "ai_broll");
    assert.equal(generateCalls, 1, "a clean first attempt must not trigger a retry");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env["OPENAI_API_KEY"];
  }
});

test("an image flagged for visible text is regenerated once, and the clean retry is used", async () => {
  const originalFetch = globalThis.fetch;
  process.env["OPENAI_API_KEY"] = "test-key";
  let qaCalls = 0;
  globalThis.fetch = ((url: string) => {
    if (String(url).includes("api.iconify.design")) return fakeIconifyFetch()(url as never);
    qaCalls++;
    const flagged = qaCalls === 1; // first QA call (attempt 1) flags it, second (attempt 2) is clean
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ has_visible_text: flagged, reason: flagged ? "engraved lettering" : "clean" }) } }] }) } as never);
  }) as typeof fetch;
  try {
    let generateCalls = 0;
    const provider = {
      id: "test-provider",
      async generate() { throw new Error("unused"); },
      async generatePack() { generateCalls++; return { images: [fakeImage(generateCalls === 1 ? "A" : "B")] }; },
    };
    const worker = makeHybridVisualAssetsWorker();
    const out = await worker.execute(
      {
        compiled: { payload: { scenes: [compiledScene(0), compiledScene(1)], degraded_count: 0 } },
        plan: { payload: { scenes: [plan(0), plan(1)] } },
        script: { payload: { scenes: [scriptScene(0), scriptScene(1)] } },
        cast,
        voice,
      } as never,
      { ...ctx, media: { images: provider } } as never,
    );
    const payload = out.payload as { scenes: Array<{ scene_index: number; visual_mode?: string }> };
    assert.equal(payload.scenes.find((s) => s.scene_index === 0)!.visual_mode, "ai_broll", "the clean retry must still be accepted as ai_broll, not fall back");
    assert.equal(generateCalls, 2, "exactly one retry, not more");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env["OPENAI_API_KEY"];
  }
});

test("an image flagged on both attempts falls back to the deterministic motion graphic, never ships the flagged image", async () => {
  const originalFetch = globalThis.fetch;
  process.env["OPENAI_API_KEY"] = "test-key";
  globalThis.fetch = ((url: string) => {
    if (String(url).includes("api.iconify.design")) return fakeIconifyFetch()(url as never);
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ has_visible_text: true, reason: "logo on packaging" }) } }] }) } as never);
  }) as typeof fetch;
  try {
    let generateCalls = 0;
    const provider = {
      id: "test-provider",
      async generate() { throw new Error("unused"); },
      async generatePack() { generateCalls++; return { images: [fakeImage("A")] }; },
    };
    const worker = makeHybridVisualAssetsWorker();
    const out = await worker.execute(
      {
        compiled: { payload: { scenes: [compiledScene(0), compiledScene(1)], degraded_count: 0 } },
        plan: { payload: { scenes: [plan(0), plan(1)] } },
        script: { payload: { scenes: [scriptScene(0), scriptScene(1)] } },
        cast,
        voice,
      } as never,
      { ...ctx, media: { images: provider } } as never,
    );
    const payload = out.payload as { scenes: Array<{ scene_index: number; visual_mode?: string; source: string }> };
    const opening = payload.scenes.find((s) => s.scene_index === 0)!;
    assert.equal(opening.visual_mode, "motion_graphic", "a still-flagged image after retry must fall back, not ship");
    assert.equal(generateCalls, 2, "exactly one retry before giving up");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env["OPENAI_API_KEY"];
  }
});

test("when no OPENAI_API_KEY is configured, the QA check passes through silently and the image ships", async () => {
  const originalFetch = globalThis.fetch;
  delete process.env["OPENAI_API_KEY"];
  globalThis.fetch = fakeIconifyFetch();
  try {
    let generateCalls = 0;
    const provider = {
      id: "test-provider",
      async generate() { throw new Error("unused"); },
      async generatePack() { generateCalls++; return { images: [fakeImage("A")] }; },
    };
    const worker = makeHybridVisualAssetsWorker();
    const out = await worker.execute(
      {
        compiled: { payload: { scenes: [compiledScene(0), compiledScene(1)], degraded_count: 0 } },
        plan: { payload: { scenes: [plan(0), plan(1)] } },
        script: { payload: { scenes: [scriptScene(0), scriptScene(1)] } },
        cast,
        voice,
      } as never,
      { ...ctx, media: { images: provider } } as never,
    );
    const payload = out.payload as { scenes: Array<{ scene_index: number; visual_mode?: string }> };
    assert.equal(payload.scenes.find((s) => s.scene_index === 0)!.visual_mode, "ai_broll");
    assert.equal(generateCalls, 1, "no API key must never trigger a retry loop");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- semantic (narration-contradiction) path -------------------------------

// Routes the two QA questions to different answers by inspecting the prompt
// text the module actually sends, so a test can make the TEXT check clean
// while the SEMANTIC check flags -- proving the semantic path alone can
// drive regeneration/fallback, not just riding on the text check.
function fetchByQaKind(opts: { text?: boolean; semantic?: boolean | ((call: number) => boolean) }): typeof fetch {
  let semanticCalls = 0;
  return ((url: string, init?: { body?: string }) => {
    if (String(url).includes("api.iconify.design")) return Promise.resolve({ ok: true, json: async () => ({ icons: [] }) } as never);
    const body = init?.body ?? "";
    const isSemantic = body.includes("contradicts_narration");
    let flagged: boolean;
    if (isSemantic) {
      semanticCalls++;
      flagged = typeof opts.semantic === "function" ? opts.semantic(semanticCalls) : Boolean(opts.semantic);
      return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ contradicts_narration: flagged, reason: flagged ? "beam points into the eyes" : "fine" }) } }] }) } as never);
    }
    flagged = Boolean(opts.text);
    return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ has_visible_text: flagged, reason: flagged ? "lettering" : "clean" }) } }] }) } as never);
  }) as typeof fetch;
}

async function runWorker(provider: unknown) {
  const worker = makeHybridVisualAssetsWorker();
  return worker.execute(
    {
      compiled: { payload: { scenes: [compiledScene(0), compiledScene(1)], degraded_count: 0 } },
      plan: { payload: { scenes: [plan(0), plan(1)] } },
      script: { payload: { scenes: [scriptScene(0), scriptScene(1)] } },
      cast,
      voice,
    } as never,
    { ...ctx, media: { images: provider } } as never,
  );
}

test("an image that contradicts its narration is regenerated even when it carries no text", async () => {
  const originalFetch = globalThis.fetch;
  process.env["OPENAI_API_KEY"] = "test-key";
  // Text check always clean; semantic check flags only the first attempt.
  globalThis.fetch = fetchByQaKind({ text: false, semantic: (call) => call === 1 });
  try {
    let generateCalls = 0;
    const provider = { id: "test-provider", async generate() { throw new Error("unused"); }, async generatePack() { generateCalls++; return { images: [fakeImage("A")] }; } };
    const out = await runWorker(provider);
    const payload = out.payload as { scenes: Array<{ scene_index: number; visual_mode?: string }> };
    assert.equal(payload.scenes.find((s) => s.scene_index === 0)!.visual_mode, "ai_broll", "the clean retry must be accepted");
    assert.equal(generateCalls, 2, "the semantic flag alone must trigger exactly one regeneration");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env["OPENAI_API_KEY"];
  }
});

test("an image contradicting its narration on both attempts falls back to the motion graphic", async () => {
  const originalFetch = globalThis.fetch;
  process.env["OPENAI_API_KEY"] = "test-key";
  globalThis.fetch = fetchByQaKind({ text: false, semantic: true });
  try {
    let generateCalls = 0;
    const provider = { id: "test-provider", async generate() { throw new Error("unused"); }, async generatePack() { generateCalls++; return { images: [fakeImage("A")] }; } };
    const out = await runWorker(provider);
    const payload = out.payload as { scenes: Array<{ scene_index: number; visual_mode?: string }> };
    assert.equal(payload.scenes.find((s) => s.scene_index === 0)!.visual_mode, "motion_graphic", "a persistently contradictory image must never ship");
    assert.equal(generateCalls, 2, "exactly one retry before giving up");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env["OPENAI_API_KEY"];
  }
});

test("a semantically-fine image still ships when both checks pass", async () => {
  const originalFetch = globalThis.fetch;
  process.env["OPENAI_API_KEY"] = "test-key";
  globalThis.fetch = fetchByQaKind({ text: false, semantic: false });
  try {
    let generateCalls = 0;
    const provider = { id: "test-provider", async generate() { throw new Error("unused"); }, async generatePack() { generateCalls++; return { images: [fakeImage("A")] }; } };
    const out = await runWorker(provider);
    const payload = out.payload as { scenes: Array<{ scene_index: number; visual_mode?: string }> };
    assert.equal(payload.scenes.find((s) => s.scene_index === 0)!.visual_mode, "ai_broll");
    assert.equal(generateCalls, 1, "no retry when nothing is flagged");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env["OPENAI_API_KEY"];
  }
});
