import test from "node:test";
import assert from "node:assert/strict";

import { promptInputView } from "../src/prompt-inputs.ts";

function text(value: unknown): string {
  return JSON.stringify(value);
}

test("script prompt views keep scene essentials and drop unneeded bulky fields", () => {
  const script = {
    scenes: [
      {
        scene_index: 0,
        act_index: 0,
        speaker_id: "host",
        point: "sets up the room-forgetting premise",
        narration: "You walk into the kitchen and your brain quietly deletes the mission.",
        unused_research_dump: "x".repeat(5000),
      },
    ],
    word_count: 13,
    timing_debug: "y".repeat(5000),
  };

  const view = promptInputView("cartoon_visual_planner", "script", script);
  const rendered = text(view);

  assert.match(rendered, /room-forgetting premise/);
  assert.match(rendered, /quietly deletes the mission/);
  assert.doesNotMatch(rendered, /unused_research_dump/);
  assert.doesNotMatch(rendered, /timing_debug/);
});

test("script prompt views keep the payoff scene for a realistic-length long episode", () => {
  // 19 scenes (indices 0-18) is the standard long-episode fixture size used
  // throughout this project's compiler/gate tests. The final scene is
  // typically the payoff/callback resolution — the one scene
  // assertCreativeSceneCoverage most needs cartoon_creative_director and
  // cartoon_visual_planner to have actually seen, not guessed at.
  const script = {
    scenes: Array.from({ length: 19 }, (_, i) => ({
      scene_index: i,
      speaker_id: i % 2 === 0 ? "host" : "buddy",
      point: `beat ${i}`,
      narration: i === 18 ? "Fine. Laptop stays downstairs." : `narration line ${i}`,
    })),
    word_count: 19,
  };

  for (const agentName of ["cartoon_creative_director", "cartoon_visual_planner"]) {
    const view = promptInputView(agentName, "script", script) as { scenes?: Array<{ scene_index: number }> };
    assert.equal(view.scenes?.length, 19, `${agentName} should see all 19 scenes`);
    assert.equal(view.scenes?.at(-1)?.scene_index, 18);
    assert.match(text(view), /Laptop stays downstairs/);
  }
});

test("script prompt views keep every scene for a 38-scene episode, not just the first 24", () => {
  // Real production episode: 38 scenes, payoff on scene 37. The old 24-scene
  // cap silently blinded cartoon_visual_planner to scenes 24-37 -- it could
  // not produce visual direction for them, so the compiler synthesized a
  // naive repeated fallback for the uncovered tail and then rejected its own
  // fallback as repetitive staging.
  const script = {
    scenes: Array.from({ length: 38 }, (_, i) => ({
      scene_index: i,
      speaker_id: i % 2 === 0 ? "host" : "buddy",
      point: `beat ${i}`,
      narration: i === 37 ? "Tomorrow too." : `narration line ${i}`,
    })),
    word_count: 38,
  };

  for (const agentName of ["cartoon_creative_director", "cartoon_visual_planner"]) {
    const view = promptInputView(agentName, "script", script) as { scenes?: Array<{ scene_index: number }> };
    assert.equal(view.scenes?.length, 38, `${agentName} should see all 38 scenes`);
    assert.equal(view.scenes?.at(-1)?.scene_index, 37);
    assert.match(text(view), /Tomorrow too/);
  }
});

test("story prompt views preserve act structure but trim long prose", () => {
  const story = {
    topic: "Why you forget why you walked into a room",
    title: "The Doorway That Robs Your Brain",
    hook: "h".repeat(2000),
    acts: [
      { act_index: 0, act_title: "Desk", premise: "remembering", target_words: 200, internal_notes: "n".repeat(2000) },
    ],
    raw_sources: "s".repeat(6000),
    payoff: "The cue has to cross the doorway with you.",
  };

  const view = promptInputView("dialogue_script_writer", "story", story);
  const rendered = text(view);

  assert.match(rendered, /The Doorway That Robs Your Brain/);
  assert.match(rendered, /Desk/);
  assert.match(rendered, /The cue has to cross/);
  assert.doesNotMatch(rendered, /raw_sources/);
  assert.doesNotMatch(rendered, /internal_notes/);
  assert.ok(rendered.length < text(story).length / 2, "story view should be materially smaller");
});

test("performance prompt views cap large episode arrays", () => {
  const performance = {
    generated_at: "2026-08-23T10:00:00Z",
    episode_count: 120,
    ctr_available: true,
    aggregates: { median_views: 42, median_ctr: 0.05 },
    episodes: Array.from({ length: 120 }, (_, i) => ({
      external_id: `video-${i}`,
      title: `Episode ${i}`,
      primary_keyword: "memory",
      thumbnail_text: "FORGET THIS",
      published_at: "2026-08-01",
      window_days: 7,
      metrics: { views: i, average_view_percentage: 51, click_through_rate: 0.04 },
      raw_platform_blob: "z".repeat(1000),
    })),
  };

  const view = promptInputView("channel_strategist", "performance", performance) as { episodes?: unknown[] };
  const rendered = text(view);

  assert.equal(view.episodes?.length, 80);
  assert.match(rendered, /video-79/);
  assert.doesNotMatch(rendered, /video-80/);
  assert.doesNotMatch(rendered, /raw_platform_blob/);
});
