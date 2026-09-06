import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SchemaRegistry } from "../src/registry.ts";

const ENGINE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("visual_beat_assets 1.2 remains additive and validates sourcing telemetry", async () => {
  const registry = await SchemaRegistry.load(path.join(ENGINE_ROOT, "schemas"));
  assert.equal(registry.resolveVersion("visual_beat_assets"), "1.2.0");
  // Every earlier minor stays resolvable: the new fields are purely additive.
  assert.doesNotThrow(() => registry.entry("visual_beat_assets", "1.0.0"));
  assert.doesNotThrow(() => registry.entry("visual_beat_assets", "1.1.0"));

  const payload = {
    beats: [{
      id: "beat_001",
      scene_index: 0,
      beat_index: 0,
      start_sec: 0,
      end_sec: 3.2,
      requested_mode: "stock_video",
      resolved_mode: "stock_video",
      status: "resolved",
      semantic_verified: true,
      narration: "A commuter taps send while walking through a busy train station.",
      viewer_takeaway: "A real person sends a message while physically moving through a station.",
      video_uri: `blob://sha256:${"a".repeat(64)}`,
      preview_uri: `blob://sha256:${"b".repeat(64)}`,
      source_provider: "pexels",
      source_id: "12345",
      source_url: "https://www.pexels.com/video/12345/",
      source_in_sec: 1.2,
      source_out_sec: 4.4,
      semantic_match: 0.96,
      action_match: 0.91,
      visual_interest: 0.84,
      continuity: 0.90,
      generic_filler: false,
      why_failure: false,
      composition: "moving-medium-shot",
      camera_treatment: "tracking",
      subject_placement: "left-third",
      explanatory_pattern: "environment",
      candidate_count: 18,
      first_acceptable_candidate_index: 2,
      search_query_count: 1,
      mode_attempt_count: 1,
    }],
    summary: {
      resolved: 1,
      fallbacks: 0,
      unavailable: 0,
      stock_videos: 1,
      generated_images: 0,
      motion_graphics: 0,
      generated_videos: 0,
      generic_filler: 0,
      why_failures: 0,
    },
  };

  // A 1.1-shaped payload (no `representation`, no representation counters) is
  // still valid under 1.2 -- the resolver only started emitting those fields.
  assert.doesNotThrow(() => registry.validate("visual_beat_assets", "1.1.0", payload));
  assert.doesNotThrow(() => registry.validate("visual_beat_assets", "1.2.0", payload));

  // And the RFC 0010 representation telemetry validates on top of it.
  const withRepresentation = {
    beats: [{ ...payload.beats[0]!, representation: "stock_video" }],
    summary: { ...payload.summary, semantic_graphics: 0, kinetic_texts: 0 },
  };
  assert.doesNotThrow(() => registry.validate("visual_beat_assets", "1.2.0", withRepresentation));

  const semanticGraphic = {
    beats: [{
      ...payload.beats[0]!,
      id: "beat_006",
      requested_mode: "motion_graphic",
      resolved_mode: "motion_graphic",
      representation: "semantic_graphic",
      template_category: "explanation",
      template_data: JSON.stringify({ rfc0010SemanticScene: { kind: "scale_comparison", caption: "One shared scale" } }),
    }],
    summary: { ...payload.summary, stock_videos: 0, motion_graphics: 1, semantic_graphics: 1, kinetic_texts: 0 },
  };
  assert.doesNotThrow(() => registry.validate("visual_beat_assets", "1.2.0", semanticGraphic));
});
