import test from "node:test";
import assert from "node:assert/strict";

import { assessPlanRevision, flaggedSceneIndices, makeExplanationPlanReleaseWorker } from "../src/workers/explanation-plan-release.ts";
import type { Artifact } from "../src/artifact.ts";
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

function scene(overrides: Record<string, unknown> = {}) {
  return {
    scene_index: 0,
    visual_primitive: "before-after",
    visual_operation: "scale-compare",
    model_elements: ["a", "b"],
    model_relations: [],
    key_text: "original",
    ...overrides,
  };
}

function review(scenes: Array<Record<string, unknown>>) {
  return { overall_verdict: "revise", episode_note: "", scenes };
}

test("a flagged scene returned unchanged fails the gate", () => {
  // The failure mode this worker exists for: the reviser agrees with the
  // critique and returns the scene as-is, and without this check the loop
  // reports success while nothing improved.
  const plan = { scenes: [scene({ scene_index: 0 })] };
  const { failures } = assessPlanRevision(plan, plan, review([{ scene_index: 0, verdict: "weak", failure_mode: "generic-visual" }]));
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /scene 0 was flagged for revision but came back byte-identical/);
});

test("a flagged scene that actually changed passes", () => {
  const before = { scenes: [scene({ scene_index: 0 })] };
  const after = { scenes: [scene({ scene_index: 0, key_text: "revised" })] };
  const { failures } = assessPlanRevision(before, after, review([{ scene_index: 0, verdict: "weak", failure_mode: "generic-visual" }]));
  assert.deepEqual(failures, []);
});

test("reordering a scene's keys does not count as a revision", () => {
  // An agent re-emitting a scene will not preserve key order, and a raw
  // JSON.stringify comparison would read that reshuffle as a change --
  // letting exactly the no-op this gate exists to catch slip through.
  const before = { scenes: [{ scene_index: 0, key_text: "same", visual_primitive: "objects", model_elements: ["a"] }] };
  const after = { scenes: [{ model_elements: ["a"], visual_primitive: "objects", key_text: "same", scene_index: 0 }] };
  const { failures } = assessPlanRevision(before, after, review([{ scene_index: 0, verdict: "weak", failure_mode: "static" }]));
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /byte-identical/);
});

test("a named failure mode counts as flagged even when the verdict says adequate", () => {
  // Otherwise `verdict` becomes the only field of a review that matters, and
  // a critic that names a concrete defect gets ignored on a technicality.
  assert.deepEqual(
    flaggedSceneIndices(review([
      { scene_index: 0, verdict: "adequate", failure_mode: "claim-mismatch" },
      { scene_index: 1, verdict: "adequate", failure_mode: "none" },
      { scene_index: 2, verdict: "weak", failure_mode: "none" },
    ])),
    [0, 2],
  );
});

test("a flagged scene dropped from the revision fails rather than passing silently", () => {
  const before = { scenes: [scene({ scene_index: 0 }), scene({ scene_index: 1 })] };
  const after = { scenes: [scene({ scene_index: 0 })] };
  const { failures } = assessPlanRevision(before, after, review([{ scene_index: 1, verdict: "weak", failure_mode: "static" }]));
  assert.ok(failures.some((failure) => /scene 1 was flagged for revision but is missing/.test(failure)));
  assert.ok(failures.some((failure) => /changed the scene count/.test(failure)));
});

test("a relation index past its own model_elements is rejected", () => {
  // The plan believes it authored a connection the renderer will never draw,
  // so the critic sees structure the viewer never gets.
  const plan = {
    scenes: [scene({
      visual_primitive: "network",
      model_elements: ["a", "b"],
      model_relations: [{ from_element: 0, to_element: 3, kind: "causes" }],
    })],
  };
  const { failures } = assessPlanRevision(plan, plan, review([]));
  assert.ok(failures.some((failure) => /to_element=3 points past its 2 model_elements/.test(failure)));
});

test("most relationship scenes falling back to the fixed topology is rejected", () => {
  const plan = {
    scenes: [
      scene({ scene_index: 0, visual_primitive: "network", model_relations: [] }),
      scene({ scene_index: 1, visual_primitive: "hierarchy", model_relations: [] }),
      scene({ scene_index: 2, visual_primitive: "cause-chain", model_relations: [{ from_element: 0, to_element: 1, kind: "causes" }] }),
    ],
  };
  const { failures } = assessPlanRevision(plan, plan, review([]));
  assert.ok(failures.some((failure) => /2 of 3 relationship-primitive scenes authored no model_relations/.test(failure)));
});

test("a single unconnected relationship scene is tolerated", () => {
  // Deliberately a majority rule. One scene the planner genuinely could not
  // connect must not burn three regenerations of an entire episode.
  const plan = {
    scenes: [
      scene({ scene_index: 0, visual_primitive: "network", model_relations: [{ from_element: 0, to_element: 1, kind: "causes" }] }),
      scene({ scene_index: 1, visual_primitive: "hierarchy", model_relations: [{ from_element: 0, to_element: 1, kind: "contains" }] }),
      scene({ scene_index: 2, visual_primitive: "cause-chain", model_relations: [] }),
    ],
  };
  assert.deepEqual(assessPlanRevision(plan, plan, review([])).failures, []);
});

test("subject primitives are never asked for relations", () => {
  const plan = {
    scenes: [
      scene({ scene_index: 0, visual_primitive: "particles", model_relations: [] }),
      scene({ scene_index: 1, visual_primitive: "wave", model_relations: [] }),
    ],
  };
  assert.deepEqual(assessPlanRevision(plan, plan, review([])).failures, []);
});

test("the worker blocks early attempts and accepts the last one rather than stalling a run", async () => {
  const worker = makeExplanationPlanReleaseWorker();
  const plan = { scenes: [scene({ scene_index: 0 })] };
  const inputs = {
    original: { payload: plan } as unknown as Artifact,
    revised: { payload: plan } as unknown as Artifact,
    review: { payload: review([{ scene_index: 0, verdict: "weak", failure_mode: "generic-visual" }]) } as unknown as Artifact,
  };

  await assert.rejects(
    () => worker.execute(inputs, fakeCtx(1)),
    /explanation plan release blocked \(attempt 1\/3\)/,
  );

  const ctx = fakeCtx(3);
  const out = await worker.execute(inputs, ctx);
  assert.equal(out.payload, plan, "the last attempt is released rather than blocking the run forever");
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0]!, /accepting the revision despite an unmet review/);
});

test("the released payload is the revision, never the plan that was criticised", async () => {
  const worker = makeExplanationPlanReleaseWorker();
  const before = { scenes: [scene({ scene_index: 0 })] };
  const after = { scenes: [scene({ scene_index: 0, key_text: "revised" })] };
  const out = await worker.execute({
    original: { payload: before } as unknown as Artifact,
    revised: { payload: after } as unknown as Artifact,
    review: { payload: review([{ scene_index: 0, verdict: "weak", failure_mode: "static" }]) } as unknown as Artifact,
  }, fakeCtx(1));
  assert.equal(out.payload, after);
});
