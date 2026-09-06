import { describe, expect, it } from "vitest";
import { scoreVisualBeatFrames, type VisualBeatFetch } from "../src/visual-beat-qa.ts";
import { repairVisualBeatPlan, selectVisualMode, type VisualBeat, type VisualBeatPlan } from "../src/visual-routing.ts";

function beat(overrides: Partial<VisualBeat> = {}): VisualBeat {
  return {
    id: "beat_001",
    scene_index: 0,
    beat_index: 0,
    start_sec: 0,
    end_sec: 4,
    narration: "The commuter taps send before reaching the platform.",
    context: { previous: "", next: "The message arrives first." },
    intent: { purpose: "ESTABLISH", information: "message outruns commuter", emotion: "curiosity", importance: 0.8 },
    visual_contract: {
      required: ["one identifiable commuter", "phone visible in the commuter's hand"],
      forbidden: ["generic station crowd with no identifiable protagonist"],
      required_action: "the same commuter visibly taps or sends a message while continuing to walk",
      viewer_takeaway: "the message leaves while the commuter is still moving",
    },
    routing: { preferred: "stock_video", fallback: "generated_image", image_style: "realistic" },
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
      query_variants: ["commuter walking station phone", "traveler texting train platform", "person sends phone message station"],
      generation_prompt: "same commuter walking through station with phone",
      generation_variants: ["same commuter walking through station with phone", "side view commuter tapping send while walking", "tracking shot commuter holding phone toward platform"],
      generated_video_prompt: "same commuter walks and taps send",
      motion_graphic_brief: "",
    },
    ...overrides,
  };
}

function fakeFetch(payload: Record<string, unknown>): VisualBeatFetch {
  return async () => ({
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content: JSON.stringify(payload) } }] };
    },
  });
}

const frame = { bytes: new Uint8Array([1, 2, 3]), media_type: "image/jpeg" };

describe("RFC0010 candidate evidence gates", () => {
  it("does not let generic station footage pass a required phone-send action", async () => {
    process.env["OPENAI_API_KEY"] = "test";
    const result = await scoreVisualBeatFrames([frame, frame, frame], beat(), {}, fakeFetch({
      semantic_match: 0.96,
      action_match: 0.95,
      visual_interest: 0.88,
      continuity: 0.92,
      generic_filler: false,
      why_failure: false,
      repetitive_with_context: false,
      requirements_visible: true,
      action_evidence: false,
      identity_continuity_evidence: true,
      composition_failure: false,
      garbled_text: false,
      implausible_object_scale: false,
      environment_mismatch: false,
      reason: "People are walking in a station, but no tap/send action is visible.",
    }));
    expect(result).not.toBeNull();
    expect(result!.scores.action_match).toBeLessThanOrEqual(0.2);
    expect(result!.generic_filler).toBe(true);
    expect(result!.action_evidence).toBe(false);
  });

  it("penalizes recurring-character identity drift even when the scene is semantically on-topic", async () => {
    process.env["OPENAI_API_KEY"] = "test";
    const result = await scoreVisualBeatFrames([frame], beat(), {}, fakeFetch({
      semantic_match: 0.95,
      action_match: 0.9,
      visual_interest: 0.9,
      continuity: 0.9,
      generic_filler: false,
      why_failure: false,
      repetitive_with_context: false,
      requirements_visible: true,
      action_evidence: true,
      identity_continuity_evidence: false,
      composition_failure: false,
      garbled_text: false,
      implausible_object_scale: false,
      environment_mismatch: false,
      reason: "The person does not match the recurring commuter.",
    }));
    expect(result!.scores.continuity).toBeLessThanOrEqual(0.2);
    expect(result!.why_failure).toBe(true);
  });

  it("rejects garbled AI typography but does not reject legitimate readable labels merely for being text", async () => {
    process.env["OPENAI_API_KEY"] = "test";
    const clean = await scoreVisualBeatFrames([frame], beat({
      visual_contract: {
        required: ["a scale labelled 20 km", "a marker labelled 5 km/h"],
        forbidden: [],
        required_action: "",
        viewer_takeaway: "twenty kilometres at five kilometres per hour",
      },
      continuity: { group: "", entities: [] },
    }), {}, fakeFetch({
      semantic_match: 0.98,
      action_match: 1,
      visual_interest: 0.9,
      continuity: 1,
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
      reason: "The required numeric labels are legible.",
    }));
    expect(clean!.why_failure).toBe(false);
    expect(clean!.garbled_text).toBe(false);

    const garbled = await scoreVisualBeatFrames([frame], beat({ continuity: { group: "", entities: [] } }), {}, fakeFetch({
      semantic_match: 0.95,
      action_match: 0.9,
      visual_interest: 0.85,
      continuity: 1,
      generic_filler: false,
      why_failure: false,
      repetitive_with_context: false,
      requirements_visible: true,
      action_evidence: true,
      identity_continuity_evidence: true,
      composition_failure: false,
      garbled_text: true,
      implausible_object_scale: false,
      environment_mismatch: false,
      reason: "The phone notification contains pseudo-letters.",
    }));
    expect(garbled!.why_failure).toBe(true);
    expect(garbled!.garbled_text).toBe(true);
  });

  it("routes recurring named entities away from generic stock when a continuity-capable fallback exists", () => {
    const original = beat();
    const repaired = repairVisualBeatPlan({ beats: [original] } satisfies VisualBeatPlan);
    expect(repaired.plan.beats[0]!.routing.preferred).toBe("generated_image");
    expect(repaired.plan.beats[0]!.routing.fallback).toBe("stock_video");
    expect(repaired.repairs.some((line) => line.includes("continuity"))).toBe(true);

    expect(selectVisualMode(repaired.plan.beats[0]!, [], {
      stock_video: true,
      generated_image: true,
      motion_graphic: true,
      generated_video: true,
    })).toBe("generated_image");
  });
});
