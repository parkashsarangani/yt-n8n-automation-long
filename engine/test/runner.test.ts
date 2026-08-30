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
import { MemoryRunLog, rollup } from "../src/runlog.ts";
import { ProviderRouter, ProviderRefusal, relaxForStructuredOutput } from "../src/provider.ts";
import { FakeProvider, type FakeHandler } from "../src/providers/fake.ts";
import { Runner, type WorkerDef } from "../src/runner.ts";
import { loadAgentDefs, validateCatalog, CatalogError } from "../src/catalog.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const STORY_PAYLOAD = {
  topic: "Why Chile is so incredibly long",
  title: "The Country That Refused To Stop",
  hook: "Chile is four thousand kilometres of coastline and almost no width.",
  acts: [
    { act_index: 0, act_title: "The shape", premise: "Establish the absurd geometry of it.", target_words: 300 },
    { act_index: 1, act_title: "The spine", premise: "The Andes drew the border before people did.", target_words: 300 },
    { act_index: 2, act_title: "The reach", premise: "Conquest stretched it further than planned.", target_words: 300 },
  ],
  payoff: "The shape is not politics. It is rock.",
  comment_hook: "Could you drive it in a week? Yes or no.",
  outro_line: "Send this to whoever thinks maps are boring.",
};

const SCRIPT_PAYLOAD = {
  scenes: [
    { scene_index: 0, act_index: 0, point: "open on the absurdity", narration: "Chile is longer than the distance from London to Baghdad." },
    { scene_index: 1, act_index: 1, point: "the mountains decided", narration: "The Andes drew this border long before any treaty did." },
  ],
  word_count: 24,
};

async function harness(handler: FakeHandler) {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-run-")), registry);
  const runLog = new MemoryRunLog();
  const provider = new FakeProvider(handler);
  const providers = new ProviderRouter({ reasoning_high: provider, reasoning_fast: provider });
  const runner = new Runner({ store, registry, prompts, providers, runLog, logger: silent(), blobs: new MemoryBlobStore() });
  const agents = await loadAgentDefs(path.join(ROOT, "agents"));
  return { registry, prompts, store, runLog, provider, runner, agents };
}

function silent() {
  return { log: () => { }, warn: () => { }, error: () => { } };
}

/** A throwaway registry with one unrestricted schema, for worker-path tests. */
async function tempRegistry(): Promise<SchemaRegistry> {
  const dir = await mkdtemp(path.join(tmpdir(), "vidgen-tmpschema-"));
  await mkdir(path.join(dir, "note"), { recursive: true });
  await writeFile(
    path.join(dir, "note", "1.0.0.json"),
    JSON.stringify({
      schema_id: "note",
      version: "1.0.0",
      status: "active",
      json_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string", minLength: 1 } },
      },
    }),
    "utf8",
  );
  return SchemaRegistry.load(dir);
}

async function seedIntent(h: Awaited<ReturnType<typeof harness>>) {
  const { artifact } = await h.store.put({
    schema_id: "intent",
    payload: { brief: "a documentary about why Chile is so incredibly long", target_duration_sec: 540 },
    produced_by: { transformation: "human", version: "1", run_id: "run_seed", provider: null },
  });
  return artifact;
}

/**
 * story_architect now also reads channel_insights, so every call seeds one.
 * The empty shape is deliberate: it is exactly what a channel with nothing
 * measured yet produces, and it must be a first-class case rather than a gap.
 */
async function seedInsights(h: Awaited<ReturnType<typeof harness>>) {
  const { artifact } = await h.store.put({
    schema_id: "channel_insights",
    payload: {
      sample_size: 0,
      confidence_note: "Nothing measured yet; no guidance can be supported.",
      guidance: [],
    },
    produced_by: { transformation: "channel_strategist", version: "1", run_id: "run_seed", provider: null },
  });
  return artifact;
}

test("the catalog loads every agent as pure data", async () => {
  const agents = await loadAgentDefs(path.join(ROOT, "agents"));
  assert.deepEqual(
    [...agents.keys()].sort(),
    [
      "cartoon_creative_director",
      "cartoon_thumbnail_designer",
      "cartoon_visual_planner",
      "channel_strategist",
      "comprehension_editor",
      "dialogue_script_writer",
      "discovery",
      "emotional_entertainment_editor",
      "explanation_plan_critic",
      "explanation_plan_reviser",
      "explanation_visual_planner",
      "retention_character_editor",
      "script_quality_critic",
      "script_quality_reviser",
      "script_writer",
      "seo_optimizer",
      "story_architect",
      "thumbnail_designer",
      "visual_planner",
    ],
  );
  for (const def of agents.values()) {
    // RFC 0004: agents declare capabilities, never vendors.
    assert.match(def.model.capability, /^reasoning_/);
    assert.equal(JSON.stringify(def).includes("claude"), false);
    assert.equal(JSON.stringify(def).includes("anthropic"), false);
  }
});

test("catalog is cross-checked against schemas and prompts at boot", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const agents = await loadAgentDefs(path.join(ROOT, "agents"));
  assert.doesNotThrow(() =>
    validateCatalog(agents, {
      hasSchema: (id) => registry.has(id),
      hasPrompt: (ref) => prompts.has(ref),
    }),
  );
  assert.throws(
    () => validateCatalog(agents, { hasSchema: () => true, hasPrompt: () => false }),
    CatalogError,
  );
});

test("THE CLAIM: two different agents run through one harness, no agent-specific code", async () => {
  const h = await harness((req) =>
    req.prompt.includes("head writer")
      ? { payload: STORY_PAYLOAD, confidence: { overall: 0.9 } }
      : { payload: SCRIPT_PAYLOAD, confidence: { overall: 0.82 } },
  );
  const intent = await seedIntent(h);

  const story = await h.runner.run(h.agents.get("story_architect")!, [intent.artifact_id, (await seedInsights(h)).artifact_id]);
  const script = await h.runner.run(h.agents.get("script_writer")!, [story.artifact.artifact_id]);

  assert.equal(story.artifact.schema_id, "story");
  assert.equal(script.artifact.schema_id, "script");
  // Provenance chains without anyone wiring it up.
  assert.deepEqual(script.artifact.parents, [story.artifact.artifact_id]);
  const ancestors = await h.store.lineage(script.artifact.artifact_id);
  // channel_insights is a parent of the story now — the feedback loop is part
  // of provenance, so a published video can be traced to the evidence that
  // shaped it, not just to the brief.
  assert.deepEqual(ancestors.map((a) => a.schema_id), ["story", "intent", "channel_insights"]);
});

test("confidence lands on the envelope and does not affect the content hash", async () => {
  const h1 = await harness(() => ({ payload: STORY_PAYLOAD, confidence: { overall: 0.95 } }));
  const h2 = await harness(() => ({ payload: STORY_PAYLOAD, confidence: { overall: 0.12 } }));
  const a = await h1.runner.run(h1.agents.get("story_architect")!, [(await seedIntent(h1)).artifact_id, (await seedInsights(h1)).artifact_id]);
  const b = await h2.runner.run(h2.agents.get("story_architect")!, [(await seedIntent(h2)).artifact_id, (await seedInsights(h2)).artifact_id]);

  assert.equal(a.artifact.confidence?.overall, 0.95);
  assert.equal(b.artifact.confidence?.overall, 0.12);
  assert.equal(a.artifact.artifact_id, b.artifact.artifact_id); // identity is content-only
  assert.equal("confidence" in (a.artifact.payload as object), false);
});

test("an invalid output is retried, and the retry prompt carries the errors", async () => {
  const h = await harness((_req, attempt) =>
    attempt === 0
      ? { payload: { ...STORY_PAYLOAD, acts: [] }, confidence: { overall: 0.7 } } // too few acts
      : { payload: STORY_PAYLOAD, confidence: { overall: 0.88 } },
  );
  const intent = await seedIntent(h);
  const out = await h.runner.run(h.agents.get("story_architect")!, [intent.artifact_id, (await seedInsights(h)).artifact_id]);

  assert.equal(out.attempts, 2);
  assert.equal(h.provider.calls.length, 2);
  // A retry MUST differ from the attempt that failed (RFC 0003).
  const [first, second] = h.provider.calls;
  assert.notEqual(first!.prompt, second!.prompt);
  assert.match(second!.prompt, /previous attempt was rejected/i);
  assert.match(second!.prompt, /acts/);

  const records = await h.runLog.all();
  assert.deepEqual(records.map((r) => r.status), ["schema_invalid", "ok"]);
  assert.equal(records[0]!.retry_reason, "schema");
  assert.equal(records[1]!.output, out.artifact.artifact_id);
});

test("a missing confidence.overall is retried like any other invalid output", async () => {
  // Real production bug: unwrap() (which checks confidence.overall) used to
  // be called OUTSIDE the try/catch that drives the retry-with-feedback
  // loop, so a model response with a missing/malformed confidence.overall
  // threw immediately on attempt 1 regardless of max_attempts -- no
  // run_records entry, no retry, no chance for the model to see and fix it.
  // A real run needed a manual top-level retry every single time this
  // happened. This response is syntactically fine JSON, just missing the
  // envelope field unwrap() requires.
  const h = await harness((_req, attempt) =>
    attempt === 0
      ? ({ payload: STORY_PAYLOAD, confidence: {} } as unknown as { payload: unknown; confidence: { overall: number } })
      : { payload: STORY_PAYLOAD, confidence: { overall: 0.88 } },
  );
  const intent = await seedIntent(h);
  const out = await h.runner.run(h.agents.get("story_architect")!, [intent.artifact_id, (await seedInsights(h)).artifact_id]);

  assert.equal(out.attempts, 2);
  assert.equal(h.provider.calls.length, 2);
  assert.match(h.provider.calls[1]!.prompt, /previous attempt was rejected/i);
  assert.match(h.provider.calls[1]!.prompt, /confidence\.overall/);

  const records = await h.runLog.all();
  assert.deepEqual(records.map((r) => r.status), ["schema_invalid", "ok"]);
  assert.match(records[0]!.error ?? "", /confidence\.overall/);
});

test("an invalid output never becomes an artifact, even after exhausting retries", async () => {
  const h = await harness(() => ({ payload: { ...STORY_PAYLOAD, acts: [] }, confidence: { overall: 0.5 } }));
  const intent = await seedIntent(h);
  const insights = await seedInsights(h);

  await assert.rejects(
    () => h.runner.run(h.agents.get("story_architect")!, [intent.artifact_id, insights.artifact_id]),
    /invalid story after 3 attempts/,
  );
  // Only the two seeded inputs — no story artifact was written. That is the
  // claim: three failed attempts leave nothing behind but run-log entries.
  const stored = await h.store.index();
  assert.deepEqual(stored.map((r) => r.schema_id).sort(), ["channel_insights", "intent"]);
  assert.equal(
    stored.filter((r) => r.schema_id === "story").length,
    0,
    "an invalid output must never be stored",
  );
  assert.equal((await h.runLog.all()).length, 3);
});

test("a refusal is not retried", async () => {
  const h = await harness(() => ({ __refuse: "cyber" }));
  const intent = await seedIntent(h);
  const insights = await seedInsights(h);

  await assert.rejects(
    () => h.runner.run(h.agents.get("story_architect")!, [intent.artifact_id, insights.artifact_id]),
    ProviderRefusal,
  );
  assert.equal(h.provider.calls.length, 1); // no point re-asking the same question
  assert.equal((await h.runLog.all())[0]!.status, "provider_refusal");
});

test("inputs are validated on read against the declared schema", async () => {
  const h = await harness(() => ({ payload: SCRIPT_PAYLOAD, confidence: { overall: 0.8 } }));
  const intent = await seedIntent(h);
  // script_writer consumes a story, not an intent.
  await assert.rejects(
    () => h.runner.run(h.agents.get("script_writer")!, [intent.artifact_id]),
    /expected schema "story"/,
  );
  assert.equal(h.provider.calls.length, 0); // fails before spending a token
});

test("the producer allowlist blocks a transformation that is not declared", async () => {
  // Found by an earlier version of the worker test below: `script` lists only
  // script_writer, so any other producer — including a legitimate deterministic
  // one — is refused. See the RFC 0007 note in engine/README.md.
  const h = await harness(() => ({ payload: STORY_PAYLOAD, confidence: { overall: 0.9 } }));
  const intent = await seedIntent(h);
  const story = await h.runner.run(h.agents.get("story_architect")!, [intent.artifact_id, (await seedInsights(h)).artifact_id]);

  const impostor: WorkerDef = {
    name: "act_counter",
    kind: "worker",
    consumes: [{ schema_id: "story", range: "^1", as: "story" }],
    produces: "script",
    async execute() {
      // Deliberately schema-VALID, so the allowlist is what rejects this and
      // not an incidental validation failure.
      return { payload: { scenes: [{ scene_index: 0, point: "open", narration: "hello there" }] } };
    },
  };

  await assert.rejects(
    () => h.runner.run(impostor, [story.artifact.artifact_id]),
    /may not produce script/,
  );
});

test("workers run through the same harness and are given no model", async () => {
  // Uses a temp schema with no produced_by restriction, so this exercises the
  // worker path rather than the allowlist (which the test above covers).
  const registry = await tempRegistry();
  const store = await FsArtifactStore.open(
    await mkdtemp(path.join(tmpdir(), "vidgen-worker-")),
    registry,
  );
  const runner = new Runner({
    store,
    registry,
    prompts: await PromptStore.load(path.join(ROOT, "prompts")),
    providers: new ProviderRouter({}),
    runLog: new MemoryRunLog(),
    logger: silent(),
    blobs: new MemoryBlobStore(),
  });

  const seed = await store.put({
    schema_id: "note",
    payload: { text: "the andes drew this border" },
    produced_by: { transformation: "human", version: "1", run_id: "run_seed", provider: null },
  });

  let sawContext: Record<string, unknown> = {};
  const shouter: WorkerDef = {
    name: "shouter",
    kind: "worker",
    version: "1",
    consumes: [{ schema_id: "note", range: "^1", as: "note" }],
    produces: "note",
    async execute(inputs, ctx) {
      sawContext = ctx as unknown as Record<string, unknown>;
      const note = inputs["note"]!.payload as { text: string };
      return { payload: { text: note.text.toUpperCase() } };
    },
  };

  const out = await runner.run(shouter, [seed.artifact.artifact_id]);
  assert.equal((out.artifact.payload as { text: string }).text, "THE ANDES DREW THIS BORDER");
  assert.equal(out.artifact.produced_by.provider, null); // workers have no provider
  // RFC 0001 rule 1, enforced structurally: I/O yes, model no.
  assert.deepEqual(Object.keys(sawContext).sort(), ["attemptNumber", "blobs", "logger", "media", "progress"]);
  assert.equal("model" in sawContext, false);
  assert.equal("providers" in sawContext, false);
  assert.deepEqual(Object.keys(sawContext["media"] as object), []);

  // Deterministic: the same worker over the same input is a cache hit.
  const again = await runner.run(shouter, [seed.artifact.artifact_id]);
  assert.equal(again.deduped, true);
  assert.equal(again.artifact.artifact_id, out.artifact.artifact_id);
});

test("run log rolls up cost per transformation", async () => {
  const h = await harness((req) =>
    req.prompt.includes("head writer")
      ? { payload: STORY_PAYLOAD, confidence: { overall: 0.9 } }
      : { payload: SCRIPT_PAYLOAD, confidence: { overall: 0.8 } },
  );
  const intent = await seedIntent(h);
  const story = await h.runner.run(h.agents.get("story_architect")!, [intent.artifact_id, (await seedInsights(h)).artifact_id]);
  await h.runner.run(h.agents.get("script_writer")!, [story.artifact.artifact_id]);

  const summary = rollup(await h.runLog.all());
  assert.deepEqual(Object.keys(summary.by_transformation).sort(), [
    "script_writer",
    "story_architect",
  ]);
  assert.ok(summary.output_tokens > 0);
  assert.equal(summary.first_pass_rate, 1);
  assert.equal(summary.retry_attempts, 0);
  assert.deepEqual(summary.retries_by_reason, {});
});

test("structured-output projection strips unenforceable constraints but keeps them as guidance", () => {
  const relaxed = relaxForStructuredOutput({
    type: "array",
    minItems: 3,
    maxItems: 6,
    items: { type: "string", minLength: 2, description: "a term" },
  }) as Record<string, unknown>;

  assert.equal("minItems" in relaxed, false);
  assert.equal("maxItems" in relaxed, false);
  assert.match(String(relaxed["description"]), /at least 3 items.*at most 6 items/);
  const items = relaxed["items"] as Record<string, unknown>;
  assert.equal("minLength" in items, false);
  assert.match(String(items["description"]), /a term \(at least 2 characters\)/);
  assert.equal(items["type"], "string"); // structure itself survives
});
