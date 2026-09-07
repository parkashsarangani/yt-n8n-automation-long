import test from "node:test";
import assert from "node:assert/strict";

import { continuityIdentity } from "../src/workers/visual-beat-resolver.ts";
import type { VisualBeat } from "../src/visual-routing.ts";

function beat(group: string, identity?: string): VisualBeat {
  return {
    id: `beat_${group || "none"}`,
    scene_index: 0,
    beat_index: 0,
    start_sec: 0,
    end_sec: 3,
    narration: "A recurring commuter crosses the station.",
    context: { previous: "", next: "" },
    intent: { purpose: "ESTABLISH", information: "commuter", emotion: "neutral", importance: 0.8 },
    visual_contract: { required: ["commuter"], forbidden: [], required_action: "", viewer_takeaway: "same commuter" },
    routing: { preferred: "generated_image", fallback: "stock_video", image_style: "realistic" },
    continuity: { group, entities: group ? ["commuter_a"] : [], ...(identity ? { identity } : {}) },
    retention: { novelty_required: false, visual_change_strength: 0.5, composition: "medium", camera_treatment: "static", subject_placement: "center", explanatory_pattern: "action" },
    asset_brief: { query: "commuter", query_variants: ["a", "b", "c"], generation_prompt: "commuter", generation_variants: ["a", "b", "c"], generated_video_prompt: "walks", motion_graphic_brief: "graphic" },
  };
}

test("the first non-empty identity description wins for a continuity group", () => {
  const pinned = new Map<string, string>();
  const first = "woman in her thirties, short dark hair, olive raincoat, tan satchel";
  const drift = "young man in a blue hoodie carrying a black backpack";

  assert.equal(continuityIdentity(beat("commuter", first), pinned), first);
  assert.equal(continuityIdentity(beat("commuter", drift), pinned), first);
  assert.equal(pinned.get("commuter"), first);
});

test("an initially undescribed group may acquire its first identity later", () => {
  const pinned = new Map<string, string>();
  const identity = "older courier with grey hair and a brown leather satchel";

  assert.equal(continuityIdentity(beat("courier"), pinned), "");
  assert.equal(pinned.has("courier"), false);
  assert.equal(continuityIdentity(beat("courier", identity), pinned), identity);
  assert.equal(pinned.get("courier"), identity);
});

test("continuity groups pin independently", () => {
  const pinned = new Map<string, string>();
  assert.equal(continuityIdentity(beat("a", "identity A"), pinned), "identity A");
  assert.equal(continuityIdentity(beat("b", "identity B"), pinned), "identity B");
  assert.equal(continuityIdentity(beat("a", "drift A"), pinned), "identity A");
  assert.equal(continuityIdentity(beat("b", "drift B"), pinned), "identity B");
});

test("a beat without a continuity group never pins an identity", () => {
  const pinned = new Map<string, string>();
  assert.equal(continuityIdentity(beat("", "anonymous description"), pinned), "");
  assert.equal(pinned.size, 0);
});
