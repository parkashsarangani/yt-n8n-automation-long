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
import {
  FakeProvider,
  FakeSpeechProvider,
  FakeImageProvider,
  FakeRenderer,
  FakePublishTarget,
  type FakeHandler,
} from "../src/providers/fake.ts";
import { Runner, type TransformationDef, type WorkerDef } from "../src/runner.ts";
import { loadAgentDefs } from "../src/catalog.ts";
import { allTransformations, defaultWorkers } from "../src/workers/index.ts";
import { GraphExecutor, ExecutorError } from "../src/executor.ts";
import { loadGraph, validateGraph, type GraphDoc } from "../src/graph.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log: () => { }, warn: () => { }, error: () => { } });

const STORY = {
  topic: "Why Chile is so incredibly long",
  title: "The Country That Refused To Stop",
  hook: "Four thousand kilometres of coastline and almost no width.",
  acts: [
    { act_index: 0, act_title: "The shape", premise: "Establish the absurd geometry.", target_words: 300 },
    { act_index: 1, act_title: "The spine", premise: "The Andes drew the border first.", target_words: 300 },
    { act_index: 2, act_title: "The reach", premise: "Conquest stretched it further.", target_words: 300 },
  ],
  payoff: "The shape is not politics. It is rock.",
  outro_line: "Send this to whoever thinks maps are boring.",
};

const SCRIPT = {
  scenes: [
    { scene_index: 0, act_index: 0, point: "open", narration: "Chile is longer than London to Baghdad." },
  ],
};

const VISUAL_PLAN = {
  scenes: [
    {
      scene_index: 0,
      search_terms: ["aerial coastline at dawn", "andes ridge line", "empty desert highway"],
      visual_style: "vivid explanatory documentary",
      fallback_terms: ["mountain range", "coastal landscape"],
    },
  ],
};

async function harness(handler: FakeHandler) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-exec-")), registry);
  const runLog = new MemoryRunLog();
  const provider = new FakeProvider(handler);
  const speech = new FakeSpeechProvider();
  const images = new FakeImageProvider();
  const renderer = new FakeRenderer();
  const runner = new Runner({
    store,
    registry,
    prompts,
    providers: new ProviderRouter({ reasoning_high: provider, reasoning_fast: provider }),
    runLog,
    logger: silent(),
    blobs: new MemoryBlobStore(),
    media: { speech, images, renderer },
  });
  const agents = (await loadAgentDefs(path.join(ROOT, "agents"))) as Map<string, TransformationDef>;
  const transformations = allTransformations(
    agents,
    defaultWorkers({
      voice: { voiceId: "test-voice" },
      publish: { target: new FakePublishTarget() },
    }),
  );
  const executor = new GraphExecutor({
    runner,
    runLog,
    store,
    registry,
    transformations,
    logger: silent(),
  });
  const graph = await loadGraph(path.join(ROOT, "graphs", "skeleton.json"));
  validateGraph(graph, { registry, transformations });

  const seed = await store.put({
    schema_id: "intent",
    payload: { brief: "why Chile is so incredibly long", target_duration_sec: 540 },
    produced_by: { transformation: "human", version: "1", run_id: "seed", provider: null },
  });

  return { registry, store, runLog, provider, speech, images, renderer, runner, executor, graph, transformations, seed };
}

/** Routes on each prompt's opening line, so all three agents get valid output. */
const storyThen = (conf: number): FakeHandler => (req) => {
  if (req.prompt.includes("head writer")) return { payload: STORY, confidence: { overall: conf } };
  if (req.prompt.includes("choose what the viewer sees")) {
    return { payload: VISUAL_PLAN, confidence: { overall: 0.85 } };
  }
  return { payload: SCRIPT, confidence: { overall: 0.8 } };
};

const ALL_NODES = [
  "approve_script", "approve_story", "assets", "intent", "publish", "render",
  "script", "story", "visual_plan", "voice",
];
/** Everything downstream of the story gate. */
const AFTER_GATE = [
  "approve_script", "assets", "publish", "render", "script", "visual_plan", "voice",
];
/** Everything downstream of the script gate. */
const AFTER_SCRIPT_GATE = ["assets", "publish", "render", "visual_plan", "voice"];
/** story, script, visual_plan are agents; voice and assets are workers (no model call). */
const MODEL_CALLS_PER_RUN = 3;

test("a confident story auto-passes its gate, then the script gate always asks", async () => {
  const h = await harness(storyThen(0.95));
  const result = await h.executor.start(h.graph, { intent: h.seed.artifact.artifact_id });

  // The story gate has an auto-pass policy; the script gate deliberately has
  // none, so narration is always reviewed before any paid media work.
  assert.equal(result.outputs["approve_story"], result.outputs["story"]);
  assert.equal(result.status, "waiting");
  assert.deepEqual(result.waiting.map((w) => w.node_id), ["approve_script"]);
  assert.deepEqual([...result.blocked].sort(), AFTER_SCRIPT_GATE);
  assert.deepEqual(result.failures, []);
});

test("approving the script gate runs the rest of the graph to completion", async () => {
  const h = await harness(storyThen(0.95));
  const first = await h.executor.start(h.graph, { intent: h.seed.artifact.artifact_id });
  const done = await h.executor.resume(h.graph, first.run_id, {
    approve_script: { result: "approve" },
  });

  assert.equal(done.status, "completed");
  assert.deepEqual(Object.keys(done.outputs).sort(), ALL_NODES);
  // The script gate is an identity pass-through too.
  assert.equal(done.outputs["approve_script"], done.outputs["script"]);
});

test("a low-confidence story parks the run at the gate", async () => {
  const h = await harness(storyThen(0.4));
  const result = await h.executor.start(h.graph, { intent: h.seed.artifact.artifact_id });

  assert.equal(result.status, "waiting");
  assert.equal(result.waiting.length, 1);
  assert.equal(result.waiting[0]!.node_id, "approve_story");
  assert.match(result.waiting[0]!.reason, /auto-pass predicate not met/);
  // Downstream work was not attempted, so no tokens were spent on it.
  assert.deepEqual([...result.blocked].sort(), AFTER_GATE);
  assert.equal(result.outputs["script"], undefined);
  assert.equal(h.provider.calls.length, 1);
  assert.equal(h.speech.calls.length, 0);
  assert.equal(h.images.prompts.length, 0);
});

test("resuming with approval continues without re-running completed nodes", async () => {
  const h = await harness(storyThen(0.4));
  const first = await h.executor.start(h.graph, { intent: h.seed.artifact.artifact_id });
  assert.equal(first.status, "waiting");

  const resumed = await h.executor.resume(h.graph, first.run_id, {
    approve_story: { result: "approve" },
  });

  // Parks again at the script gate — narration is always reviewed.
  assert.equal(resumed.status, "waiting");
  assert.deepEqual(resumed.waiting.map((w) => w.node_id), ["approve_script"]);
  assert.equal(resumed.outputs["story"], first.outputs["story"]); // derived, not recomputed
  // The story was not re-run: only the script cost a model call this time.
  assert.equal(h.provider.calls.length, 2);

  const done = await h.executor.resume(h.graph, first.run_id, {
    approve_script: { result: "approve" },
  });
  assert.equal(done.status, "completed");
  assert.equal(h.provider.calls.length, MODEL_CALLS_PER_RUN);
  // Workers ran too, producing real bytes.
  assert.ok(h.speech.calls.length > 0);
  assert.ok(h.images.prompts.length > 0);
});

test("resuming with a rejection retries the upstream transformation", async () => {
  const h = await harness(storyThen(0.4));
  const first = await h.executor.start(h.graph, { intent: h.seed.artifact.artifact_id });
  // First attempt produced a story; gate waits because confidence < 0.9.
  assert.equal(first.status, "waiting");
  assert.equal(h.provider.calls.length, 1);

  // Reject → upstream reruns, then gate parks again (new story, still < 0.9).
  const resumed = await h.executor.resume(h.graph, first.run_id, {
    approve_story: { result: "reject", reason: "hook is weak" },
  });

  assert.equal(resumed.status, "waiting");
  // The story_architect ran again (2 calls total now).
  assert.equal(h.provider.calls.length, 2);
  // The gate is waiting again with the new artifact.
  assert.equal(resumed.waiting.length, 1);
  assert.equal(resumed.waiting[0]!.node_id, "approve_story");
});

test("seeds are validated against the input node's schema before anything runs", async () => {
  const h = await harness(storyThen(0.95));
  await assert.rejects(
    () => h.executor.start(h.graph, {}),
    /needs a seed for input "intent"/,
  );
  // A seed of the wrong type fails at the boundary, not mid-run.
  const wrong = await h.store.put({
    schema_id: "story",
    payload: STORY,
    produced_by: { transformation: "story_architect", version: "1", run_id: "x", provider: null },
  });
  await assert.rejects(
    () => h.executor.start(h.graph, { intent: wrong.artifact.artifact_id }),
    /expected schema "intent"/,
  );
  assert.equal(h.provider.calls.length, 0);
});

test("reuse:true picks up a matching output from an earlier run", async () => {
  const h = await harness(storyThen(0.95));
  const started = await h.executor.start(h.graph, { intent: h.seed.artifact.artifact_id });
  const first = await h.executor.resume(h.graph, started.run_id, {
    approve_script: { result: "approve" },
  });
  assert.equal(h.provider.calls.length, MODEL_CALLS_PER_RUN);

  const reusing: GraphDoc = {
    ...h.graph,
    nodes: h.graph.nodes.map((n) =>
      n.id === "story" ? { ...n, reuse: true } : n,
    ) as GraphDoc["nodes"],
  };
  const startedAgain = await h.executor.start(reusing, { intent: h.seed.artifact.artifact_id });
  const second = await h.executor.resume(reusing, startedAgain.run_id, {
    approve_script: { result: "approve" },
  });

  assert.equal(second.status, "completed");
  assert.equal(second.outputs["story"], first.outputs["story"]);
  // Story was reused; only script and visual_plan cost calls. (Agents are not
  // cached by default — re-running is how variants happen — so this is opt-in.)
  assert.equal(h.provider.calls.length, MODEL_CALLS_PER_RUN + 2);
});

// -- failure isolation, on a throwaway registry so the producer allowlist
//    does not get in the way of building an arbitrary test topology.

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
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-exec2-")), registry);
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
  const executor = new GraphExecutor({ runner, runLog, store, registry, transformations, logger: silent() });
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
  // The healthy branch ran to completion anyway.
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
  // Both were attempted in the same pass; edges are the only parallelism hint.
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
