import test from "node:test";
import assert from "node:assert/strict";

import { assessScriptQuality, SCRIPT_QUALITY_THRESHOLDS } from "../src/workers/script-quality-release.ts";

function report(overrides: Record<string, number> = {}) {
  return { scores: { ...SCRIPT_QUALITY_THRESHOLDS, factual_fidelity: 0.98, comprehension: 0.96, hook_curiosity: 0.96, dialogue_naturalness: 0.95, character_chemistry: 0.95, escalation: 0.95, payoff: 0.96, non_template_feel: 0.94, ...overrides } };
}

test("quality release requires every dimension and the aggregate bar", () => {
  assert.equal(assessScriptQuality(report()).passed, true);
  const weakChemistry = assessScriptQuality(report({ character_chemistry: 0.89 }));
  assert.equal(weakChemistry.passed, false);
  assert.match(weakChemistry.failures.join("\n"), /character_chemistry=0.89/);
});

test("a high average cannot hide one weak retention dimension", () => {
  const result = assessScriptQuality(report({ hook_curiosity: 0.80, factual_fidelity: 1, comprehension: 1, payoff: 1 }));
  assert.equal(result.passed, false);
  assert.match(result.failures.join("\n"), /hook_curiosity=0.80/);
});

test("missing critic dimensions block release", () => {
  const result = assessScriptQuality({ scores: { factual_fidelity: 1 } });
  assert.equal(result.passed, false);
  assert.match(result.failures.join("\n"), /dialogue_naturalness=missing/);
});


test("structurally excellent but emotionally flat dialogue cannot release", () => {
  const result = assessScriptQuality(report({
    factual_fidelity: 1,
    comprehension: 1,
    hook_curiosity: 1,
    dialogue_naturalness: 1,
    character_chemistry: 1,
    escalation: 1,
    payoff: 1,
    non_template_feel: 1,
    emotional_momentum: 0.82,
    entertainment_value: 0.84,
    surprise_freshness: 0.86,
  }));
  assert.equal(result.passed, false);
  assert.match(result.failures.join("\n"), /emotional_momentum=0.82/);
  assert.match(result.failures.join("\n"), /entertainment_value=0.84/);
  assert.match(result.failures.join("\n"), /surprise_freshness=0.86/);
});
