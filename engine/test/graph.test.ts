import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SchemaRegistry } from "../src/registry.ts";
import { loadAgentDefs } from "../src/catalog.ts";
import { allTransformations, defaultWorkers } from "../src/workers/index.ts";
import { FakePublishTarget } from "../src/providers/fake.ts";
import { loadGraph, validateGraph, descendantsOf, type GraphDoc } from "../src/graph.ts";
import { parsePredicate, evaluatePredicate, PredicateError } from "../src/predicate.ts";
import type { Artifact } from "../src/artifact.ts";
import type { TransformationDef } from "../src/runner.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
async function deps() {
  const registry = await SchemaRegistry.load(path.join(ROOT, "schemas"));
  const agents = await loadAgentDefs(path.join(ROOT, "agents")) as Map<string, TransformationDef>;
  const workers = defaultWorkers({ voice: { voiceId: "test-voice" }, publish: { target: new FakePublishTarget() } });
  return { registry, transformations: allTransformations(agents, workers) };
}
function graph(nodes: GraphDoc["nodes"]): GraphDoc { return { graph_id: "test", version: "1", nodes }; }

test("shipped illustrated_story and manual graphs are statically valid", async () => {
  const d = await deps();
  for (const name of ["illustrated_story.json", "manual.json"]) {
    const g = await loadGraph(path.join(ROOT, "graphs", name));
    assert.doesNotThrow(() => validateGraph(g, d), name);
  }
});

test("catches a mis-wired schema edge before a token is spent", async () => {
  const d = await deps();
  const bad = graph([
    { id: "story", type: "input", schema_id: "story" },
    { id: "insights", type: "input", schema_id: "channel_insights" },
    { id: "growth", transformation: "growth_packager", in: ["story", "insights"] },
  ]);
  assert.throws(() => validateGraph(bad, d), /emits "story", but "growth_packager" expects "intent"/);
});

test("catches wrong arity against the current growth contract", async () => {
  const d = await deps();
  const bad = graph([
    { id: "intent", type: "input", schema_id: "intent" },
    { id: "growth", transformation: "growth_packager", in: ["intent"] },
  ]);
  assert.throws(() => validateGraph(bad, d), /supplies 1 input\(s\) but "growth_packager" consumes 2/);
});

test("catches cycles, dangling references, and unknown transformations", async () => {
  const d = await deps();
  assert.throws(() => validateGraph(graph([
    { id: "a", type: "human_gate", in: ["b"], policy: { auto_pass_if: "always" } },
    { id: "b", type: "human_gate", in: ["a"], policy: { auto_pass_if: "always" } },
  ]), d), /cycle/);
  assert.throws(() => validateGraph(graph([{ id: "gate", type: "human_gate", in: ["nope"], policy: { auto_pass_if: "always" } }]), d), /references unknown input "nope"/);
  assert.throws(() => validateGraph(graph([{ id: "intent", type: "input", schema_id: "intent" }, { id: "x", transformation: "fact_checker", in: ["intent"] }]), d), /unknown transformation "fact_checker"/);
});

test("rejects node types RFC 0005 specifies but we have not built", async () => {
  const d = await deps();
  assert.throws(() => validateGraph({ graph_id: "t", version: "1", nodes: [{ id: "f", type: "fanout", in: [] }] } as unknown as GraphDoc, d), /fanout\/select are specified in RFC 0005 but not implemented/);
});

test("rejects an unparseable auto-pass predicate", async () => {
  const d = await deps();
  const bad = graph([{ id: "story", type: "input", schema_id: "story" }, { id: "gate", type: "human_gate", in: ["story"], policy: { auto_pass_if: "confidence.overall is basically fine" } }]);
  assert.throws(() => validateGraph(bad, d), /human_gate "gate"/);
});

test("descendantsOf finds the blocked subtree independently of transformation arity", () => {
  const g = graph([
    { id: "intent", type: "input", schema_id: "intent" },
    { id: "story", type: "human_gate", in: ["intent"], policy: { auto_pass_if: "always" } },
    { id: "script", type: "human_gate", in: ["story"], policy: { auto_pass_if: "always" } },
  ]);
  assert.deepEqual([...descendantsOf(g, new Set(["story"]))], ["script"]);
  assert.deepEqual([...descendantsOf(g, new Set(["script"]))], []);
});

const ARTIFACT = {
  artifact_id: "sha256:" + "0".repeat(64), schema_id: "story", schema_version: "1.0.0",
  produced_by: { transformation: "narrative_story_architect", version: "1", run_id: "r" }, parents: [],
  confidence: { overall: 0.93, dimensions: { novelty: 0.7 } }, created_at: "2026-08-10T00:00:00.000Z",
  labels: { variant: "a" }, payload: { acts: [1, 2, 3] },
} as unknown as Artifact;

test("predicates read artifact fields, including nested and .length", () => {
  assert.equal(evaluatePredicate("confidence.overall >= 0.9", ARTIFACT), true);
  assert.equal(evaluatePredicate("confidence.overall >= 0.95", ARTIFACT), false);
  assert.equal(evaluatePredicate("confidence.dimensions.novelty < 0.8", ARTIFACT), true);
  assert.equal(evaluatePredicate("payload.acts.length > 2", ARTIFACT), true);
  assert.equal(evaluatePredicate('labels.variant == "a"', ARTIFACT), true);
  assert.equal(evaluatePredicate('labels.variant != "a"', ARTIFACT), false);
});

test("an unresolvable predicate path is false, not a crash", () => {
  assert.equal(evaluatePredicate("confidence.nope >= 0.5", ARTIFACT), false);
});

test("predicates are not a general expression language", () => {
  assert.throws(() => parsePredicate("confidence.overall"), PredicateError);
  assert.throws(() => parsePredicate("1 + 1 == 2"), PredicateError);
  assert.throws(() => parsePredicate("process.exit(1) > 0"), PredicateError);
  assert.throws(() => evaluatePredicate('confidence.overall >= "high"', ARTIFACT), PredicateError);
});

test("unattended always predicate is accepted explicitly", async () => {
  const { evaluatePredicate: evalPred, assertValidPredicate, ALWAYS } = await import("../src/predicate.ts");
  assert.doesNotThrow(() => assertValidPredicate(ALWAYS));
  assert.equal(evalPred(ALWAYS, { schema_id: "x" } as never), true);
  assert.throws(() => assertValidPredicate("sometimes"), /must be/);
});
