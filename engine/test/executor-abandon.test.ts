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
import { GraphExecutor } from "../src/executor.ts";
import type { GraphDoc } from "../src/graph.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("abandon is terminal and never regenerates the upstream creative artifact", async () => {
  const schemas = await mkdtemp(path.join(tmpdir(), "vidgen-abandon-schema-"));
  for (const id of ["a", "b"]) {
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
        properties: { v: { type: "string" } }
      }
    }), "utf8");
  }

  const registry = await SchemaRegistry.load(schemas);
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-abandon-store-")), registry);
  const runLog = new MemoryRunLog();
  let creativeCalls = 0;

  const creative: WorkerDef = {
    name: "creative",
    kind: "worker",
    consumes: [{ schema_id: "a", range: "^1", as: "x" }],
    produces: "b",
    async execute(inputs) {
      creativeCalls++;
      return { payload: { v: `creative-${creativeCalls}:${(inputs["x"]!.payload as { v: string }).v}` } };
    }
  };
  const downstream: WorkerDef = {
    name: "downstream",
    kind: "worker",
    consumes: [{ schema_id: "b", range: "^1", as: "x" }],
    produces: "a",
    async execute(inputs) {
      return { payload: { v: `downstream:${(inputs["x"]!.payload as { v: string }).v}` } };
    }
  };
  const transformations = new Map<string, TransformationDef>([["creative", creative], ["downstream", downstream]]);
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
  const seed = await store.put({
    schema_id: "a",
    payload: { v: "seed" },
    produced_by: { transformation: "human", version: "1", run_id: "seed", provider: null },
  });
  const graph: GraphDoc = {
    graph_id: "abandon",
    version: "1",
    nodes: [
      { id: "seed", type: "input", schema_id: "a" },
      { id: "creative", transformation: "creative", in: ["seed"] },
      { id: "creative_viability", type: "human_gate", in: ["creative"] },
      { id: "expensive_downstream", transformation: "downstream", in: ["creative_viability"] },
    ]
  };

  const first = await executor.start(graph, { seed: seed.artifact.artifact_id }, { runId: "run_abandon" });
  assert.equal(first.status, "waiting");
  assert.equal(creativeCalls, 1);
  assert.equal(first.waiting[0]?.node_id, "creative_viability");

  const abandoned = await executor.resume(graph, "run_abandon", {
    creative_viability: { result: "abandon", reason: "premise is structurally weak" },
  });

  assert.equal(abandoned.status, "blocked");
  assert.equal(creativeCalls, 1, "terminal abandonment must not regenerate the critic/upstream artifact");
  assert.equal(abandoned.outputs["expensive_downstream"], undefined, "nothing downstream of the abandoned gate may run");
  assert.ok(abandoned.blocked.includes("expensive_downstream"));
  assert.match(abandoned.failures.find((f) => f.node_id === "creative_viability")?.error ?? "", /^abandoned: premise is structurally weak$/);

  const persisted = runLog.records.find((r) => r.node_id === "creative_viability" && r.status === "failed");
  assert.ok(persisted, "terminal abandonment is persisted so restart cannot turn it back into a waiting run");
  assert.match(persisted?.error ?? "", /^abandoned:/);
});
