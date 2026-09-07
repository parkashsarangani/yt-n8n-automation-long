import test from "node:test";
import assert from "node:assert/strict";

import { metadataSemanticGate } from "../src/metadata-semantic-gate.ts";
import { scoreVisualBeatImage } from "../src/visual-beat-qa.ts";
import type { CompletionRequest, CompletionResult, ModelProvider } from "../src/provider.ts";
import type { VisualBeat } from "../src/visual-routing.ts";

// A stub free-text-model provider: records the prompt, returns a canned verdict.
function stubProvider(verdict: Record<string, unknown> | Error): ModelProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    id: "stub/free",
    capabilities: () => ({ structuredOutput: "native", maxOutputTokens: 4096 }),
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      prompts.push(req.prompt);
      if (verdict instanceof Error) throw verdict;
      return { value: verdict, usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0, provider: "freellmapi", model: "stub" }, providerRef: "freellmapi/stub" };
    },
  };
}

const accept = { accept: true, reason: "the prompt targets the beat's subject and action", concern: "none", confidence: { overall: 0.82 } };
const reject = { accept: false, reason: "the query is a generic city crowd unrelated to the send action", concern: "generic_filler", confidence: { overall: 0.7 } };

test("the proxy prompt is metadata-only and never asks the model to look at an image", async () => {
  const provider = stubProvider(accept);
  await metadataSemanticGate({
    narration: "A commuter taps send while walking through a station.",
    required: ["a commuter", "a phone"],
    forbidden: ["generic crowd"],
    required_action: "taps send on a phone",
    visual_mode: "generated_image",
    generation_prompt: "a commuter mid-stride pressing send on a phone in a station concourse",
  }, { provider });

  const prompt = provider.prompts[0]!;
  assert.match(prompt, /METADATA ONLY/);
  assert.match(prompt, /cannot and must not claim to see the image/);
  assert.match(prompt, /EXACT GENERATION PROMPT:/);
  assert.doesNotMatch(prompt, /image_url|attached image|look at the/i);
});

test("an accepting verdict is returned tagged as a metadata proxy, not a pixel check", async () => {
  const result = await metadataSemanticGate(
    { narration: "n", required: [], forbidden: [], visual_mode: "stock_video", stock_query: "commuter texting on train platform" },
    { provider: stubProvider(accept) },
  );
  assert.ok(result);
  assert.equal(result.accept, true);
  assert.equal(result.source, "metadata_proxy");
  assert.equal(result.concern, "none");
  assert.equal(result.confidence, 0.82);
});

test("a rejecting verdict carries the concern", async () => {
  const result = await metadataSemanticGate(
    { narration: "n", required: [], forbidden: [], visual_mode: "stock_video", stock_query: "city" },
    { provider: stubProvider(reject) },
  );
  assert.equal(result?.accept, false);
  assert.equal(result?.concern, "generic_filler");
});

test("an unreachable free text chain yields null, not a fabricated pass", async () => {
  const result = await metadataSemanticGate(
    { narration: "n", required: [], forbidden: [], visual_mode: "generated_image" },
    { provider: stubProvider(new Error("all 4 configured free text model(s) unavailable")) },
  );
  assert.equal(result, null);
});

function beat(overrides: Partial<VisualBeat> = {}): VisualBeat {
  return {
    id: "beat_001",
    scene_index: 0,
    beat_index: 0,
    start_sec: 0,
    end_sec: 4,
    narration: "A commuter taps send while walking through a station.",
    context: { previous: "", next: "" },
    intent: { purpose: "ESTABLISH", information: "x", emotion: "curiosity", importance: 0.7 },
    visual_contract: {
      required: ["one identifiable commuter", "a phone in hand"],
      forbidden: ["anonymous station crowd"],
      required_action: "the commuter taps send while walking",
      viewer_takeaway: "the message leaves while the commuter moves",
    },
    routing: { preferred: "generated_image", fallback: "stock_video", image_style: "realistic" },
    continuity: { group: "commuter", entities: ["commuter_a"] },
    retention: { novelty_required: false, visual_change_strength: 0.4, composition: "medium_action", camera_treatment: "tracking", subject_placement: "left_third", explanatory_pattern: "action" },
    asset_brief: {
      query: "commuter phone station",
      query_variants: ["commuter phone station", "person texting platform", "hand tapping phone train"],
      generation_prompt: "a commuter mid-stride pressing send on a phone in a station",
      generation_variants: ["a", "b", "c"],
      generated_video_prompt: "",
      motion_graphic_brief: "",
    },
    ...overrides,
  };
}

const frame = { bytes: new Uint8Array([1, 2, 3]), media_type: "image/jpeg" };
const noNet: never = undefined as never;

test("scoreVisualBeatImage in the default mode uses the proxy and claims no pixel evidence", async () => {
  delete process.env["VISUAL_QA_MODE"]; // default = proxy
  const provider = stubProvider(accept);

  const result = await scoreVisualBeatImage(frame, beat(), noNet, { proxyProvider: provider, sourcing: { generation_prompt: "a commuter pressing send in a station" } });

  assert.ok(result);
  assert.equal(result.source, "metadata_proxy");
  // Passes the acceptance floors...
  assert.ok(result.scores.semantic_match >= 0.9);
  assert.ok(result.scores.action_match >= 0.7);
  // ...but NEVER asserts any pixel-level evidence.
  assert.equal(result.action_evidence, undefined);
  assert.equal(result.identity_continuity_evidence, undefined);
  assert.equal(result.requirements_visible, undefined);
  assert.equal(result.composition_failure, undefined);
  assert.equal(result.garbled_text, undefined);
  assert.equal(result.implausible_object_scale, undefined);
  assert.match(result.reason, /metadata proxy/);
  // It sent the sourcing prompt to the text model, not an image.
  assert.match(provider.prompts[0]!, /a commuter pressing send in a station/);
});

test("a proxy rejection fails the beat", async () => {
  delete process.env["VISUAL_QA_MODE"];
  const result = await scoreVisualBeatImage(frame, beat(), noNet, { proxyProvider: stubProvider(reject) });
  assert.ok(result);
  assert.equal(result.why_failure, true);
  assert.equal(result.generic_filler, true);
  assert.ok(result.scores.semantic_match < 0.9);
});

test("a proxy outage returns null so the caller records QA-unavailable, not a pass", async () => {
  delete process.env["VISUAL_QA_MODE"];
  const result = await scoreVisualBeatImage(frame, beat(), noNet, { proxyProvider: stubProvider(new Error("free chain down")) });
  assert.equal(result, null);
});
