import test from "node:test";
import assert from "node:assert/strict";
import { scoreVisualBeatFrames, type VisualBeatFetch } from "../src/visual-beat-qa.ts";
import type { VisualBeat } from "../src/visual-routing.ts";

const frame = { bytes: new Uint8Array([1, 2, 3]), media_type: "image/jpeg" };

function beat(): VisualBeat {
  return {
    id: "beat_001",
    scene_index: 0,
    beat_index: 0,
    start_sec: 0,
    end_sec: 4,
    narration: "The commuter taps send while walking toward the platform.",
    context: { previous: "", next: "The message arrives first." },
    intent: { purpose: "ESTABLISH", information: "message outruns commuter", emotion: "curiosity", importance: 0.8 },
    visual_contract: {
      required: ["one identifiable commuter", "phone visible in the commuter's hand"],
      forbidden: ["generic station crowd with no identifiable protagonist"],
      required_action: "the same commuter visibly taps or sends a message while continuing to walk",
      viewer_takeaway: "the message leaves while the commuter is still moving",
    },
    routing: { preferred: "generated_image", fallback: "stock_video", image_style: "realistic" },
    continuity: { group: "modern_commuter", entities: ["commuter_a"] },
    retention: {
      novelty_required: false,
      visual_change_strength: 0.4,
      composition: "medium_action",
      camera_treatment: "tracking",
      subject_placement: "left_third",
      explanatory_pattern: "action",
    },
    asset_brief: {
      query: "commuter walking station phone",
      query_variants: ["commuter walking station phone"],
      generation_prompt: "same commuter walking through station with phone",
      generation_variants: ["same commuter walking through station with phone"],
      generated_video_prompt: "same commuter walks and taps send",
      motion_graphic_brief: "",
    },
  };
}

const qaPayload = {
  semantic_match: 0.97,
  action_match: 0.92,
  visual_interest: 0.86,
  continuity: 0.93,
  generic_filler: false,
  why_failure: false,
  repetitive_with_context: false,
  requirements_visible: true,
  action_evidence: true,
  identity_continuity_evidence: true,
  composition_failure: false,
  garbled_text: false,
  implausible_object_scale: false,
  environment_mismatch: false,
  reason: "The required commuter, phone and send action are visibly present.",
};

test("RFC0010 visual QA bypasses FreeLLMAPI even when text routing is free-first", async () => {
  const previous = {
    routerMode: process.env["LLM_ROUTER_MODE"],
    freeKey: process.env["FREELLMAPI_API_KEY"],
    freeBase: process.env["FREELLMAPI_BASE_URL"],
    freeVision: process.env["FREELLMAPI_VISION_MODEL"],
    openAiKey: process.env["OPENAI_API_KEY"],
    openAiBase: process.env["OPENAI_BASE_URL"],
    openAiImageQaModel: process.env["OPENAI_IMAGE_QA_MODEL"],
  };

  process.env["LLM_ROUTER_MODE"] = "freellmapi";
  process.env["FREELLMAPI_API_KEY"] = "free-test-key";
  process.env["FREELLMAPI_BASE_URL"] = "http://freellmapi.invalid/v1";
  process.env["FREELLMAPI_VISION_MODEL"] = "auto:smart";
  process.env["OPENAI_API_KEY"] = "openai-test-key";
  process.env["OPENAI_BASE_URL"] = "https://api.openai.test/v1";
  process.env["OPENAI_IMAGE_QA_MODEL"] = "vision-test-model";

  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl: VisualBeatFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: JSON.stringify(qaPayload) } }] };
      },
    };
  };

  try {
    const result = await scoreVisualBeatFrames([frame], beat(), {}, fetchImpl);
    assert.ok(result);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.openai.test/v1/chat/completions");
    assert.equal(calls[0]!.body["model"], "vision-test-model");
    assert.ok(!calls[0]!.url.includes("freellmapi"));
  } finally {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("LLM_ROUTER_MODE", previous.routerMode);
    restore("FREELLMAPI_API_KEY", previous.freeKey);
    restore("FREELLMAPI_BASE_URL", previous.freeBase);
    restore("FREELLMAPI_VISION_MODEL", previous.freeVision);
    restore("OPENAI_API_KEY", previous.openAiKey);
    restore("OPENAI_BASE_URL", previous.openAiBase);
    restore("OPENAI_IMAGE_QA_MODEL", previous.openAiImageQaModel);
  }
});
