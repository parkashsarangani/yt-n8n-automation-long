/** Discovery memory + RFC 0009 package-tournament contract tests. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SchemaRegistry } from "../src/registry.ts";
import { PromptStore } from "../src/prompts.ts";
import { FsArtifactStore } from "../src/store.ts";
import { MemoryBlobStore } from "../src/blobs.ts";
import { MemoryRunLog } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { Runner, type TransformationDef } from "../src/runner.ts";
import { loadAgentDefs } from "../src/catalog.ts";
import { GraphExecutor } from "../src/executor.ts";
import { loadGraph, validateGraph } from "../src/graph.ts";
import { buildTopicHistory } from "../src/topic-history.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = () => ({ log: () => {}, warn: () => {}, error: () => {} });
const NOW = () => new Date("2026-08-15T12:00:00.000Z");
let seq = 0;
async function open() {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-disc-")), registry);
  const put = (schema_id: string, payload: unknown, producer: string, parents: string[] = []) =>
    store.put({ schema_id, payload, parents, produced_by: { transformation: producer, version: "1", run_id: `run_${seq++}`, provider: null } }).then((r) => r.artifact);
  return { registry, store, put };
}
const STORY = (topic: string, title: string) => ({
  topic, title,
  hook: "A hook long enough to satisfy the schema minimum length.",
  acts: [
    { act_index: 0, act_title: "One", premise: "The first act premise, long enough.", target_words: 300 },
    { act_index: 1, act_title: "Two", premise: "The second act premise, long enough.", target_words: 300 },
    { act_index: 2, act_title: "Three", premise: "The third act premise, long enough.", target_words: 300 },
  ],
  payoff: "The payoff sentence.", outro_line: "Send this to someone who argues about maps.",
});
const retentionNulls = { retention_curve: null, retention_5s: null, retention_15s: null, retention_30s: null };

test("an empty store yields an empty, valid history", async () => {
  const { registry, store } = await open();
  const h = await buildTopicHistory(store, { now: NOW });
  assert.equal(h.count, 0); assert.deepEqual(h.topics, []);
  assert.doesNotThrow(() => registry.validate("topic_history", "1.0.0", h));
});

test("unpublished topics still count as covered ground", async () => {
  const { registry, store, put } = await open();
  await put("story", STORY("why chile is so long", "The Long Country"), "story_architect");
  const h = await buildTopicHistory(store, { now: NOW });
  assert.equal(h.count, 1); assert.equal(h.topics[0]!.published, false); assert.equal(h.topics[0]!.views, undefined);
  assert.doesNotThrow(() => registry.validate("topic_history", "1.0.0", h));
});

test("a published topic carries how it did", async () => {
  const { registry, store, put } = await open();
  const story = await put("story", STORY("why chile is so long", "The Long Country"), "story_architect");
  const published = await put("published_episode", { target: "youtube", external_id: "vid1", url: "https://www.youtube.com/watch?v=vid1", title: "The Long Country", published_at: "2026-07-01T00:00:00.000Z" }, "publish", [story.artifact_id]);
  await put("episode_performance", {
    external_id: "vid1", source: "youtube-analytics", window: { start_date: "2026-07-18", end_date: "2026-08-14", days: 28 }, measured_at: "2026-08-15T00:00:00.000Z",
    metrics: { views: 4200, estimated_minutes_watched: 900, average_view_duration_sec: 240, average_view_percentage: 63.5, subscribers_gained: 11, likes: 40, comments: 3, shares: 1, impressions: null, click_through_rate: null, ...retentionNulls, unavailable: [] },
  }, "measure", [published.artifact_id]);
  const h = await buildTopicHistory(store, { now: NOW });
  assert.equal(h.topics[0]!.published, true); assert.equal(h.topics[0]!.views, 4200); assert.equal(h.topics[0]!.average_view_percentage, 63.5);
  assert.doesNotThrow(() => registry.validate("topic_history", "1.0.0", h));
});

test("the same topic reworded is not listed twice", async () => {
  const { store, put } = await open();
  await put("story", STORY("Why Chile Is So Long", "Variant Alpha"), "story_architect");
  await put("story", STORY("why chile is so long", "Variant Bravo"), "story_architect");
  assert.equal((await buildTopicHistory(store, { now: NOW })).count, 1);
});

test("excluded videos contribute no performance to the history", async () => {
  const { store, put } = await open();
  const story = await put("story", STORY("an excluded test upload topic", "Test Upload"), "story_architect");
  const published = await put("published_episode", { target: "youtube", external_id: "testvid", url: "https://www.youtube.com/watch?v=testvid", title: "Test Upload", published_at: "2026-07-01T00:00:00.000Z" }, "publish", [story.artifact_id]);
  await put("episode_performance", {
    external_id: "testvid", source: "youtube-analytics", window: { start_date: "2026-07-18", end_date: "2026-08-14", days: 28 }, measured_at: "2026-08-15T00:00:00.000Z",
    metrics: { views: 23138, estimated_minutes_watched: 1, average_view_duration_sec: 1, average_view_percentage: 82.8, subscribers_gained: 0, likes: 0, comments: 0, shares: 0, impressions: null, click_through_rate: null, ...retentionNulls, unavailable: [] },
  }, "measure", [published.artifact_id]);
  const h = await buildTopicHistory(store, { exclude: new Set(["testvid"]), now: NOW });
  assert.equal(h.count, 1); assert.equal(h.topics[0]!.published, true); assert.equal(h.topics[0]!.views, undefined);
});

function candidate(i: number) {
  return {
    brief: `Tell a complete underestimation story candidate ${i} where an ordinary worker faces a concrete consequence and the final reversal changes how the opening is understood`,
    genre: "moral_story" as const,
    angle: `Candidate ${i} focuses on a specific visible mistake and earned reversal`,
    target_audience: "Adults who enjoy relatable workplace and social reversal stories",
    curiosity_gap: `Why the apparently weak person in candidate ${i} was actually prepared`,
    emotional_engine: "underestimation to anxiety to vindication",
    opening_visual: `A dismissed worker standing beside a visibly failing machine while everyone else turns away, variation ${i}`,
    opening_line: `Everyone walked past the one person who already knew what was about to break, variation ${i}.`,
    title_concepts: [
      { family: "curiosity" as const, title: `The Worker Nobody Listened To — Candidate ${i}` },
      { family: "conflict" as const, title: `They Laughed at Him Until It Broke — ${i}` },
      { family: "reversal" as const, title: `The Quiet Worker Was Right All Along — ${i}` },
    ],
    thumbnail_concepts: [
      { family: "curiosity" as const, concept: `Ignored worker beside a failing machine, everyone looking elsewhere, version ${i}` },
      { family: "conflict" as const, concept: `Boss dismissing worker while warning light glows behind them, version ${i}` },
      { family: "reversal" as const, concept: `Same worker calmly repairing machine as shocked coworkers watch, version ${i}` },
    ],
    scores: { clickability: 0.72, story_potential: 0.74, audience_size: 0.76, overall: 0.74 },
    why_it_earns_attention: "Immediate social tension, a visible failure, and a reversal viewers can anticipate without knowing the mechanism.",
    novelty: `Distinct concrete setup ${i}; not a duplicate of covered ground.`,
  };
}
const CANDIDATES = { basis: "No measured episodes yet, so these rankings are editorial judgement rather than channel evidence.", candidates: Array.from({ length: 20 }, (_, i) => candidate(i + 1)) };
const INSIGHTS = { sample_size: 0, confidence_note: "Nothing measured yet; no guidance can be supported.", guidance: [], editorial_memory: [] };
const EMPTY_WINDOW = {
  generated_at: NOW().toISOString(), episode_count: 0, ctr_available: false, retention_available: false,
  aggregates: { median_views: 0, median_view_percentage: null, median_ctr: null, median_retention_5s: null, median_retention_15s: null, median_retention_30s: null, total_subscribers_gained: 0 }, episodes: [],
};

test("the discover graph is valid and self-contained", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const agents = await loadAgentDefs(path.join(ROOT, "agents")) as Map<string, TransformationDef>;
  const graph = await loadGraph(path.join(ROOT, "graphs", "discover.json"));
  assert.doesNotThrow(() => validateGraph(graph, { registry, transformations: agents }));
  assert.equal(graph.graph_id, "discover");
});

test("discovery runs end to end on an empty channel and emits the 20-package growth tournament", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-disc-run-")), registry);
  const runLog = new MemoryRunLog();
  const provider = new FakeProvider((req) =>
    req.prompt.includes("propose what this channel should make next") || req.prompt.includes("complete audience propositions")
      ? { payload: CANDIDATES, confidence: { overall: 0.6 } }
      : { payload: INSIGHTS, confidence: { overall: 0.4 } });
  const runner = new Runner({ store, registry, prompts: await PromptStore.load(path.join(ROOT, "prompts")), providers: new ProviderRouter({ reasoning_high: provider, reasoning_fast: provider }), runLog, logger: silent(), blobs: new MemoryBlobStore() });
  const agents = await loadAgentDefs(path.join(ROOT, "agents")) as Map<string, TransformationDef>;
  const executor = new GraphExecutor({ runner, runLog, store, registry, transformations: agents, logger: silent() });
  const graph = await loadGraph(path.join(ROOT, "graphs", "discover.json"));
  const seed = async (schema_id: string, payload: unknown) => (await store.put({ schema_id, payload, produced_by: { transformation: "human", version: "1", run_id: "seed", provider: null } })).artifact.artifact_id;
  const result = await executor.start(graph, { history: await seed("topic_history", { generated_at: NOW().toISOString(), count: 0, topics: [] }), performance: await seed("performance_window", EMPTY_WINDOW) });
  assert.equal(result.status, "completed");
  const out = await store.get(result.outputs["candidates"]!);
  const payload = out!.payload as typeof CANDIDATES;
  assert.equal(out!.schema_version, "2.0.0");
  assert.equal(payload.candidates.length, 20);
  assert.deepEqual(payload.candidates[0]!.title_concepts.map((v) => v.family), ["curiosity", "conflict", "reversal"]);
  assert.equal(provider.calls.length, 2);
});

test("the discovery agent reads v2 editorial memory and emits v2 candidate packages", async () => {
  const d = (await loadAgentDefs(path.join(ROOT, "agents"))).get("discovery")!;
  assert.deepEqual(d.consumes.map((c) => [c.schema_id, c.range]), [["topic_history", "^1"], ["channel_insights", "^2"]]);
  assert.equal(d.produces, "topic_candidates"); assert.equal(d.produces_version, "2.0.0");
});

test("historical topic_candidates@1 still rejects a candidate without an angle", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const bad = { basis: "Some basis text that is long enough.", candidates: [{ brief: "Explain the Panama Canal in general terms", why_it_earns_attention: "x".repeat(12), novelty: "new" }] };
  assert.throws(() => registry.validate("topic_candidates", "1.0.0", bad), /angle/);
});
