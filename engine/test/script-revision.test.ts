import test from "node:test";
import assert from "node:assert/strict";
import { buildScriptRevisionContext, revisionDirectives } from "../src/script-revision.ts";

const id = (char: string) => `sha256:${char.repeat(64)}`;
const script1 = id("1"), script2 = id("2"), script3 = id("3"), report1 = id("a"), report3 = id("c");

function artifact(artifact_id: string, schema_id: string, payload: unknown, parents: string[] = []) {
  return {
    artifact_id, schema_id, schema_version: schema_id === "script" ? "1.7.0" : "2.0.0",
    produced_by: { transformation: "test", version: "1", run_id: "run_test", provider: null },
    parents, confidence: null, created_at: new Date(0).toISOString(), labels: {}, payload,
  };
}

const priorScript = {
  scenes: [
    { scene_index: 0, point: "setup", narration: "For weeks, nothing unusual happened." },
    { scene_index: 1, point: "problem", narration: "Then the warning appeared." },
    { scene_index: 2, point: "outro", narration: "Watch what happens next.", is_outro: true },
  ],
  word_count: 14,
};

const weakReport = {
  verdict: "revise",
  abandon_recommended: false,
  weakest_dimension: "watchability",
  summary: "Scenes 0-1 spend too long on neutral setup before the concrete warning changes anything.",
  scores: {
    hook: 0.84, first_30_fidelity: 0.82, package_fidelity: 0.86, suspense: 0.76,
    watchability: 0.71, entertainment: 0.73, payoff: 0.78, youtube_fit: 0.77,
  },
};

function fakeStore(entries: Map<string, any>) {
  return { get: async (artifactId: string) => entries.get(artifactId) ?? null } as any;
}

function record(node_id: string, output: string) {
  return { run_id: "run_test", node_id, output, status: "ok" } as any;
}

test("second external draft receives the exact prior script + matching critic as targeted revision context", async () => {
  const entries = new Map<string, any>([
    [script1, artifact(script1, "script", priorScript)],
    [report1, artifact(report1, "watchability_report", weakReport, [script1])],
  ]);
  const runLog = { all: async () => [record("draft_script", script1), record("watchability_report", report1)] } as any;

  const result = await buildScriptRevisionContext({ runId: "run_test", nodeId: "draft_script", runLog, store: fakeStore(entries) });
  assert.ok(result);
  assert.equal(result!.payload.attempt, 2);
  assert.equal(result!.payload.mode, "targeted_revision");
  assert.deepEqual(result!.parents, [script1, report1]);
  assert.deepEqual(result!.payload.previous_script, priorScript);
  assert.equal(result!.payload.critic.weakest_dimension, "watchability");
  assert.ok(result!.payload.release_failures.some((f) => f.startsWith("watchability=0.71")));
  assert.ok(result!.payload.directives.some((d) => /neutral connective prose|change the situation/i.test(d)));
});

test("fourth draft escalates to structural rebuild rather than paraphrasing the same local fix", async () => {
  const entries = new Map<string, any>([
    [script1, artifact(script1, "script", priorScript)],
    [script2, artifact(script2, "script", priorScript)],
    [script3, artifact(script3, "script", priorScript)],
    [report3, artifact(report3, "watchability_report", weakReport, [script3])],
  ]);
  const runLog = { all: async () => [
    record("draft_script", script1), record("draft_script", script2), record("draft_script", script3),
    record("watchability_report", report3),
  ] } as any;

  const result = await buildScriptRevisionContext({ runId: "run_test", nodeId: "draft_script", runLog, store: fakeStore(entries) });
  assert.ok(result);
  assert.equal(result!.payload.attempt, 4);
  assert.equal(result!.payload.mode, "structural_rebuild");
  assert.match(result!.payload.directives[0]!, /structural rewrite/i);
});

test("first draft has no invented feedback context", async () => {
  const result = await buildScriptRevisionContext({
    runId: "run_test", nodeId: "draft_script", runLog: { all: async () => [] } as any, store: fakeStore(new Map()),
  });
  assert.equal(result, null);
});

test("dimension directives prioritize the critic's weakest dimension and concrete loss point", () => {
  const directives = revisionDirectives(
    { suspense: 0.70, watchability: 0.72 },
    "suspense",
    "The middle repeats the same obstacle twice without changing the protagonist's options.",
    "targeted_revision",
  );
  assert.match(directives.join("\n"), /changing the protagonist's options/i);
  assert.match(directives.join("\n"), /attempted solution should create a harder problem/i);
});
