import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { MemoryBlobStore } from "../src/blobs.ts";
import { MemoryRunLog } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { Runner, type TransformationDef, type WorkerDef } from "../src/runner.ts";
import { GraphExecutor, ExecutorError } from "../src/executor.ts";
import type { GraphDoc } from "../src/graph.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const schemas = await mkdtemp(path.join(tmpdir(), "vidgen-preset-schema-"));
  for (const id of ["a", "b", "c"]) {
    await mkdir(path.join(schemas, id), { recursive: true });
    await writeFile(path.join(schemas, id, "1.0.0.json"), JSON.stringify({
      schema_id: id,
      version: "1.0.0",
      status: "active",
      json_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["v"],
        properties: { v: { type: "string" } },
      },
    }), "utf8");
  }

  const registry = await SchemaRegistry.load(schemas);
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-preset-store-")), registry);
  const runLog = new MemoryRunLog();
  let authoredCalls = 0;

  const authored: WorkerDef = {
    name: "authored",
    kind: "worker",
    consumes: [{ schema_id: "a", range: "^1", as: "x" }],
    produces: "b",
    async execute(inputs) {
      authoredCalls++;
      return { payload: { v: `generated:${(inputs["x"]!.payload as { v: string }).v}` } };
    },
  };
  const downstream: WorkerDef = {
    name: "downstream",
    kind: "worker",
    consumes: [{ schema_id: "b", range: "^1", as: "x" }],
    produces: "c",
    async execute(inputs) {
      return { payload: { v: `downstream:${(inputs["x"]!.payload as { v: string }).v}` } };
    },
  };
  const transformations = new Map<string, TransformationDef>([["authored", authored], ["downstream", downstream]]);
  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog,
    logger: { log() {}, warn() {}, error() {} },
    blobs: new MemoryBlobStore(),
  });
  const executor = new GraphExecutor({
    runner,
    runLog,
    store,
    registry,
    transformations,
    logger: { log() {}, warn() {}, error() {} },
  });
  const graph: GraphDoc = {
    graph_id: "preset",
    version: "1",
    nodes: [
      { id: "seed", type: "input", schema_id: "a" },
      { id: "authored", transformation: "authored", in: ["seed"] },
      { id: "downstream", transformation: "downstream", in: ["authored"] },
    ],
  };
  return { registry, store, runLog, executor, graph, authoredCalls: () => authoredCalls };
}

test("preset transformation output skips execution but preserves graph lineage", async () => {
  const { store, runLog, executor, graph, authoredCalls } = await fixture();
  const seed = await store.put({
    schema_id: "a",
    payload: { v: "seed" },
    produced_by: { transformation: "human", version: "1", run_id: "seed", provider: null },
  });
  const preset = await store.put({
    schema_id: "b",
    payload: { v: "operator-authored" },
    produced_by: { transformation: "human", version: "1", run_id: "run_preset", provider: null },
  });

  const result = await executor.start(
    graph,
    { seed: seed.artifact.artifact_id },
    { runId: "run_preset", presetOutputs: { authored: preset.artifact.artifact_id } },
  );

  assert.equal(result.status, "completed");
  assert.equal(authoredCalls(), 0, "pre-authored node must not spend a generation call");
  assert.equal(result.outputs["authored"], preset.artifact.artifact_id);

  const downstream = await store.require(result.outputs["downstream"]!, { schema_id: "c" });
  assert.equal((downstream.payload as { v: string }).v, "downstream:operator-authored");

  const record = runLog.records.find((r) => r.node_id === "authored" && r.status === "ok");
  assert.ok(record, "preset output must be recorded as the current graph node completion");
  assert.equal(record?.transformation, "authored");
  assert.equal(record?.output, preset.artifact.artifact_id);
  assert.deepEqual(record?.inputs, [seed.artifact.artifact_id], "preset completion must retain real upstream lineage");
});

test("preset output rejects wrong schema and non-transformation targets before execution", async () => {
  const { store, executor, graph, authoredCalls } = await fixture();
  const seed = await store.put({
    schema_id: "a",
    payload: { v: "seed" },
    produced_by: { transformation: "human", version: "1", run_id: "seed", provider: null },
  });

  await assert.rejects(
    executor.start(graph, { seed: seed.artifact.artifact_id }, {
      runId: "run_bad_schema",
      presetOutputs: { authored: seed.artifact.artifact_id },
    }),
  );
  await assert.rejects(
    executor.start(graph, { seed: seed.artifact.artifact_id }, {
      runId: "run_bad_target",
      presetOutputs: { seed: seed.artifact.artifact_id },
    }),
    (err: unknown) => err instanceof ExecutorError && /not a transformation node/.test(err.message),
  );
  assert.equal(authoredCalls(), 0);
});
