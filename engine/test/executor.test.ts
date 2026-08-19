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

const CAST_ROSTER = {
  characters: [
    {
      character_id: "host",
      name: "Host",
      voice_id: "test-host-voice",
      rig: "pilot",
      personality: "skeptical, observant, dry humor",
      visual_description: "Young adult 2D cartoon host with short dark hair, warm medium skin, blue overshirt and a compact angular silhouette.",
      thumbnail_traits: "Large readable eyes and brows with a strong head silhouette.",
      color_palette: ["#4C89C6", "#F2C7A5", "#111111"],
    },
    {
      character_id: "buddy",
      name: "Buddy",
      voice_id: "test-buddy-voice",
      rig: "pilot-2",
      personality: "curious, energetic, asks the obvious question",
      visual_description: "Second recurring 2D cartoon character with a clearly different silhouette and teal clothing accents.",
      thumbnail_traits: "Energetic open expressions and clear surprise at small size.",
      color_palette: ["#6FB8B2", "#F2C7A5", "#111111"],
    },
  ],
  default_voice_id: "test-host-voice",
};

const SCRIPT = {
  scenes: [
    {
      scene_index: 0,
      act_index: 0,
      point: "open",
      narration: "Chile is longer than London to Baghdad.",
      speaker: "host",
      emotion: "surprised",
    },
  ],
  word_count: 7,
};

const VISUAL_PLAN = {
  scenes: [
    {
      scene_index: 0,
      search_terms: ["classroom", "map", "cartoon interior"],
      visual_style: "clean thick-outline 2D cartoon classroom",
      fallback_terms: ["classroom", "interior"],
      template_category: "cartoon",
      template_data: JSON.stringify({
        background: { location: "classroom", variant: "normal", tone: "dramatic" },
        camera: { type: "static" },
        characters: [
          {
            characterId: "pilot",
            animationKey: "host",
            x: 660,
            y: 300,
            scale: 1.2,
            isSpeaking: true,
            expression: "surprised",
            gazeX: 0,
            gazeY: 0,
          },
        ],
      }),
    },
  ],
};

async function harness(handler: FakeHandler) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-exec-"));
  const store = await FsArtifactStore.open(dir, registry);
  const castPath = path.join(dir, "cast.json");
  await writeFile(castPath, JSON.stringify(CAST_ROSTER), "utf8");
  process.env["CARTOON_CAST_PATH"] = castPath;

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
      dialogueVoice: { defaultVoiceId: "test-voice" },
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
    // 15s is the schema minimum, and the fake renderer reports scenes.length*12
    // — so one scene gives a 12s video, 20% off target and inside QA's 25%
    // tolerance. A 540s target would fail every fixture episode on duration and
    // mask whatever each test is actually about.
    payload: { brief: "why Chile is so incredibly long", target_duration_sec: 15 },
    produced_by: { transformation: "human", version: "1", run_id: "seed", provider: null },
  });

  // An empty performance window: what a channel with nothing measured looks
  // like, and the state every first run starts in.
  const perfSeed = await store.put({
    schema_id: "performance_window",
    payload: {
      generated_at: "2026-08-15T12:00:00.000Z",
      episode_count: 0,
      ctr_available: false,
      aggregates: {
        median_views: 0,
        median_view_percentage: null,
        median_ctr: null,
        total_subscribers_gained: 0,
      },
      episodes: [],
    },
    produced_by: { transformation: "human", version: "1", run_id: "seed", provider: null },
  });

  const inputs = {
    intent: seed.artifact.artifact_id,
    performance: perfSeed.artifact.artifact_id,
  };

  return { registry, store, runLog, provider, speech, images, renderer, runner, executor, graph, transformations, seed, perfSeed, inputs };
}

const INSIGHTS = {
  sample_size: 0,
  confidence_note: "Nothing measured yet; no guidance can be supported.",
  guidance: [],
};

const SEO = {
  title: "Why Chile Is So Absurdly Long (It Is Not Politics)",
  description:
    "Why is Chile so long? The Andes drew the border millions of years before " +
    "any treaty did. Here is how a mountain range decided a country's shape.",
  tags: ["why is chile so long", "chile geography", "andes", "borders", "maps"],
  primary_keyword: "why is chile so long",
  rationale: "Targets the literal question; the dialogue answers it directly.",
};

const THUMBNAIL_BRIEF = {
  mode: "cartoon",
  text: "HOW IS THIS REAL?",
  emphasis: "THIS REAL",
  art_prompt:
    "Create a 16:9 long-form YouTube thumbnail in the channel's clean recurring 2D cartoon style. Show the host on the right staring in disbelief at an absurdly long map of Chile as the single hero object. Reserve the left side as quiet negative space for typography. Use thick dark outlines, simple readable shapes, expressive eyes and brows, strong silhouette, flat controlled shading and disciplined saturated colours. Do not render words, letters, captions, signs, logos, arrows, circles, UI labels or watermarks.",
  accent: "#FFD34D",
  visual_hook: "The host stares in disbelief at a map whose extreme shape looks almost impossible.",
  character_ids: ["host"],
  preferred_text_side: "left",
  rationale: "One large reaction plus one impossible-looking object communicates the curiosity gap immediately.",
  alternatives: ["THAT'S ONE COUNTRY?", "WHY SO LONG?"],
};

/** Routes on each prompt's opening/content line, so every agent gets valid output. */
const storyThen = (conf: number): FakeHandler => (req) => {
  if (req.prompt.includes("head writer")) return { payload: STORY, confidence: { overall: conf } };
  if (req.prompt.includes("director for a cartoon-animation episode")) {
    return { payload: VISUAL_PLAN, confidence: { overall: 0.85 } };
  }
  if (req.prompt.includes("design the thumbnail")) {
    return { payload: THUMBNAIL_BRIEF, confidence: { overall: 0.82 } };
  }
  if (req.prompt.includes("how this episode appears in search")) {
    return { payload: SEO, confidence: { overall: 0.8 } };
  }
  if (req.prompt.includes("say what that")) {
    return { payload: INSIGHTS, confidence: { overall: 0.5 } };
  }
  return { payload: SCRIPT, confidence: { overall: 0.8 } };
};

/**
 * The shipped graph runs unattended, so gate *mechanics* — waiting, rejecting,
 * resuming — are exercised against a supervised copy. Testing them against the
 * live graph would mean the day someone re-enables review, the machinery that
 * implements it has no coverage.
 */
function supervised(graph: GraphDoc): GraphDoc {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === "approve_story"
        ? { ...n, policy: { auto_pass_if: "confidence.overall >= 0.9" } }
        : n.id === "approve_script"
          ? { ...n, policy: undefined }
          : n,
    ) as GraphDoc["nodes"],
  };
}

const ALL_NODES = [
  "approve_publish", "approve_script", "approve_story", "assets", "cast_roster", "insights",
  "intent", "performance", "publish", "qa", "render", "script", "seo", "story",
  "thumbnail", "thumbnail_brief", "visual_plan", "voice",
];
/** Everything downstream of the story gate. */
const AFTER_GATE = [
  "approve_publish", "approve_script", "assets", "publish", "qa", "render",
  "script", "seo", "thumbnail", "thumbnail_brief", "visual_plan", "voice",
];
/** Everything downstream of the script gate. */
const AFTER_SCRIPT_GATE = [
  "approve_publish", "assets", "publish", "qa", "render", "seo", "thumbnail",
  "thumbnail_brief", "visual_plan", "voice",
];
/** channel_strategist, story, script, visual_plan, cartoon_thumbnail_designer, seo_optimizer. */
const MODEL_CALLS_PER_RUN = 6;

test("THE SHIPPED GRAPH RUNS UNATTENDED: no gate can park it", async () => {
  // The operator's choice: the private upload is the review. A gate that parks
  // the run would leave nothing to review at all, so both gates must pass on
  // their own — including for a story the model is not confident about, which
  // is exactly the case a threshold would have stalled.
  const h = await harness(storyThen(0.2));
  const result = await h.executor.start(h.graph, h.inputs);

  assert.equal(result.status, "completed", `unattended run parked: ${JSON.stringify(result.waiting)}`);
  assert.deepEqual(result.waiting, []);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(Object.keys(result.outputs).sort(), ALL_NODES);

  // The gates still exist and still pass the artifact through untouched, so
  // putting a human back is a one-line policy change, not a graph rebuild.
  assert.equal(result.outputs["approve_story"], result.outputs["story"]);
  assert.equal(result.outputs["approve_script"], result.outputs["script"]);
});

test("a broken episode stops at the QA gate instead of publishing", async () => {
  // The counterpart to the unattended test: gates never park on human judgement,
  // but they DO park on a measurable defect. Here the intent asks for 600s and
  // the fake renderer produces 12s, which QA fails on duration.
  const h = await harness(storyThen(0.95));
  const longIntent = await h.store.put({
    schema_id: "intent",
    payload: { brief: "why Chile is so incredibly long", target_duration_sec: 600 },
    produced_by: { transformation: "human", version: "1", run_id: "seed", provider: null },
  });

  const result = await h.executor.start(h.graph, {
    ...h.inputs,
    intent: longIntent.artifact.artifact_id,
  });

  assert.equal(result.status, "waiting");
  assert.deepEqual(result.waiting.map((w) => w.node_id), ["approve_publish"]);
  assert.match(result.waiting[0]!.reason, /verdict/);

  // Nothing was published, and the report says why in a readable way.
  assert.equal(result.outputs["publish"], undefined);
  const report = await h.store.get(result.outputs["qa"]!);
  const payload = report!.payload as { verdict: string; checks: Array<{ id: string; status: string }> };
  assert.equal(payload.verdict, "fail");
  assert.equal(payload.checks.find((c) => c.id === "duration")!.status, "fail");
});

test("a confident story auto-passes its gate, then the script gate always asks", async () => {
  const h = await harness(storyThen(0.95));
  const result = await h.executor.start(supervised(h.graph), h.inputs);

  // The story gate has an auto-pass policy; the script gate deliberately has
  // none, so dialogue is reviewed before voice, art and rendering work.
  assert.equal(result.outputs["approve_story"], result.outputs["story"]);
  assert.equal(result.status, "waiting");
  assert.deepEqual(result.waiting.map((w) => w.node_id), ["approve_script"]);
  assert.deepEqual([...result.blocked].sort(), AFTER_SCRIPT_GATE);
  assert.deepEqual(result.failures, []);
});

test("approving the script gate runs the rest of the graph to completion", async () => {
  const h = await harness(storyThen(0.95));
  const g = supervised(h.graph);
  const first = await h.executor.start(g, h.inputs);
  const done = await h.executor.resume(g, first.run_id, {
    approve_script: { result: "approve" },
  });

  assert.equal(done.status, "completed");
  assert.deepEqual(Object.keys(done.outputs).sort(), ALL_NODES);
  // The script gate is an identity pass-through too.
  assert.equal(done.outputs["approve_script"], done.outputs["script"]);
});

test("a low-confidence story parks the run at the gate", async () => {
  const h = await harness(storyThen(0.4));
  const result = await h.executor.start(supervised(h.graph), h.inputs);

  assert.equal(result.status, "waiting");
  assert.equal(result.waiting.length, 1);
  assert.equal(result.waiting[0]!.node_id, "approve_story");
  assert.match(result.waiting[0]!.reason, /auto-pass predicate not met/);
  // Downstream work was not attempted, so no tokens were spent on it.
  assert.deepEqual([...result.blocked].sort(), AFTER_GATE);
  assert.equal(result.outputs["script"], undefined);
  // Two calls: the strategist reads past performance, then the story is
  // written against it. Nothing downstream of the gate was attempted.
  assert.equal(h.provider.calls.length, 2);
  assert.equal(h.speech.calls.length, 0);
  assert.equal(h.images.prompts.length, 0);
});

test("resuming with approval continues without re-running completed nodes", async () => {
  const h = await harness(storyThen(0.4));
  const g = supervised(h.graph);
  const first = await h.executor.start(g, h.inputs);
  assert.equal(first.status, "waiting");

  const resumed = await h.executor.resume(g, first.run_id, {
    approve_story: { result: "approve" },
  });

  // Parks again at the script gate — dialogue is always reviewed in this
  // supervised copy. The thumbnail intentionally waits for approved dialogue
  // because its visual hook must reflect an event that actually occurs.
  assert.equal(resumed.status, "waiting");
  assert.deepEqual(resumed.waiting.map((w) => w.node_id), ["approve_script"]);
  assert.equal(resumed.outputs["story"], first.outputs["story"]); // derived, not recomputed
  assert.equal(h.provider.calls.length, 3); // strategist + story + dialogue script
  assert.equal(resumed.outputs["thumbnail_brief"], undefined);

  const done = await h.executor.resume(g, first.run_id, {
    approve_script: { result: "approve" },
  });
  assert.equal(done.status, "completed");
  assert.equal(h.provider.calls.length, MODEL_CALLS_PER_RUN);
  // Workers ran too, producing real bytes.
  assert.ok(h.speech.calls.length > 0);
  // Cartoon scene assets are templates, so the only generated image is the
  // thumbnail artwork.
  assert.equal(h.images.prompts.length, 1);
});

test("resuming with a rejection retries the upstream transformation", async () => {
  const h = await harness(storyThen(0.4));
  const g = supervised(h.graph);
  const first = await h.executor.start(g, h.inputs);
  // First attempt produced a story; gate waits because confidence < 0.9.
  assert.equal(first.status, "waiting");
  assert.equal(h.provider.calls.length, 2); // strategist + story

  // Reject → upstream reruns, then gate parks again (new story, still < 0.9).
  const resumed = await h.executor.resume(g, first.run_id, {
    approve_story: { result: "reject", reason: "hook is weak" },
  });

  assert.equal(resumed.status, "waiting");
  // The story_architect ran again. The strategist did not: its output is
  // already complete and a rejection upstream of it changes nothing.
  assert.equal(h.provider.calls.length, 3);
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
  const started = await h.executor.start(h.graph, h.inputs);
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
  const startedAgain = await h.executor.start(reusing, h.inputs);
  const second = await h.executor.resume(reusing, startedAgain.run_id, {
    approve_script: { result: "approve" },
  });

  assert.equal(second.status, "completed");
  assert.equal(second.outputs["story"], first.outputs["story"]);
  // Story was reused; the strategist, dialogue script, visual plan, cartoon
  // thumbnail designer and seo optimizer still cost calls.
  assert.equal(h.provider.calls.length, MODEL_CALLS_PER_RUN + 5);
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
