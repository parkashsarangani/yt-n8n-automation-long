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
      scenes: [{ scene_index: 0, source: "primary" }],
      degraded_count: 0,
      visual_review: review,
    } },
    voice: { payload: { clips: [{ scene_index: 0, duration_sec: 180 }], total_duration_sec: 180 } },
    render: { payload: { duration_sec: 180, scene_count: 1, degraded_scenes: 0 } },
    thumbnail: { payload: { background: "supplied", text: "A TURN" } },
    seo: { payload: { title: "A Valid YouTube Story Title", description: "A valid description.", tags: ["story"] } },
  } as never;
}

test("visual-review warn is not silently promoted to QA pass for that check", async () => {
  const out = await makeQaWorker().execute(inputs({
    status: "warn",
    reviewed_shots: 8,
    remaining_flagged_shots: [],
    reason: "opening visual strength remains below the review floor",
  }), ctx);
  const payload = out.payload as any;
  const check = payload.checks.find((c: any) => c.id === "episode_visual_review");
  assert.equal(check.status, "warn");
  assert.match(check.message, /opening visual strength/);
  assert.equal(payload.verdict, "pass", "visual weakness is surfaced without pretending it is a technical render failure");
});

test("a low multimodal score cannot masquerade as pass when no shot id was flagged", async () => {
  const out = await makeQaWorker().execute(inputs({
    status: "pass",
    reviewed_shots: 8,
    remaining_flagged_shots: [],
    reason: "opening remains visually weak",
    scores: { opening_visual_strength: 0.42, continuity: 0.91 },
  }), ctx);
  const payload = out.payload as any;
  const check = payload.checks.find((c: any) => c.id === "episode_visual_review");
  assert.equal(check.status, "warn");
  assert.equal(check.measured, 0.42);
  assert.equal(check.threshold, 0.68);
});

test("visual-review pass remains a pass when no shots remain flagged and scores clear the floor", async () => {
  const out = await makeQaWorker().execute(inputs({
    status: "pass",
    reviewed_shots: 8,
    remaining_flagged_shots: [],
    reason: "sequence is coherent",
    scores: { opening_visual_strength: 0.84, continuity: 0.9 },
  }), ctx);
  const payload = out.payload as any;
  const check = payload.checks.find((c: any) => c.id === "episode_visual_review");
  assert.equal(check.status, "pass");
});
