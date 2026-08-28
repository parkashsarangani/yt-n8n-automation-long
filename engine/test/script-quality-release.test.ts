import test from "node:test";
import assert from "node:assert/strict";

import { assessScriptQuality, assessShowBookends, SCRIPT_QUALITY_THRESHOLDS, makeScriptQualityReleaseWorker } from "../src/workers/script-quality-release.ts";
import type { WorkerContext } from "../src/runner.ts";

function fakeCtx(attemptNumber: number): WorkerContext & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    attemptNumber,
    warnings,
    logger: { log: () => {}, warn: (msg: string) => warnings.push(msg), error: () => {} },
    blobs: {} as WorkerContext["blobs"],
    media: {},
    progress: async () => {},
  };
}

// Scores set comfortably above every threshold, not just the old fixed
// values -- stays a valid "passing" baseline however SCRIPT_QUALITY_
// THRESHOLDS gets recalibrated next, as long as headroom above 1.0 doesn't
// go negative.
function report(overrides: Record<string, number> = {}) {
  const scores: Record<string, number> = {};
  for (const [dimension, threshold] of Object.entries(SCRIPT_QUALITY_THRESHOLDS)) {
    scores[dimension] = Math.min(1, threshold + 0.05);
  }
  return { scores: { ...scores, ...overrides } };
}

// Just under a dimension's own threshold, deriving the failing value from
// the threshold itself rather than a hardcoded number that silently stops
// meaning "below the bar" the next time the bar moves.
function justBelow(dimension: keyof typeof SCRIPT_QUALITY_THRESHOLDS): number {
  return Math.round((SCRIPT_QUALITY_THRESHOLDS[dimension] - 0.01) * 100) / 100;
}

test("quality release requires every dimension and the aggregate bar", () => {
  assert.equal(assessScriptQuality(report()).passed, true);
  const weak = justBelow("character_chemistry");
  const weakChemistry = assessScriptQuality(report({ character_chemistry: weak }));
  assert.equal(weakChemistry.passed, false);
  assert.match(weakChemistry.failures.join("\n"), new RegExp(`character_chemistry=${weak.toFixed(2)}`));
});

test("a high average cannot hide one weak retention dimension", () => {
  const weak = justBelow("hook_curiosity");
  const result = assessScriptQuality(report({ hook_curiosity: weak, factual_fidelity: 1, comprehension: 1, payoff: 1 }));
  assert.equal(result.passed, false);
  assert.match(result.failures.join("\n"), new RegExp(`hook_curiosity=${weak.toFixed(2)}`));
});

test("missing critic dimensions block release", () => {
  const result = assessScriptQuality({ scores: { factual_fidelity: 1 } });
  assert.equal(result.passed, false);
  assert.match(result.failures.join("\n"), /dialogue_naturalness=missing/);
});


test("structurally excellent but emotionally flat dialogue cannot release", () => {
  const momentum = justBelow("emotional_momentum");
  const entertainment = justBelow("entertainment_value");
  const surprise = justBelow("surprise_freshness");
  const result = assessScriptQuality(report({
    factual_fidelity: 1,
    comprehension: 1,
    hook_curiosity: 1,
    dialogue_naturalness: 1,
    character_chemistry: 1,
    escalation: 1,
    payoff: 1,
    non_template_feel: 1,
    emotional_momentum: momentum,
    entertainment_value: entertainment,
    surprise_freshness: surprise,
  }));
  assert.equal(result.passed, false);
  assert.match(result.failures.join("\n"), new RegExp(`emotional_momentum=${momentum.toFixed(2)}`));
  assert.match(result.failures.join("\n"), new RegExp(`entertainment_value=${entertainment.toFixed(2)}`));
  assert.match(result.failures.join("\n"), new RegExp(`surprise_freshness=${surprise.toFixed(2)}`));
});

test("a below-bar script blocks on early attempts but is accepted after enough regenerations", async () => {
  // quality_release is a deterministic worker with no retry loop of its own
  // -- without this escape hatch, a script stuck just under the bar on the
  // same hard-to-hit dimension blocked the run forever, with no guarantee
  // the next manually-forced regeneration would land any differently.
  const worker = makeScriptQualityReleaseWorker();
  const weakReport = { payload: report({ entertainment_value: justBelow("entertainment_value") }) };
  const script = {
    payload: {
      scenes: [
        { speaker: "buddy", narration: "Why does ice float?", point: "action=Buddy looks at the cube; prop=ice; function=hook; value=opens the mystery" },
        { speaker: "host", narration: "Because its structure is roomier than liquid water.", point: "action=Host points at the model; prop=ice; function=recap confirms_understanding; value=resolves the mystery" },
      ],
    },
  };
  const inputs = { script, report: weakReport } as unknown as Parameters<typeof worker.execute>[0];

  await assert.rejects(() => worker.execute(inputs, fakeCtx(1)), /script quality release blocked \(attempt 1\/3\)/);
  await assert.rejects(() => worker.execute(inputs, fakeCtx(2)), /attempt 2\/3/);

  const ctx3 = fakeCtx(3);
  const accepted = await worker.execute(inputs, ctx3);
  assert.equal(accepted.payload, script.payload);
  assert.ok(ctx3.warnings.some((w) => w.includes("accepting below the quality bar")));
});

test("show bookends require Buddy's opening hook question", () => {
  // The closing-recap requirement lives in assessDialogueEvidence now (its
  // comprehension_arc/final_teach_back), not here -- a bare tag match on the
  // last scene reintroduced the exact false negative that module's synonym
  // table and last-scene fallback exist to fix, so this function only checks
  // what nothing else already covers: the opening.
  const passing = {
    scenes: [
      { speaker: "buddy", narration: "Why is the night sky dark?", point: "action=Buddy looks up; prop=sky; function=hook; value=opens the mystery" },
      { speaker: "host", narration: "Because not all light has reached us.", point: "action=light travels; prop=sky; function=recap confirms_understanding; value=resolves the mystery" },
    ],
  };
  assert.deepEqual(assessShowBookends(passing), []);
  assert.match(assessShowBookends({ scenes: [{ speaker: "host", narration: "The sky is dark." }] }).join("\n"), /opening speaker must be buddy/);
  assert.match(assessShowBookends({ scenes: [{ speaker: "buddy", narration: "The sky is dark." }] }).join("\n"), /hook question/);
});
