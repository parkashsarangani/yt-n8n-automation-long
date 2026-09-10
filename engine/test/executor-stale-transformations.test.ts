import test from "node:test";
import assert from "node:assert/strict";

import { GraphExecutor } from "../src/executor.ts";
import { MemoryRunLog } from "../src/runlog.ts";
import type { GraphDoc } from "../src/graph.ts";
import type { Runner, TransformationDef } from "../src/runner.ts";

const graph: GraphDoc = {
  graph_id: "test",
  version: "1",
  nodes: [
    { id: "intent", type: "input", schema_id: "intent" },
    { id: "script", transformation: "dialogue_script_writer", in: ["intent"] },
    { id: "scenes", transformation: "cartoon_scene_compiler", in: ["script"] },
  ],
};

const transformations = new Map<string, TransformationDef>([
  [
    "dialogue_script_writer",
    {
      name: "dialogue_script_writer",
      kind: "agent",
      version: "7",
      consumes: [{ schema_id: "intent", as: "intent" }],
      produces: "script",
      prompt: "dialogue_script_writer@7",
      model: { capability: "reasoning_high" },
    },
  ],
  [
    "cartoon_scene_compiler",
    {
      name: "cartoon_scene_compiler",
      kind: "worker",
      version: "13",
      consumes: [{ schema_id: "script", as: "script" }],
      produces: "rendered_video",
      execute: async () => ({ payload: {} }),
    },
  ],
]);

async function record(
  runLog: MemoryRunLog,
  node_id: string,
  transformation: string,
  transformation_version: string,
  output: string,
  inputs: string[] = [],
  status: "ok" | "accepted_below_quality_bar" = "ok",
) {
  await runLog.record({
    run_id: "run_resume",
    graph_id: "test@1",
    node_id,
    transformation,
    transformation_version,
    inputs,
    output,
    status,
    attempt: 1,
    max_attempts: 1,
    started_at: "2026-08-22T00:00:00.000Z",
    duration_ms: 0,
    error: null,
  });
}

test("resume reruns stale transformation versions and prunes downstream completions", async () => {
  const runLog = new MemoryRunLog();
  await record(runLog, "intent", "input", "1", "intent_seed");
  await record(runLog, "script", "dialogue_script_writer", "6", "old_script", ["intent_seed"]);
  await record(runLog, "scenes", "cartoon_scene_compiler", "13", "old_scenes", ["old_script"]);

  const calls: Array<{ name: string; inputIds: string[] }> = [];
  const runner = {
    async run(def: TransformationDef, inputIds: string[]) {
      calls.push({ name: def.name, inputIds });
      return {
        artifact: { artifact_id: def.name === "dialogue_script_writer" ? "new_script" : "new_scenes" },
        runId: "run_resume",
        attempts: 1,
        deduped: false,
      };
    },
  } as unknown as Runner;

  const executor = new GraphExecutor({
    runner,
    runLog,
    store: {} as never,
    registry: {} as never,
    transformations,
    maxParallel: 1,
  });

  const result = await executor.resume(graph, "run_resume");

  assert.deepEqual(calls, [
    { name: "dialogue_script_writer", inputIds: ["intent_seed"] },
    { name: "cartoon_scene_compiler", inputIds: ["new_script"] },
  ]);
  assert.equal(result.status, "completed");
  assert.equal(result.outputs.intent, "intent_seed");
  assert.equal(result.outputs.script, "new_script");
  assert.equal(result.outputs.scenes, "new_scenes");
});

test("resume treats an accepted-below-quality-bar node as complete, not stale", async () => {
  // Real production bug: run_a1838b5d's script node's final attempt failed a
  // semantic gate but was accepted anyway (status "accepted_below_quality_bar")
  // so the run could keep going. Within that same drive() call, creative_direction
  // correctly consumed that script's artifact live (in-memory). But on the NEXT
  // resume, deriveCompleted only recognized "ok"/"cache_hit" as complete, so it
  // fell back to an older "ok" script record instead -- feeding a stale script
  // into the still-downstream "scenes" node while creative_direction (already
  // complete in the DB) kept referencing the newer one. A split-parentage bug
  // that only appears across a resume boundary.
  const runLog = new MemoryRunLog();
  await record(runLog, "intent", "input", "1", "intent_seed");
  await record(runLog, "script", "dialogue_script_writer", "7", "old_script", ["intent_seed"]);
  await record(runLog, "script", "dialogue_script_writer", "7", "new_script", ["intent_seed"], "accepted_below_quality_bar");

  const calls: Array<{ name: string; inputIds: string[] }> = [];
  const runner = {
    async run(def: TransformationDef, inputIds: string[]) {
      calls.push({ name: def.name, inputIds });
      return {
        artifact: { artifact_id: "new_scenes" },
        runId: "run_resume",
        attempts: 1,
        deduped: false,
      };
    },
  } as unknown as Runner;

  const executor = new GraphExecutor({
    runner,
    runLog,
    store: {} as never,
    registry: {} as never,
    transformations,
    maxParallel: 1,
  });

  const result = await executor.resume(graph, "run_resume");

  assert.deepEqual(calls, [{ name: "cartoon_scene_compiler", inputIds: ["new_script"] }]);
  assert.equal(result.outputs.script, "new_script");
});

test("resume reruns a downstream node whose only success was against a now-superseded upstream artifact", async () => {
  // Real production bug: a run's downstream node (quality_revision) succeeded
  // once against generation A's script. A forced retry regenerated the script
  // (generation B) and downstream ran fresh too -- but THIS TIME the
  // downstream node failed outright (no output, so deriveCompleted's scan
  // never removed its old success record for generation A -- only a "retry"
  // record does, and none was written for this node specifically). Resume
  // then treated the downstream node as complete via its stale generation-A
  // success, silently pairing generation B's script with generation A's
  // downstream output as if they were the same run.
  const runLog = new MemoryRunLog();
  await record(runLog, "intent", "input", "1", "intent_seed");
  await record(runLog, "script", "dialogue_script_writer", "7", "script_a", ["intent_seed"]);
  await record(runLog, "scenes", "cartoon_scene_compiler", "13", "scenes_from_a", ["script_a"]);
  // A forced retry regenerates the script (generation B) -- the retry marker
  // only names "script", not "scenes".
  await runLog.record({
    run_id: "run_resume", graph_id: "test@1", node_id: "script",
    transformation: "dialogue_script_writer", transformation_version: "7",
    inputs: [], output: null, status: "retry", attempt: 1, max_attempts: 1,
    started_at: "2026-08-22T00:01:00.000Z", duration_ms: 0, error: null,
  });
  await record(runLog, "script", "dialogue_script_writer", "7", "script_b", ["intent_seed"]);
  // "scenes" got a fresh attempt against script_b too, but it failed -- no
  // output, so it leaves no new completion record at all.
  await runLog.record({
    run_id: "run_resume", graph_id: "test@1", node_id: "scenes",
    transformation: "cartoon_scene_compiler", transformation_version: "13",
    inputs: ["script_b"], output: null, status: "schema_invalid", attempt: 1, max_attempts: 1,
    started_at: "2026-08-22T00:02:00.000Z", duration_ms: 0, error: "boom",
  });

  const calls: Array<{ name: string; inputIds: string[] }> = [];
  const runner = {
    async run(def: TransformationDef, inputIds: string[]) {
      calls.push({ name: def.name, inputIds });
      return {
        artifact: { artifact_id: "scenes_from_b" },
        runId: "run_resume",
        attempts: 1,
        deduped: false,
      };
    },
  } as unknown as Runner;

  const executor = new GraphExecutor({
    runner,
    runLog,
    store: {} as never,
    registry: {} as never,
    transformations,
    maxParallel: 1,
  });

  const result = await executor.resume(graph, "run_resume");

  // "scenes" must re-run against script_b, not resurface scenes_from_a.
  assert.deepEqual(calls, [{ name: "cartoon_scene_compiler", inputIds: ["script_b"] }]);
  assert.equal(result.outputs.script, "script_b");
  assert.equal(result.outputs.scenes, "scenes_from_b");
});

test("resume after a settled human_gate does not re-derive everything downstream of it", async () => {
  // Real production bug (run_1c6e2b42): a gate's own "ok" completion record was
  // always written with inputs: [] (the recordNode default), never the gate's
  // actual upstream artifact. pruneIncompleteDependencies compares recorded
  // inputs against the recomputed expected inputs on every resume(), and a
  // recorded [] against the gate's real 1-element expectation is a permanent
  // length mismatch -- so every settled gate looked stale on every single
  // resume() call, deleting it and everything downstream of it from
  // `completed`, and burning a full paid regeneration of the rest of the
  // graph each time the run was merely resumed (e.g. to retry an unrelated
  // failure further downstream, or to approve a later gate) even though
  // nothing the gate actually gated had changed.
  const gateGraph: GraphDoc = {
    graph_id: "test_gate",
    version: "1",
    nodes: [
      { id: "intent", type: "input", schema_id: "intent" },
      { id: "script", transformation: "dialogue_script_writer", in: ["intent"] },
      { id: "approve_script", type: "human_gate", in: ["script"] },
      { id: "scenes", transformation: "cartoon_scene_compiler", in: ["approve_script"] },
    ],
  };

  const runLog = new MemoryRunLog();
  // The shared record() helper above hardcodes graph_id "test@1" (for the
  // module-level `graph` used by the other tests in this file); deriveCompleted
  // filters records by graph_id, so this graph needs its own records written
  // directly against "test_gate@1".
  await runLog.record({
    run_id: "run_resume", graph_id: "test_gate@1", node_id: "intent",
    transformation: "input", transformation_version: "1", inputs: [],
    output: "intent_seed", status: "ok", attempt: 1, max_attempts: 1,
    started_at: "2026-08-22T00:00:00.000Z", duration_ms: 0, error: null,
  });
  await runLog.record({
    run_id: "run_resume", graph_id: "test_gate@1", node_id: "script",
    transformation: "dialogue_script_writer", transformation_version: "7", inputs: ["intent_seed"],
    output: "the_script", status: "ok", attempt: 1, max_attempts: 1,
    started_at: "2026-08-22T00:00:00.000Z", duration_ms: 0, error: null,
  });

  const calls: Array<{ name: string; inputIds: string[] }> = [];
  const runner = {
    // The real Runner records to runLog itself (this mock stands in for it),
    // so it must too -- otherwise a second resume() would always re-run every
    // transformation node regardless of what this test is actually checking.
    async run(def: TransformationDef, inputIds: string[]) {
      calls.push({ name: def.name, inputIds });
      const artifactId = def.name === "dialogue_script_writer" ? "the_script" : "the_scenes";
      await runLog.record({
        run_id: "run_resume", graph_id: "test_gate@1", node_id: def.name === "dialogue_script_writer" ? "script" : "scenes",
        transformation: def.name, transformation_version: def.version ?? "1", inputs: inputIds,
        output: artifactId, status: "ok", attempt: 1, max_attempts: 1,
        started_at: "2026-08-22T00:00:00.000Z", duration_ms: 0, error: null,
      });
      return {
        artifact: { artifact_id: artifactId },
        runId: "run_resume",
        attempts: 1,
        deduped: false,
      };
    },
  } as unknown as Runner;

  const executor = new GraphExecutor({
    runner,
    runLog,
    store: {} as never,
    registry: {} as never,
    transformations,
    maxParallel: 1,
  });

  // First resume: settles the gate via an explicit decision, then runs "scenes".
  const first = await executor.resume(gateGraph, "run_resume", { approve_script: { result: "approve" } });
  assert.equal(first.status, "completed");
  assert.deepEqual(calls, [{ name: "cartoon_scene_compiler", inputIds: ["the_script"] }]);

  // Second resume: nothing changed and no new decision is supplied. The gate
  // and "scenes" are both already complete in the run's history, so nothing
  // should re-run.
  calls.length = 0;
  const second = await executor.resume(gateGraph, "run_resume");
  assert.deepEqual(calls, []);
  assert.equal(second.status, "completed");
  assert.equal(second.outputs.scenes, "the_scenes");
});
