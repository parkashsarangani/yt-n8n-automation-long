import test from "node:test";
import assert from "node:assert/strict";
import { makeQaWorker } from "../src/workers/qa.ts";
import type { WorkerContext } from "../src/runner.ts";

const ctx = {
  logger: { log: () => {}, warn: () => {}, error: () => {} },
  progress: async () => {},
} as unknown as WorkerContext;

function inputs(review: { status: string; reviewed_shots: number; remaining_flagged_shots: string[]; reason: string; scores?: Record<string, number> }) {
  return {
    intent: { payload: { target_duration_sec: 180 } },
    script: { payload: { scenes: [{ scene_index: 0, narration: "A concrete story beat." }], word_count: 450 } },
    assets: { payload: {
      scenes: [{ scene_index: 0, source: "primary", hero_shot_ids: ["0:0"] }],
      degraded_count: 0,
      visual_review: review,
    } },
    voice: { payload: { clips: [{ scene_index: 0, duration_sec: 180 }], total_duration_sec: 180 } },
    render: { payload: { duration_sec: 180, scene_count: 1, degraded_scenes: 0 } },
    thumbnail: { payload: { background: "supplied", text: "A TURN" } },
    seo: { payload: { title: "A Valid YouTube Story Title", description: "A valid description.", tags: ["story"] } },
  } as never;
}

test("ordinary visual-review warning remains visible without blocking an otherwise healthy episode", async () => {
  const out = await makeQaWorker().execute(inputs({
    status: "warn",
    reviewed_shots: 8,
    remaining_flagged_shots: [],
    reason: "minor visual repetition remains",
  }), ctx);
  const payload = out.payload as any;
  const check = payload.checks.find((c: any) => c.id === "episode_visual_review");
  assert.equal(check.status, "warn");
  assert.match(check.message, /minor visual repetition/);
  assert.equal(payload.verdict, "pass");
});

test("critically weak opening score blocks unattended publication", async () => {
  const out = await makeQaWorker().execute(inputs({
    status: "pass",
    reviewed_shots: 8,
    remaining_flagged_shots: [],
    reason: "opening remains visually weak",
    scores: { opening_visual_strength: 0.42, continuity: 0.91, ai_artifacts: 0.9, payoff_visual_strength: 0.88 },
  }), ctx);
  const payload = out.payload as any;
  const check = payload.checks.find((c: any) => c.id === "episode_visual_review");
  assert.equal(check.status, "fail");
  assert.equal(check.measured, 0.42);
  assert.equal(check.threshold, 0.55);
  assert.equal(payload.verdict, "fail");
});

test("an unresolved hero-shot defect blocks unattended publication", async () => {
  const out = await makeQaWorker().execute(inputs({
    status: "warn",
    reviewed_shots: 8,
    remaining_flagged_shots: ["0:0"],
    reason: "the hook subject remains illegible",
    scores: { opening_visual_strength: 0.8, continuity: 0.9, ai_artifacts: 0.9, payoff_visual_strength: 0.85 },
  }), ctx);
  const payload = out.payload as any;
  const check = payload.checks.find((c: any) => c.id === "episode_visual_review");
  assert.equal(check.status, "fail");
  assert.match(check.message, /hero shot/i);
  assert.equal(payload.verdict, "fail");
});

test("an unresolved non-hero defect remains a warning instead of stopping the channel", async () => {
  const out = await makeQaWorker().execute(inputs({
    status: "warn",
    reviewed_shots: 8,
    remaining_flagged_shots: ["0:1"],
    reason: "one connective shot remains repetitive",
    scores: { opening_visual_strength: 0.8, continuity: 0.9, ai_artifacts: 0.9, payoff_visual_strength: 0.85 },
  }), ctx);
  const payload = out.payload as any;
  const check = payload.checks.find((c: any) => c.id === "episode_visual_review");
  assert.equal(check.status, "warn");
  assert.equal(payload.verdict, "pass");
});

test("visual-review pass remains a pass when no shots remain flagged and scores clear the floor", async () => {
  const out = await makeQaWorker().execute(inputs({
    status: "pass",
    reviewed_shots: 8,
    remaining_flagged_shots: [],
    reason: "sequence is coherent",
    scores: { opening_visual_strength: 0.84, continuity: 0.9, ai_artifacts: 0.94, payoff_visual_strength: 0.87 },
  }), ctx);
  const payload = out.payload as any;
  const check = payload.checks.find((c: any) => c.id === "episode_visual_review");
  assert.equal(check.status, "pass");
  assert.equal(payload.verdict, "pass");
});
