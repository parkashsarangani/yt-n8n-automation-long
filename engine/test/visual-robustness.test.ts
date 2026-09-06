import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import {
  agentSemanticValidationErrors,
  continuationBridgeErrors,
  hasHardSemanticError,
  unsafeDirectionTextPrompts,
} from "../src/agent-validators.ts";
import { SchemaRegistry } from "../src/registry.ts";
import { assessVisualAssetRelease } from "../src/workers/visual-asset-release.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SPECIFIC_BRIDGE = "And the next story asks what happens when the quietest person in the room is the only one who notices the real mistake.";
const PACKAGE = {
  premise: "A substitute teacher notices a pattern everyone else dismisses, then the class discovers why it mattered.",
  target_audience: "Adults who enjoy compact workplace and school reversal stories",
  curiosity_gap: "Why the substitute saw the problem before everyone else",
  emotional_engine: "underestimation to tension to earned reversal",
  selected_title: "Nobody Believed the Substitute Teacher",
  selected_title_family: "conflict",
  selected_thumbnail_concept: "A substitute teacher facing a skeptical classroom",
  selected_thumbnail_family: "conflict",
  opening_visual: "A substitute teacher pauses beside one empty desk while the class keeps talking.",
  opening_line: "The substitute stopped at one empty desk before anyone else understood why.",
  first_30_seconds: {
    promise: "The ignored detail will become the reason the substitute was right.",
    zero_to_five: "Show the substitute noticing the empty desk immediately.",
    five_to_fifteen: "The class dismisses the concern while another detail makes the pattern stranger.",
    fifteen_to_thirty: "A concrete consequence proves the observation matters."
  },
  variants: [
    { family: "curiosity", title: "The Detail Only the Substitute Saw", thumbnail_concept: "Teacher staring at one empty desk", click_reason: "The missing detail creates a clean unanswered question." },
    { family: "conflict", title: "Nobody Believed the Substitute Teacher", thumbnail_concept: "A substitute teacher facing a skeptical classroom", click_reason: "The underestimation is instantly legible." },
    { family: "reversal", title: "Then the Class Went Completely Quiet", thumbnail_concept: "Silent classroom facing the substitute", click_reason: "The visible reversal promises a consequence without explaining it." }
  ],
  scores: { clickability: 0.84, story_potential: 0.86, audience_size: 0.78 },
  selection_rationale: "The conflict family gives the cleanest emotional promise while preserving a concrete visible reversal.",
  next_video_bridge: SPECIFIC_BRIDGE,
};

function scores(overrides: Record<string, number> = {}) {
  return {
    opening_visual_strength: 0.82,
    scene_relevance: 0.78,
    subject_legibility: 0.80,
    emotional_readability: 0.76,
    shot_variety: 0.75,
    visual_redundancy: 0.77,
    continuity: 0.74,
    style_consistency: 0.79,
    ai_artifacts: 0.82,
    payoff_visual_strength: 0.76,
    ...overrides,
  };
}

test("director rejects the production-like seating-chart prompt before image spend", () => {
  const unsafe = {
    scenes: [{
      scene_index: 0,
      shots: [{ image_prompt: "a paper seating chart with students' names visible in rows" }],
    }],
  };
  const safe = {
    scenes: [{
      scene_index: 0,
      shots: [{ image_prompt: "a folded seating chart face-down on the desk while the substitute teacher points to empty desks" }],
    }],
  };

  assert.match(unsafeDirectionTextPrompts(unsafe).join("; "), /text-bearing object.*readable writing/i);
  assert.deepEqual(unsafeDirectionTextPrompts(safe), []);

  const routed = agentSemanticValidationErrors({ name: "episode_director" } as any, unsafe, {});
  assert.equal(hasHardSemanticError(routed), true, "the final director retry must not accept this below the semantic bar");
});

test("continuation bridge rejects generic engagement and accepts a specific adjacent story", () => {
  const generic = continuationBridgeErrors({ next_video_bridge: "Like and subscribe, then watch the next video." });
  assert.ok(generic.length >= 1);
  assert.deepEqual(continuationBridgeErrors({ next_video_bridge: SPECIFIC_BRIDGE }), []);

  const routed = agentSemanticValidationErrors({ name: "growth_packager" } as any, { next_video_bridge: "Watch the next video for more like this." }, {});
  assert.equal(hasHardSemanticError(routed), true, "generic continuation must not be accepted on the packager's final retry");
});

test("growth_package 1.2.0 requires an authoritative next_video_bridge", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  assert.doesNotThrow(() => registry.validate("growth_package", "1.2.0", PACKAGE));
  const { next_video_bridge: _bridge, ...withoutBridge } = PACKAGE;
  assert.throws(() => registry.validate("growth_package", "1.2.0", withoutBridge), /next_video_bridge|required/i);
});

test("pre-render visual release blocks the exact observed 3-of-6 fallback plus continuity failure", () => {
  const assessment = assessVisualAssetRelease({
    scenes: [
      { scene_index: 0, source: "fallback", hero_shot_ids: ["0:0"] },
      { scene_index: 1, source: "primary", hero_shot_ids: [] },
      { scene_index: 2, source: "fallback", hero_shot_ids: [] },
      { scene_index: 3, source: "primary", hero_shot_ids: ["3:0"] },
      { scene_index: 4, source: "fallback", hero_shot_ids: [] },
      { scene_index: 5, source: "primary", hero_shot_ids: ["5:0"] },
    ],
    degraded_count: 3,
    visual_review: {
      status: "warn",
      remaining_flagged_shots: [],
      scores: scores({ continuity: 0.36 }),
      reason: "Repeated fallback frames break continuity across the episode.",
    },
  });

  assert.equal(assessment.fallbackRatio, 0.5);
  assert.ok(assessment.failures.some((failure) => /3\/6.*fallback.*50%/i.test(failure)));
  assert.ok(assessment.failures.some((failure) => /continuity=0\.36/i.test(failure)));
});

test("pre-render visual release passes clean assets and only warns for bounded non-critical degradation", () => {
  const clean = assessVisualAssetRelease({
    scenes: Array.from({ length: 6 }, (_, scene_index) => ({ scene_index, source: "primary", hero_shot_ids: scene_index === 0 ? ["0:0"] : [] })),
    degraded_count: 0,
    visual_review: { status: "pass", remaining_flagged_shots: [], scores: scores(), reason: "clean" },
  });
  assert.deepEqual(clean.failures, []);

  const bounded = assessVisualAssetRelease({
    scenes: Array.from({ length: 20 }, (_, scene_index) => ({ scene_index, source: scene_index === 19 ? "fallback" : "primary", hero_shot_ids: [] })),
    degraded_count: 1,
    visual_review: { status: "pass", remaining_flagged_shots: [], scores: scores(), reason: "clean" },
  });
  assert.deepEqual(bounded.failures, []);
  assert.ok(bounded.warnings.some((warning) => /1\/20.*fallback/i.test(warning)));
});

test("illustrated graph requires a visual release before render while final QA still inspects raw assets", async () => {
  const graph = JSON.parse(await readFile(path.join(ROOT, "graphs", "illustrated_story.json"), "utf8")) as {
    version: string;
    nodes: Array<{ id: string; transformation?: string; in?: string[] }>;
  };
  assert.equal(graph.version, "8");
  const release = graph.nodes.find((node) => node.id === "visual_asset_release");
  const render = graph.nodes.find((node) => node.id === "render");
  const qa = graph.nodes.find((node) => node.id === "qa");
  assert.deepEqual(release?.in, ["assets"]);
  assert.ok(render?.in?.includes("assets"));
  assert.ok(render?.in?.includes("visual_asset_release"));
  assert.ok(qa?.in?.includes("assets"));
  assert.equal(qa?.in?.includes("visual_asset_release"), false);
});
