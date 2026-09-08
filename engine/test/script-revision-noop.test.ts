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
import { Runner, type AgentDef } from "../src/runner.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const STORY = {
  topic: "A warning no one noticed",
  title: "The Warning Everyone Missed",
  hook: "The alarm had been blinking for hours before anyone understood why.",
  acts: [
    { act_index: 0, act_title: "Warning", premise: "A quiet warning appears.", target_words: 40 },
    { act_index: 1, act_title: "Cost", premise: "Ignoring it makes the problem concrete.", target_words: 40 },
    { act_index: 2, act_title: "Turn", premise: "One action changes the outcome.", target_words: 40 },
  ],
  payoff: "The tiny warning was the only cheap chance to act.",
  comment_hook: "Would you have noticed it?",
  outro_line: "Watch what happens next.",
};

const PRIOR_SCRIPT = {
  scenes: [
    { scene_index: 0, point: "warning", narration: "A tiny red light blinked in the empty room." },
    { scene_index: 1, point: "cost", narration: "By the time anyone noticed, the machine had stopped." },
    { scene_index: 2, point: "outro", narration: "Watch what happens next.", is_outro: true },
  ],
  word_count: 27,
};

const CHANGED_SCRIPT = {
  scenes: [
    { scene_index: 0, point: "warning", narration: "A red warning light was already blinking when the machine began to fail." },
    { scene_index: 1, point: "cost", narration: "Nobody acted, and minutes later the entire line stopped." },
    { scene_index: 2, point: "outro", narration: "Watch what happens next.", is_outro: true },
  ],
  word_count: 29,
};

const GROWTH = {
  premise: "A tiny ignored warning becomes an expensive failure.",
  target_audience: "viewers who like compact consequence stories",
  curiosity_gap: "why did nobody react before the failure?",
  emotional_engine: "dread from an avoidable consequence",
  selected_title: "The Warning Everyone Missed",
  selected_thumbnail_concept: "one red warning light beside a stopped machine",
  opening_visual: "a red indicator blinking in an otherwise still factory",
  opening_line: "The warning was already blinking before anyone looked up.",
  first_30_seconds: {
    promise: "show the ignored warning and escalating cost",
    zero_to_five: "show the blinking warning immediately",
    five_to_fifteen: "show people continuing to ignore it",
    fifteen_to_thirty: "show the machine stopping and the cost becoming real",
  },
  variants: [
    { family: "curiosity", title: "The Warning Everyone Missed", thumbnail_concept: "red warning light", click_reason: "unanswered warning" },
    { family: "conflict", title: "Nobody Stopped the Machine", thumbnail_concept: "worker beside alarm", click_reason: "avoidable conflict" },
    { family: "reversal", title: "The Small Light That Stopped Everything", thumbnail_concept: "tiny light huge machine", click_reason: "scale reversal" },
  ],
  scores: { clickability: 0.8, story_potential: 0.8, audience_size: 0.7 },
  selection_rationale: "The selected package makes the consequence visible immediately and supports a compact causal story.",
};

const REPORT = {
  verdict: "revise",
  scores: {
    hook: 0.80, first_30_fidelity: 0.72, package_fidelity: 0.86, suspense: 0.70,
    watchability: 0.80, entertainment: 0.76, payoff: 0.80, youtube_fit: 0.80,
  },
  weakest_dimension: "hook",
  summary: "Scene 0 states the warning but does not make the consequence feel immediate enough to stop a cold viewer.",
  abandon_recommended: false,
  abandon_reason: "",
};

function runRecord(node_id: string, transformation: string, output: string, inputs: string[]) {
  return {
    run_id: "run_revision", graph_id: "illustrated_story", node_id, transformation,
    transformation_version: "1", inputs, output, status: "ok", attempt: 1, max_attempts: 1,
    provider: null, model: null, prompt_ref: null, usage: null, confidence: null,
    started_at: new Date(0).toISOString(), duration_ms: 1, error: null, retry_reason: null,
  } as any;
}

test("critic-guided identical script is rejected before cache_hit and the next in-agent attempt must change it", async () => {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const prompts = await PromptStore.load(path.join(ROOT, "prompts"));
  const store = await FsArtifactStore.open(await mkdtemp(path.join(tmpdir(), "vidgen-revision-noop-")), registry);
  const runLog = new MemoryRunLog();

  const put = async (schema_id: string, payload: unknown, transformation: string) => (await store.put({
    schema_id,
    payload,
    produced_by: { transformation, version: "1", run_id: "run_revision", provider: null },
  })).artifact;
  const story = await put("story", STORY, "narrative_story_architect");
  const growth = await put("growth_package", GROWTH, "growth_packager");
  const intent = await put("intent", { brief: "Tell a 60 second warning story", target_duration_sec: 60 }, "human");
  const prior = await put("script", PRIOR_SCRIPT, "narration_script_writer");
  const report = await put("watchability_report", REPORT, "watchability_critic");

  await runLog.record(runRecord("draft_script", "narration_script_writer", prior.artifact_id, [story.artifact_id, growth.artifact_id, intent.artifact_id]));
  await runLog.record(runRecord("watchability_report", "watchability_critic", report.artifact_id, [story.artifact_id, prior.artifact_id, growth.artifact_id, intent.artifact_id]));

  const provider = new FakeProvider((_req, attempt) => ({
    payload: attempt === 0 ? PRIOR_SCRIPT : CHANGED_SCRIPT,
    confidence: { overall: 0.9 },
  }));
  const runner = new Runner({
    store, registry, prompts,
    providers: new ProviderRouter({ reasoning_high: provider }),
    runLog,
    logger: { log() {}, warn() {}, error() {} },
    blobs: new MemoryBlobStore(),
  });
  const def: AgentDef = {
    name: "narration_script_writer",
    kind: "agent",
    version: "6",
    revision_input: "watchability",
    consumes: [
      { schema_id: "story", range: "^1", as: "story" },
      { schema_id: "growth_package", range: "^1", as: "growth", optional: true },
      { schema_id: "intent", range: "^1", as: "intent" },
    ],
    produces: "script",
    produces_version: "1.7.0",
    prompt: "narration_script_writer@6",
    model: { capability: "reasoning_high", max_output_tokens: 14000 },
    confidence_dimensions: ["prose_quality", "pacing", "payoff_delivery", "first_30_fidelity"],
    retry: { max_attempts: 3 },
  };

  const out = await runner.run(def, [story.artifact_id, growth.artifact_id, intent.artifact_id], {
    runId: "run_revision", graphId: "illustrated_story", nodeId: "draft_script",
  });

  assert.equal(out.attempts, 2);
  assert.equal(out.deduped, false);
  assert.deepEqual(out.artifact.payload, CHANGED_SCRIPT);
  assert.equal(provider.calls.length, 2);
  assert.match(provider.calls[1]!.prompt, /previous attempt was rejected/i);
  assert.match(provider.calls[1]!.prompt, /revision was a no-op|identical to previous_script/i);

  const records = (await runLog.all()).filter((r) => r.node_id === "draft_script").slice(1);
  assert.equal(records[0]!.status, "schema_invalid");
  assert.match(records[0]!.error ?? "", /no-op/i);
  assert.equal(records[1]!.status, "ok");
  assert.equal(records.some((r) => r.status === "cache_hit"), false);
  assert.equal(out.artifact.parents.length, 4, "story + growth + intent + immutable revision sidecar");
});
