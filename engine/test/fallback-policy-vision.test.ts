// Opt-in REAL (pixel-inspecting) vision path. Exercises the free-first vision
// QA policy: metadata screen -> canary-gated free VLM chain -> paid OpenAI
// vision only when PAID_VISION_FALLBACK is enabled, else QA_UNAVAILABLE.
process.env["VISUAL_QA_MODE"] = "real";

import test from "node:test";
import assert from "node:assert/strict";

import { scoreVisualBeatFrames, scoreVisualBeatImage, type VisualBeatFetch } from "../src/visual-beat-qa.ts";
import { resetVisionCapability } from "../src/vision-capability.ts";
import type { VisualBeat } from "../src/visual-routing.ts";

const frame = { bytes: new Uint8Array([1, 2, 3]), media_type: "image/jpeg" };

const ENV_KEYS = [
  "VISUAL_QA_MODE", "FREELLMAPI_API_KEY", "FREELLMAPI_BASE_URL", "FREE_VISION_MODELS",
  "PAID_VISION_FALLBACK", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_IMAGE_QA_MODEL",
] as const;

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  resetVisionCapability();
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env["VISUAL_QA_MODE"] = "real";
    for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
    return await run();
  } finally {
    for (const k of ENV_KEYS) {
      const v = previous[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetVisionCapability();
  }
}

function beat(): VisualBeat {
  return {
    id: "beat_001", scene_index: 0, beat_index: 0, start_sec: 0, end_sec: 4,
    narration: "The commuter taps send while walking toward the platform.",
    context: { previous: "", next: "The message arrives first." },
    intent: { purpose: "ESTABLISH", information: "x", emotion: "curiosity", importance: 0.8 },
    visual_contract: {
      required: ["one identifiable commuter", "phone visible in hand"],
      forbidden: ["generic station crowd"],
      required_action: "the same commuter visibly taps send while walking",
      viewer_takeaway: "the message leaves while the commuter is still moving",
    },
    routing: { preferred: "generated_image", fallback: "stock_video", image_style: "realistic" },
    continuity: { group: "commuter", entities: ["commuter_a"] },
    retention: { novelty_required: false, visual_change_strength: 0.4, composition: "medium_action", camera_treatment: "tracking", subject_placement: "left_third", explanatory_pattern: "action" },
    asset_brief: {
      query: "commuter walking station phone", query_variants: ["commuter walking station phone"],
      generation_prompt: "same commuter walking through station with phone",
      generation_variants: ["same commuter walking through station with phone"],
      generated_video_prompt: "same commuter walks and taps send", motion_graphic_brief: "",
    },
  };
}

const QA_PAYLOAD = {
  semantic_match: 0.97, action_match: 0.92, visual_interest: 0.86, continuity: 0.93,
  generic_filler: false, why_failure: false, repetitive_with_context: false,
  requirements_visible: true, action_evidence: true, identity_continuity_evidence: true,
  composition_failure: false, garbled_text: false, implausible_object_scale: false, environment_mismatch: false,
  reason: "The required commuter, phone and send action are visibly present.",
};

function isCanary(body: string): boolean {
  return body.includes("Read the four black digits") || body.includes('"saw_image"');
}

/** A fake endpoint fleet keyed by whether the canary should pass for a model. */
function fleet(opts: { canaryPass: (model: string) => boolean; onQa: (url: string, model: string) => void }) {
  const impl: VisualBeatFetch = async (url, init) => {
    const body = String(init.body);
    const model = (JSON.parse(body) as { model?: string }).model ?? "";
    if (isCanary(body)) {
      const pass = opts.canaryPass(model);
      return {
        ok: true, status: 200,
        async json() { return { choices: [{ message: { content: JSON.stringify({ number: pass ? "7391" : "0000", saw_image: pass }) } }] }; },
      };
    }
    opts.onQa(String(url), model);
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: JSON.stringify(QA_PAYLOAD) } }] }; } };
  };
  return impl;
}

// --- §15 tests 6-10 --------------------------------------------------------

test("vision 6: the metadata pre-filter is not a pixel verification", async () => {
  // In proxy mode (VISUAL_QA_MODE unset) the screen never sets vision-only
  // evidence and tags itself metadata_proxy.
  const prev = process.env["VISUAL_QA_MODE"];
  delete process.env["VISUAL_QA_MODE"];
  try {
    const stub = {
      id: "stub",
      capabilities: () => ({ structuredOutput: "native" as const, maxOutputTokens: 8192 }),
      complete: async () => ({
        value: { accept: true, reason: "prompt targets the subject", concern: "none", confidence: { overall: 0.7 } },
        usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, provider: "freellmapi", model: "m" },
        providerRef: "freellmapi/m",
      }),
    };
    const r = await scoreVisualBeatImage(frame, beat(), undefined as never, { proxyProvider: stub });
    assert.ok(r);
    assert.equal(r.source, "metadata_proxy");
    assert.equal(r.requirements_visible, undefined);
    assert.equal(r.action_evidence, undefined);
    assert.equal(r.identity_continuity_evidence, undefined);
  } finally {
    if (prev === undefined) delete process.env["VISUAL_QA_MODE"]; else process.env["VISUAL_QA_MODE"] = prev;
  }
});

test("vision 7: a free VLM that passes the canary is used; paid OpenAI vision is NOT called", async () => {
  await withEnv({
    FREELLMAPI_API_KEY: "free-k", FREELLMAPI_BASE_URL: "http://free/v1",
    FREE_VISION_MODELS: "free-vlm-a,free-vlm-b",
    PAID_VISION_FALLBACK: "true", OPENAI_API_KEY: "sk-paid", OPENAI_BASE_URL: "https://api.openai.test/v1",
  }, async () => {
    const qa: Array<{ url: string; model: string }> = [];
    const impl = fleet({ canaryPass: () => true, onQa: (url, model) => qa.push({ url, model }) });
    const r = await scoreVisualBeatFrames([frame], beat(), {}, impl);
    assert.ok(r);
    assert.equal(qa.length, 1);
    assert.equal(qa[0]!.model, "free-vlm-a");
    assert.ok(qa[0]!.url.startsWith("http://free"), "scored on the free host");
    assert.ok(!qa.some((c) => c.url.includes("openai.test")), "paid OpenAI vision never called");
  });
});

test("vision 8: a free VLM that fails the canary is skipped and the next free VLM is attempted", async () => {
  await withEnv({
    FREELLMAPI_API_KEY: "free-k", FREELLMAPI_BASE_URL: "http://free/v1",
    FREE_VISION_MODELS: "free-vlm-a,free-vlm-b",
    PAID_VISION_FALLBACK: "true", OPENAI_API_KEY: "sk-paid", OPENAI_BASE_URL: "https://api.openai.test/v1",
  }, async () => {
    const qa: Array<{ url: string; model: string }> = [];
    const impl = fleet({ canaryPass: (m) => m === "free-vlm-b", onQa: (url, model) => qa.push({ url, model }) });
    const r = await scoreVisualBeatFrames([frame], beat(), {}, impl);
    assert.ok(r);
    assert.equal(qa.length, 1);
    assert.equal(qa[0]!.model, "free-vlm-b", "skipped the canary-failing model, used the next one");
    assert.ok(!qa.some((c) => c.url.includes("openai.test")));
  });
});

test("vision 9: all free VLMs fail the canary -> paid OpenAI vision IS called when PAID_VISION_FALLBACK=true", async () => {
  await withEnv({
    FREELLMAPI_API_KEY: "free-k", FREELLMAPI_BASE_URL: "http://free/v1",
    FREE_VISION_MODELS: "free-vlm-a,free-vlm-b",
    PAID_VISION_FALLBACK: "true", OPENAI_API_KEY: "sk-paid", OPENAI_BASE_URL: "https://api.openai.test/v1", OPENAI_IMAGE_QA_MODEL: "paid-vision",
  }, async () => {
    const qa: Array<{ url: string; model: string }> = [];
    const impl = fleet({ canaryPass: () => false, onQa: (url, model) => qa.push({ url, model }) });
    const r = await scoreVisualBeatFrames([frame], beat(), {}, impl);
    assert.ok(r);
    assert.equal(qa.length, 1);
    assert.equal(qa[0]!.model, "paid-vision");
    assert.ok(qa[0]!.url.startsWith("https://api.openai.test"));
  });
});

test("vision 10: all free VLMs fail the canary -> QA_UNAVAILABLE (null) when PAID_VISION_FALLBACK=false, no fabricated scores", async () => {
  await withEnv({
    FREELLMAPI_API_KEY: "free-k", FREELLMAPI_BASE_URL: "http://free/v1",
    FREE_VISION_MODELS: "free-vlm-a",
    PAID_VISION_FALLBACK: "false", OPENAI_API_KEY: "sk-paid", OPENAI_BASE_URL: "https://api.openai.test/v1",
  }, async () => {
    const qa: string[] = [];
    const impl = fleet({ canaryPass: () => false, onQa: (url) => qa.push(url) });
    const r = await scoreVisualBeatFrames([frame], beat(), {}, impl);
    assert.equal(r, null, "no QA result rather than fabricated scores");
    assert.equal(qa.length, 0, "no QA request of any kind");
  });
});

test("vision: with no FREE_VISION_MODELS the metadata screen falls straight to paid vision when enabled", async () => {
  await withEnv({
    PAID_VISION_FALLBACK: "true", OPENAI_API_KEY: "sk-paid", OPENAI_BASE_URL: "https://api.openai.test/v1", OPENAI_IMAGE_QA_MODEL: "paid-vision",
  }, async () => {
    const qa: Array<{ url: string; model: string }> = [];
    const impl = fleet({ canaryPass: () => true, onQa: (url, model) => qa.push({ url, model }) });
    const r = await scoreVisualBeatFrames([frame], beat(), {}, impl);
    assert.ok(r);
    assert.equal(qa.length, 1);
    assert.equal(qa[0]!.model, "paid-vision");
  });
});
