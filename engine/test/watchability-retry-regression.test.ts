import test from "node:test";
import assert from "node:assert/strict";

import { Runner, type AgentDef } from "../src/runner.ts";
import { MemoryRunLog } from "../src/runlog.ts";
import { ProviderRouter } from "../src/provider.ts";
import { FakeProvider } from "../src/providers/fake.ts";

function artifact(id: string, schemaId: string, payload: unknown) {
  return {
    artifact_id: id,
    schema_id: schemaId,
    schema_version: schemaId === "watchability_report" ? "2.0.0" : schemaId === "script" ? "1.7.0" : "1.0.0",
    payload,
    produced_by: { transformation: "test", version: "1", run_id: "run_retry", provider: null },
    parents: [],
    confidence: null,
    created_at: new Date(0).toISOString(),
    labels: {},
  } as any;
}

const priorScript = {
  scenes: [
    { scene_index: 0, point: "hook", narration: "The door was already open." },
    { scene_index: 1, point: "turn", narration: "Then the alarm started." },
    { scene_index: 2, point: "outro", narration: "Watch what happens next.", is_outro: true },
  ],
  word_count: 15,
};

const revisedScript = {
  scenes: [
    { scene_index: 0, point: "hook", narration: "The alarm started before he touched the open door." },
    { scene_index: 1, point: "turn", narration: "Now leaving was the dangerous choice." },
    { scene_index: 2, point: "outro", narration: "Watch what happens next.", is_outro: true },
  ],
  word_count: 20,
};

test("critic-guided identical output is an internal retry, not a cache-hit outer attempt", async () => {
  const storyId = "sha256:" + "1".repeat(64);
  const growthId = "sha256:" + "2".repeat(64);
  const intentId = "sha256:" + "3".repeat(64);
  const priorScriptId = "sha256:" + "4".repeat(64);
  const reportId = "sha256:" + "5".repeat(64);
  const revisionId = "sha256:" + "6".repeat(64);
  const revisedId = "sha256:" + "7".repeat(64);

  const entries = new Map<string, any>([
    [storyId, artifact(storyId, "story", { topic: "test" })],
    [growthId, artifact(growthId, "growth_package", { selected_title: "test" })],
    [intentId, artifact(intentId, "intent", { brief: "compact production probe", target_duration_sec: 60 })],
    [priorScriptId, artifact(priorScriptId, "script", priorScript)],
    [reportId, artifact(reportId, "watchability_report", {
      verdict: "revise",
      abandon_recommended: false,
      abandon_reason: "",
      weakest_dimension: "hook",
      summary: "The opening states a condition but creates no immediate consequence.",
      scores: {
        hook: 0.80, first_30_fidelity: 0.72, package_fidelity: 0.86, suspense: 0.68,
        watchability: 0.80, entertainment: 0.76, payoff: 0.80, youtube_fit: 0.80,
      },
    })],
  ]);

  const store = {
    require: async (id: string) => {
      const value = entries.get(id);
      if (!value) throw new Error(`missing ${id}`);
      return value;
    },
    get: async (id: string) => entries.get(id) ?? null,
    put: async (input: any) => {
      if (input.schema_id === "script_revision_context") {
        const value = artifact(revisionId, "script_revision_context", input.payload);
        entries.set(revisionId, value);
        return { artifact: value, deduped: false };
      }
      if (input.schema_id === "script") {
        const value = artifact(revisedId, "script", input.payload);
        entries.set(revisedId, value);
        return { artifact: value, deduped: false };
      }
      throw new Error(`unexpected put ${input.schema_id}`);
    },
  } as any;

  const runLog = new MemoryRunLog();
  await runLog.record({
    run_id: "run_retry", graph_id: "illustrated_story@9", node_id: "draft_script",
    transformation: "test_revision_writer", transformation_version: "1", inputs: [storyId, growthId, intentId],
    output: priorScriptId, status: "ok", attempt: 1, max_attempts: 3, started_at: new Date(0).toISOString(), duration_ms: 1,
  });
  await runLog.record({
    run_id: "run_retry", graph_id: "illustrated_story@9", node_id: "watchability_report",
    transformation: "watchability_critic", transformation_version: "5", inputs: [storyId, priorScriptId, growthId, intentId],
    output: reportId, status: "ok", attempt: 1, max_attempts: 2, started_at: new Date(0).toISOString(), duration_ms: 1,
  });

  const provider = new FakeProvider((_req, attempt) => ({
    payload: attempt === 0 ? priorScript : revisedScript,
    confidence: { overall: 0.9 },
  }));
  const def: AgentDef = {
    name: "test_revision_writer",
    kind: "agent",
    version: "1",
    revision_input: "watchability",
    consumes: [
      { schema_id: "story", as: "story" },
      { schema_id: "growth_package", as: "growth" },
      { schema_id: "intent", as: "intent" },
    ],
    produces: "script",
    produces_version: "1.7.0",
    prompt: "test@1",
    model: { capability: "reasoning_high" },
    retry: { max_attempts: 3 },
  };

  const runner = new Runner({
    store,
    registry: {
      resolveVersion: () => "1.7.0",
      jsonSchema: () => ({ type: "object" }),
      validate: () => undefined,
    } as any,
    prompts: {
      render: (_ref: string, vars: Record<string, string>) => `revision=${vars["revision"]}\nintent=${vars["intent"]}`,
    } as any,
    providers: new ProviderRouter({ reasoning_high: provider }),
    runLog,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });

  const result = await runner.run(def, [storyId, growthId, intentId], {
    runId: "run_retry", graphId: "illustrated_story@9", nodeId: "draft_script",
  });

  assert.equal(provider.calls.length, 2, "identical revision must be retried inside the same writer execution");
  assert.equal(result.artifact.artifact_id, revisedId);
  assert.deepEqual(result.artifact.payload, revisedScript);
  assert.match(provider.calls[1]!.prompt, /canonical-identical script/i);

  const newRecords = (await runLog.all()).slice(2);
  assert.deepEqual(newRecords.map((record) => record.status), ["retry", "ok"]);
  assert.equal(newRecords[0]!.retry_reason, "other_semantic");
  assert.equal(newRecords[0]!.output, null);
  assert.equal(newRecords[1]!.output, revisedId);
});
