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
      produces: "asset_manifest",
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
) {
  await runLog.record({
    run_id: "run_resume",
    graph_id: "test@1",
    node_id,
    transformation,
    transformation_version,
    inputs,
    output,
    status: "ok",
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
