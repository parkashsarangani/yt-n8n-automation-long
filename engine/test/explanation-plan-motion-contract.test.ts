import assert from "node:assert/strict";
import test from "node:test";

import { agentSemanticValidationErrors, hasHardSemanticError } from "../src/agent-validators.ts";
import type { AgentDef } from "../src/runner.ts";

const DEF = {
  name: "explanation_visual_planner",
  kind: "agent",
  version: "1",
  consumes: [],
  produces: "explanation_plan",
  prompt: "explanation_visual_planner@1",
  model: { capability: "reasoning_high" },
} as unknown as AgentDef;

function scene(scene_index: number, visual_operation: string, visual_primitive: string, extra: Record<string, unknown> = {}) {
  return { scene_index, visual_operation, visual_primitive, visual_state: "mechanism", ...extra };
}

test("an incompatible operation/primitive pair is caught where the planner can still fix it", () => {
  // Real production failure (run_39850b3e): scene 10 asked to compress a
  // nested-context. The compiler enforced the same contract, but a worker has
  // no retry, so one bad pair in a forty-scene plan blocked the run for good.
  const errors = agentSemanticValidationErrors(
    DEF,
    { scenes: [scene(0, "stack", "particles"), scene(10, "compress", "nested-context")] },
    {},
  );

  const text = errors.join("\n");
  assert.match(text, /scene 10/);
  assert.match(text, /"compress" cannot be applied to visual_primitive "nested-context"/);
  // The message has to name the way out, or the retry is a guess.
  assert.match(text, /particles/);
});

test("every pair the contract allows passes", () => {
  const scenes = [
    scene(0, "stack", "hierarchy"),
    scene(1, "timeline", "cause-chain"),
    scene(2, "group", "nested-context"),
    scene(3, "compress", "physical-transformation"),
    scene(4, "scale-compare", "before-after"),
    scene(5, "payoff", "network"),
    scene(6, "counter", "quantity", { numeric_value: 73 }),
  ];
  assert.deepEqual(agentSemanticValidationErrors(DEF, { scenes }, {}), []);
});

test("a quantitative scene without a numeric value is caught at the same stage", () => {
  // The other rule that blocked this run, and the one that costs a full
  // attempt when it slips: it must be a number, not a string or null.
  for (const bad of [undefined, null, "73", "about 73"]) {
    const errors = agentSemanticValidationErrors(
      DEF,
      { scenes: [scene(4, "counter", "particles", bad === undefined ? {} : { numeric_value: bad })] },
      {},
    );
    assert.match(errors.join("\n"), /numeric_value must be a bare JSON number/, `numeric_value ${JSON.stringify(bad)} was accepted`);
  }
});

test("plans from other agents are not policed by this contract", () => {
  const other = { ...DEF, name: "cartoon_visual_planner", produces: "visual_plan" } as unknown as AgentDef;
  const errors = agentSemanticValidationErrors(other, { scenes: [scene(0, "compress", "nested-context")] }, {});
  assert.doesNotMatch(errors.join("\n"), /motion contract violated/);
});

test("a motion contract violation is marked hard, so the runner cannot silently accept it", () => {
  // Real production failure (same run, next deploy): the agent-stage retry
  // above worked -- three attempts, each narrowing the violations -- but the
  // runner's generic "accept the last attempt rather than block forever"
  // policy then accepted a plan that still failed this check. The compiler
  // enforces it unconditionally with no retry of its own, so accepting didn't
  // avoid the block; it produced an artifact guaranteed to fail one stage
  // later. hasHardSemanticError is what the runner checks before it will
  // apply that policy, so this failure must report true.
  const errors = agentSemanticValidationErrors(DEF, { scenes: [scene(2, "group", "map")] }, {});
  assert.equal(hasHardSemanticError(errors), true);
});

test("a soft gate (natural dialogue) is never marked hard", () => {
  // The passthrough exists precisely for this class of failure: a stylistic
  // gate where a below-bar-but-schema-valid artifact is better than none.
  const scriptDef = { ...DEF, name: "dialogue_script_writer", produces: "script" } as unknown as AgentDef;
  const scenes = Array.from({ length: 6 }, (_, i) => ({
    scene_index: i,
    narration: "The system explains the underlying causal mechanism at length in formal prose.",
  }));
  const errors = agentSemanticValidationErrors(scriptDef, { scenes }, {});
  assert.ok(errors.length > 0, "expected the fixture to actually trip the naturalness gate");
  assert.equal(hasHardSemanticError(errors), false);
});
