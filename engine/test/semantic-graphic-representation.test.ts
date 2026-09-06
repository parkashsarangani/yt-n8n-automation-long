import test from "node:test";
import assert from "node:assert/strict";

import { resolveSemanticScene } from "../src/workers/visual-beat-resolver.ts";
import { bridgeSemanticTemplateData } from "../src/providers/compose.ts";
import type { SemanticScene } from "../src/semantic-scene.ts";
import type { VisualBeat } from "../src/visual-routing.ts";

function beat(overrides: Partial<VisualBeat> = {}): VisualBeat {
  return {
    id: "beat_007",
    scene_index: 2,
    beat_index: 1,
    start_sec: 0,
    end_sec: 4.2,
    narration: "Walking at five kilometers an hour covers twenty kilometers in four hours.",
    context: { previous: "Put the speeds on one scale.", next: "A phone message can cover that distance in a fraction of a second." },
    intent: { purpose: "MAKE_SCALE_INTUITIVE", information: "walking covers 20km in 4h", emotion: "curiosity", importance: 0.8 },
    visual_contract: {
      required: ["walker marker moving along a 20-kilometer route"],
      forbidden: ["generic clock"],
      required_action: "the walking marker advances to the four-hour point",
      viewer_takeaway: "The walking calculation is five times four equals twenty kilometers.",
    },
    routing: { preferred: "motion_graphic", fallback: "generated_image", image_style: "not_applicable" },
    continuity: { group: "speed_comparison_scale", entities: ["walking_marker_a", "distance_scale_a"] },
    retention: {
      novelty_required: false,
      visual_change_strength: 0.4,
      composition: "diagrammatic",
      camera_treatment: "diagram_motion",
      subject_placement: "left_third",
      explanatory_pattern: "counter",
    },
    asset_brief: {
      query: "walking speed diagram",
      query_variants: ["walking speed diagram", "distance time chart", "pedestrian pace graphic"],
      generation_prompt: "a distance chart",
      generation_variants: ["a distance chart", "a labelled route", "a walking scale"],
      generated_video_prompt: "",
      motion_graphic_brief: "On distance_scale_a, show 5 km/h beside walking_marker_a.",
    },
    ...overrides,
  };
}

const drawable: SemanticScene = {
  kind: "scale_comparison",
  sequence_id: "speed_comparison_01",
  caption: "Walking: 4 hours",
  axis: { label: "distance", unit: "km", max: 20 },
  markers: [{ id: "walking", label: "Walking", value: 20, rate_label: "5 km/h", time_label: "4 hours" }],
  equation: "5 × 4 = 20 km",
};

test("a drawable semantic scene renders as a semantic graphic, unchanged", () => {
  const result = resolveSemanticScene(beat(), drawable);
  assert.equal(result.representation, "semantic_graphic");
  assert.equal(result.note, undefined);
  assert.deepEqual(result.scene, drawable);
});

test("a beat with no semantic_scene degrades to kinetic text, never to generic geometry", () => {
  const result = resolveSemanticScene(beat(), undefined);
  assert.equal(result.representation, "kinetic_text");
  assert.equal(result.scene.kind, "kinetic_phrase");
  assert.match(result.note ?? "", /SEMANTIC_FALLBACK/);
  // The fallback shows a short phrase, not the takeaway paragraph the old
  // renderer clipped off both frame edges.
  for (const line of result.scene.lines ?? []) {
    assert.ok(line.text.length <= 28, `"${line.text}" is ${line.text.length} chars`);
  }
});

test("an undrawable semantic scene degrades to kinetic text and says why", () => {
  const undrawable: SemanticScene = {
    kind: "scale_comparison",
    caption: "Walking",
    // No axis and no markers: precisely the "abstract boxes" shape.
    markers: [],
  };
  const result = resolveSemanticScene(beat(), undrawable);
  assert.equal(result.representation, "kinetic_text");
  assert.equal(result.scene.kind, "kinetic_phrase");
  assert.match(result.note ?? "", /not drawable/);
});

test("a scene whose markers carry no values cannot pass as a scale comparison", () => {
  const result = resolveSemanticScene(beat(), {
    kind: "scale_comparison",
    caption: "One shared scale",
    axis: { label: "distance", unit: "km", max: 20 },
    markers: [{ id: "walking", label: "Walking" } as never],
  });
  assert.equal(result.representation, "kinetic_text");
});

test("the kinetic-text fallback keeps its sequence id so the run stays traceable", () => {
  const result = resolveSemanticScene(beat(), {
    kind: "scale_comparison",
    sequence_id: "speed_comparison_01",
    caption: "broken",
    markers: [],
  });
  assert.equal(result.scene.sequence_id, "speed_comparison_01");
});

test("an RFC 0010 scene is never folded into the legacy blueprint bridge", () => {
  // bridgeSemanticTemplateData is what converts top-level semantic fields into
  // `semanticRepresentation`, and `semanticRepresentation` is what routes a
  // beat into the generic blueprint registry. An rfc0010 payload must pass
  // through untouched or the old boxes come back.
  const data = { rfc0010SemanticScene: drawable, keyText: drawable.caption };
  assert.deepEqual(bridgeSemanticTemplateData(data), data);
  assert.equal((bridgeSemanticTemplateData(data) as Record<string, unknown>)["semanticRepresentation"], undefined);
});

test("a legacy non-RFC0010 explanation payload still bridges exactly as before", () => {
  const bridged = bridgeSemanticTemplateData({
    representationMode: "quantitative",
    sceneBlueprint: "scale-comparison",
    visualClaim: "a claim",
    semanticEntities: [],
    semanticActionWindows: [],
  }) as Record<string, unknown>;
  assert.ok(bridged["semanticRepresentation"], "legacy production plans must keep their bridge");
});
