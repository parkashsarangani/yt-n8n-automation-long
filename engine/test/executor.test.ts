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
import { validateGraph, type GraphDoc } from "../src/graph.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log: () => { }, warn: () => { }, error: () => { } });

/**
 * Executor mechanics are tested against a deliberately tiny synthetic graph.
 * Product-graph behaviour belongs in graph.test.ts and cartoon-production.test.ts.
 * Keeping a second full end-to-end copy of the old stock-video skeleton here
 * caused CI to encode obsolete product assumptions whenever the production graph
 * evolved. These tests now cover only the executor invariants themselves.
 */
async function tempSetup() {
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-execschema-"));
  for (const id of ["a", "b"]) {
    await mkdir(path.join(dir, id), { recursive: true });
    await writeFile(
      path.join(dir, id, "1.0.0.json"),
      JSON.stringify({
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
      }),
      "utf8",
    );
  }

  const registry = await SchemaRegistry.load(dir);
  const store = await FsArtifactStore.open(
    await mkdtemp(path.join(tmpdir(), "vidgen-exec-")),
    registry,
  );
  const runLog = new MemoryRunLog();

  const passthrough = (name: string, from: string, to: string): WorkerDef => ({
    name,
    kind: "worker",
    consumes: [{ schema_id: from, range: "^1", as: "x" }],
    produces: to,
    async execute(inputs) {
      return { payload: { v: `${name}:${(inputs["x"]!.payload as { v: string }).v}` } };
    },
  });

  const boom: WorkerDef = {
    name: "boom",
    kind: "worker",
    consumes: [{ schema_id: "a", range: "^1", as: "x" }],
    produces: "b",
    async execute() {
      throw new Error("worker exploded");
    },
  };

  const transformations = new Map<string, TransformationDef>([
    ["ok1", passthrough("ok1", "a", "b")],
    ["ok2", passthrough("ok2", "b", "a")],
    ["boom", boom],
    ["after_boom", passthrough("after_boom", "b", "a")],
  ]);

  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog,
    logger: silent(),
    blobs: new MemoryBlobStore(),
  });
  const executor = new GraphExecutor({
    runner,
    runLog,
    store,
    registry,
    transformations,
    logger: silent(),
  });
  const seed = await store.put({
    schema_id: "a",
    payload: { v: "seed" },
    produced_by: { transformation: "human", version: "1", run_id: "s", provider: null },
  });

  return { registry, store, runLog, transformations, executor, seed };
}

test("a failed node blocks only its own subtree; independent branches finish", async () => {
  const t = await tempSetup();
  const graph: GraphDoc = {
    graph_id: "fanout",
    version: "1",
    nodes: [
      { id: "seed", type: "input", schema_id: "a" },
      { id: "ok1", transformation: "ok1", in: ["seed"] },
      { id: "ok2", transformation: "ok2", in: ["ok1"] },
      { id: "boom", transformation: "boom", in: ["seed"] },
      { id: "after_boom", transformation: "after_boom", in: ["boom"] },
    ],
  };
  validateGraph(graph, { registry: t.registry, transformations: t.transformations });

  const result = await t.executor.start(graph, { seed: t.seed.artifact.artifact_id });

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.failures.map((f) => f.node_id), ["boom"]);
  assert.match(result.failures[0]!.error, /worker exploded/);
  assert.ok(result.outputs["ok1"]);
  assert.ok(result.outputs["ok2"]);
  assert.deepEqual(result.blocked, ["after_boom"]);
});

test("independent nodes are executed together without declaring parallelism", async () => {
  const t = await tempSetup();
  const graph: GraphDoc = {
    graph_id: "parallel",
    version: "1",
    nodes: [
      { id: "seed", type: "input", schema_id: "a" },
      { id: "left", transformation: "ok1", in: ["seed"] },
      { id: "right", transformation: "boom", in: ["seed"] },
    ],
  };

  const result = await t.executor.start(graph, { seed: t.seed.artifact.artifact_id });
  assert.ok(result.outputs["left"]);
  assert.deepEqual(result.failures.map((f) => f.node_id), ["right"]);
});

test("an unknown transformation fails the node rather than the process", async () => {
  const t = await tempSetup();
  const graph: GraphDoc = {
    graph_id: "unknown",
    version: "1",
    nodes: [
      { id: "seed", type: "input", schema_id: "a" },
      { id: "ghost", transformation: "not_registered", in: ["seed"] },
    ],
  };

  const result = await t.executor.start(graph, { seed: t.seed.artifact.artifact_id });
  assert.equal(result.status, "blocked");
  assert.match(result.failures[0]!.error, /unknown transformation/);
});

test("ExecutorError is thrown for a missing seed", async () => {
  const t = await tempSetup();
  const graph: GraphDoc = {
    graph_id: "seedless",
    version: "1",
    nodes: [{ id: "seed", type: "input", schema_id: "a" }],
  };

  await assert.rejects(() => t.executor.start(graph, {}), ExecutorError);
});

test("regenerateNode() forces one node to re-run on the next resume(), and cascades to everything downstream of it", async () => {
  // Real production use: VidGenService.driveUnattended() calls this on
  // "assets" after a qa_report flags blank scenes, to force just that node
  // (and render/qa/publish, which consumed its now-superseded artifact)
  // to re-run -- without disturbing anything the qa report didn't flag.
  const t = await tempSetup();
  let calls = 0;
  t.transformations.set("counting", {
    name: "counting",
    kind: "worker",
    consumes: [{ schema_id: "a", range: "^1", as: "x" }],
    produces: "b",
    async execute(inputs) {
      calls++;
      return { payload: { v: `call${calls}:${(inputs["x"]!.payload as { v: string }).v}` } };
    },
  });

  const graph: GraphDoc = {
    graph_id: "regen",
    version: "1",
    nodes: [
      { id: "seed", type: "input", schema_id: "a" },
      { id: "n1", transformation: "counting", in: ["seed"] },
      { id: "n2", transformation: "ok2", in: ["n1"] },
    ],
  };

  const first = await t.executor.start(graph, { seed: t.seed.artifact.artifact_id }, { runId: "run_regen" });
  assert.equal(first.status, "completed");
  assert.equal(calls, 1);

  await t.executor.regenerateNode(graph, "run_regen", "n1", "test forcing regeneration");
  const second = await t.executor.resume(graph, "run_regen", {});

  assert.equal(second.status, "completed");
  assert.equal(calls, 2, "n1 actually re-ran, not just re-marked complete");
  assert.notEqual(second.outputs["n1"], first.outputs["n1"], "n1 got a genuinely new artifact");
  assert.notEqual(second.outputs["n2"], first.outputs["n2"], "n2 cascaded to a fresh artifact built on the new n1, not the stale one");
});

test("regenerateNode() rejects an unknown or non-transformation node id", async () => {
  const t = await tempSetup();
  const graph: GraphDoc = {
    graph_id: "regen-invalid",
    version: "1",
    nodes: [{ id: "seed", type: "input", schema_id: "a" }],
  };

  await assert.rejects(() => t.executor.regenerateNode(graph, "run_x", "seed", "reason"), ExecutorError);
  await assert.rejects(() => t.executor.regenerateNode(graph, "run_x", "ghost", "reason"), ExecutorError);
});
