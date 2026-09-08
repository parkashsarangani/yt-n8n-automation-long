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

test("visual director keeps exact full narration while removing irrelevant bulky inputs", () => {
  const exactNarration = `Opening ${"n".repeat(700)} closing punctuation!`;
  const scriptView = promptInputView("visual_director", "script", {
    scenes: [{
      scene_index: 0,
      is_outro: false,
      narration: exactNarration,
      point: "why the scale matters",
      visual_intent: "show the actual comparison",
      dialogue: [{ speaker: "unused", text: "duplicate" }],
      research_dump: "x".repeat(5000),
    }],
    timing_debug: "y".repeat(5000),
  }) as { scenes?: Array<{ narration?: string }> };
  assert.equal(scriptView.scenes?.[0]?.narration, exactNarration, "hard coverage requires byte-exact narration, never a 360-char clip");
  assert.doesNotMatch(text(scriptView), /research_dump|timing_debug|dialogue/);

  const voiceView = promptInputView("visual_director", "voice", {
    total_duration_sec: 61.4,
    clips: [{ scene_index: 0, duration_sec: 10.2, audio_uri: "blob://secret-audio", alignment_uri: "blob://huge-alignment", media_type: "audio/mpeg" }],
  });
  assert.deepEqual(voiceView, { total_duration_sec: 61.4, clips: [{ scene_index: 0, duration_sec: 10.2 }] });

  const growthRendered = text(promptInputView("visual_director", "growth", {
    premise: "One dollar each second",
    curiosity_gap: "How different are million, billion and trillion?",
    emotional_engine: "scale shock",
    selected_title: "The Billion Problem",
    selected_thumbnail_concept: "three clocks",
    opening_visual: "a counter ticking",
    first_30_seconds: { promise: "make scale intuitive", zero_to_five: "bulky duplicate" },
    next_video_bridge: "next episode",
    hero_motion_eligible: true,
    variants: Array.from({ length: 20 }, () => ({ huge: "z".repeat(1000) })),
    evidence: "q".repeat(5000),
  }));
  assert.match(growthRendered, /make scale intuitive/);
  assert.doesNotMatch(growthRendered, /variants|evidence|bulky duplicate/);

  const intentRendered = text(promptInputView("visual_director", "intent", {
    brief: "illustrated scale story",
    target_duration_sec: 60,
    constraints: ["truthful"],
    genre: "educational",
    image_style: "documentary_sketch",
    package_seed: { huge: "p".repeat(5000) },
  }));
  assert.match(intentRendered, /documentary_sketch/);
  assert.doesNotMatch(intentRendered, /package_seed/);
});

test("script prompt views keep the payoff scene for a realistic-length long episode", () => {
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
