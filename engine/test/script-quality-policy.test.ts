import test from "node:test";
import assert from "node:assert/strict";
import { agentSemanticValidationErrors, HARD_ERROR_PREFIX } from "../src/agent-validators.ts";
import { stripEditorVisuals } from "../src/runner.ts";
import { makeWatchabilityReleaseWorker, WATCHABILITY_THRESHOLDS } from "../src/workers/watchability-release.ts";

function scores() {
  return Object.fromEntries(Object.keys(WATCHABILITY_THRESHOLDS).map((key) => [key, 0.9]));
}

test("script structure remains feedback, not a permanent hard block", () => {
  const errors = agentSemanticValidationErrors(
    { name: "narration_script_writer" } as never,
    { scenes: [] },
    { intent: { payload: { niche: "practical-social-intelligence" } } } as never,
  );
  assert.ok(errors.length > 0);
  assert.ok(errors.every((error) => !error.startsWith(HARD_ERROR_PREFIX)));
});

test("editor-owned visual metadata is removed before script validation/storage", () => {
  const payload = {
    scenes: [{ scene_index: 0, point: "[scenario]", narration: "A valid spoken beat.", visual: { kind: "bad", invented: true } }],
    word_count: 4,
  };
  assert.deepEqual(stripEditorVisuals(payload), {
    scenes: [{ scene_index: 0, point: "[scenario]", narration: "A valid spoken beat." }],
    word_count: 4,
  });
});

test("watchability release accepts a schema-valid below-bar script on attempt three", async () => {
  const worker = makeWatchabilityReleaseWorker();
  const scriptPayload = { scenes: [{ scene_index: 0, point: "[scenario]", narration: "A valid spoken beat." }] };
  const inputs = {
    script: { payload: scriptPayload },
    report: { payload: { verdict: "revise", abandon_recommended: false, scores: { ...scores(), suspense: 0.6 } } },
    intent: { payload: { target_duration_sec: 600 } },
  } as never;
  const ctx = { attemptNumber: 3, logger: { warn() {}, log() {}, error() {} } } as never;
  const result = await worker.execute(inputs, ctx);
  assert.deepEqual(result.payload, scriptPayload);
});

test("watchability release still retries a below-bar script before attempt three", async () => {
  const worker = makeWatchabilityReleaseWorker();
  const inputs = {
    script: { payload: { scenes: [{ scene_index: 0, point: "[scenario]", narration: "A valid spoken beat." }] } },
    report: { payload: { verdict: "revise", abandon_recommended: false, scores: { ...scores(), suspense: 0.6 } } },
    intent: { payload: { target_duration_sec: 600 } },
  } as never;
  const ctx = { attemptNumber: 2, logger: { warn() {}, log() {}, error() {} } } as never;
  await assert.rejects(() => worker.execute(inputs, ctx), /REVISE_SCRIPT/);
});
